import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/network/network_info_service.dart';
import 'package:nova_mobile/core/theme/nova_theme.dart';
import 'package:nova_mobile/core/voice/wake_word_service.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';
import 'package:nova_mobile/features/onboarding/onboarding_service.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/services/analytics_service.dart';
import 'package:nova_mobile/services/crash_reporting_service.dart';
import 'package:nova_mobile/services/health_service.dart';
import 'package:nova_mobile/services/network_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_reminder_notifications.dart';

/// In-memory stand-in for the platform secure store.
class FakeSecureStorage extends Fake implements FlutterSecureStorage {
  FakeSecureStorage([Map<String, String>? seed]) : _store = {...?seed};

  final Map<String, String> _store;

  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _store.remove(key);
    } else {
      _store[key] = value;
    }
  }

  @override
  Future<String?> read({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      _store[key];

  @override
  Future<void> delete({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _store.remove(key);
  }

  @override
  Future<bool> containsKey({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      _store.containsKey(key);
}

/// Connectivity stub. Defaults to online so retry paths are not accidentally exercised.
class FakeNetworkInfoService implements NetworkInfoService {
  FakeNetworkInfoService({this.connected = true});

  bool connected;
  final StreamController<bool> _controller = StreamController<bool>.broadcast();

  @override
  Future<bool> get isConnected async => connected;

  @override
  Stream<bool> get onConnectivityChanged => _controller.stream;

  void setConnected(bool value) {
    connected = value;
    _controller.add(value);
  }

  Future<void> dispose() => _controller.close();
}

/// Scriptable wake word transport.
class FakeWakeWordPlatform implements WakeWordPlatform {
  FakeWakeWordPlatform({
    this.availabilityResult = const WakeWordAvailability(
      available: true,
      reason: 'ok',
      models: <String>['hey_jarvis'],
      selected: 'hey_jarvis',
    ),
  });

  WakeWordAvailability availabilityResult;

  int startCalls = 0;
  int stopCalls = 0;
  bool running = false;

  /// Names passed to [selectModel], in order, including the refusals.
  final List<String> selectModelCalls = <String>[];

  final StreamController<WakeWordEvent> _controller =
      StreamController<WakeWordEvent>.broadcast();

  @override
  Future<WakeWordAvailability> availability() async => availabilityResult;

  @override
  Future<bool> start() async {
    startCalls++;
    running = true;
    _controller.add(
      WakeWordListening(models: availabilityResult.models),
    );
    return true;
  }

  @override
  Future<bool> stop() async {
    stopCalls++;
    running = false;
    _controller.add(const WakeWordStopped());
    return true;
  }

  @override
  Future<bool> isRunning() async => running;

  /// Accepts only the classifiers this fake reports as installed, mirroring the
  /// native service's `unknown_model` refusal for a phrase with no asset.
  @override
  Future<bool> selectModel(String name) async {
    selectModelCalls.add(name);
    if (!availabilityResult.models.contains(name)) return false;
    availabilityResult = WakeWordAvailability(
      available: availabilityResult.available,
      reason: availabilityResult.reason,
      detail: availabilityResult.detail,
      models: availabilityResult.models,
      selected: name,
    );
    return true;
  }

  @override
  Stream<WakeWordEvent> get events => _controller.stream;

  /// Pushes an event as if it came from the native service.
  void emit(WakeWordEvent event) => _controller.add(event);

  Future<void> dispose() => _controller.close();
}

/// Health service that never touches the network, so widget tests stay hermetic.
class FakeHealthService extends HealthService {
  FakeHealthService({
    this.result = const HealthCheckResult(
      healthy: true,
      statusCode: 200,
      endpoint: '/healthz',
    ),
  }) : super(
          network: NetworkService(
            dio: Dio(),
            networkInfo: FakeNetworkInfoService(),
          ),
        );

  HealthCheckResult result;

  @override
  Future<HealthCheckResult> check({String path = '/healthz'}) async => result;

  @override
  Future<String> getStatus({String path = '/healthz'}) async =>
      result.healthy ? 'healthy' : 'unhealthy: ${result.error ?? "unknown"}';
}

/// Records analytics calls instead of printing them.
class RecordingAnalyticsBackend implements AnalyticsBackend {
  final List<String> events = <String>[];
  final Map<String, Map<String, Object?>?> parameters = <String, Map<String, Object?>?>{};
  String? userId;
  bool? collectionEnabled;

  @override
  Future<void> initialize() async {}

  @override
  Future<void> setCollectionEnabled(bool enabled) async => collectionEnabled = enabled;

  @override
  Future<void> setUserId(String? id) async => userId = id;

  @override
  Future<void> setUserProperty(String name, String? value) async {}

  @override
  Future<void> logEvent(String name, {Map<String, Object?>? parameters}) async {
    events.add(name);
    this.parameters[name] = parameters;
  }
}

/// Records crash reports instead of printing them.
class RecordingCrashBackend implements CrashReporterBackend {  final List<Object> errors = <Object>[];
  final List<String?> reasons = <String?>[];
  final List<bool> fatals = <bool>[];
  final List<String> breadcrumbs = <String>[];
  String? userId;

  @override
  Future<void> initialize() async {}

  @override
  Future<void> setCollectionEnabled(bool enabled) async {}

  @override
  Future<void> setUserId(String? id) async => userId = id;

  @override
  Future<void> setCustomKey(String key, Object value) async {}

  @override
  Future<void> log(String message) async => breadcrumbs.add(message);

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stackTrace, {
    String? reason,
    bool fatal = false,
  }) async {
    errors.add(error);
    reasons.add(reason);
    fatals.add(fatal);
  }
}

/// SharedPreferences with mock values already installed.
Future<SharedPreferences> mockPreferences([
  Map<String, Object> values = const <String, Object>{},
]) async {
  SharedPreferences.setMockInitialValues(values);
  return SharedPreferences.getInstance();
}

/// Dependencies used to build a test widget tree.
class TestDependencies {
  TestDependencies({
    required this.preferences,
    required this.authRepository,
    required this.onboardingService,
    required this.wakeWordPlatform,
    required this.crashReporting,
    required this.crashBackend,
    required this.analytics,
    required this.analyticsBackend,
    required this.networkInfo,
    required this.healthService,
    required this.reminderNotifications,
  });

  final SharedPreferences preferences;
  final AuthRepository authRepository;
  final OnboardingService onboardingService;
  final FakeWakeWordPlatform wakeWordPlatform;
  final CrashReportingService crashReporting;
  final RecordingCrashBackend crashBackend;
  final AnalyticsService analytics;
  final RecordingAnalyticsBackend analyticsBackend;
  final FakeNetworkInfoService networkInfo;
  final FakeHealthService healthService;
  final FakeReminderNotifications reminderNotifications;

  Future<void> dispose() async {
    await wakeWordPlatform.dispose();
    await networkInfo.dispose();
    reminderNotifications.cancelAll();
  }
}

/// Creates the fakes and the initialized services that back a test widget tree.
Future<TestDependencies> createTestDependencies({
  Map<String, Object> preferences = const <String, Object>{},
  Map<String, String> secureStorage = const <String, String>{},
  WakeWordAvailability wakeWordAvailability = const WakeWordAvailability(
    available: true,
    reason: 'ok',
    models: <String>['hey_jarvis'],
    // The native service always reports the effective classifier once a model is
    // installed, falling back to the first one. Fakes mirror that so the UI sees
    // the same shape on a test device as on a phone.
    selected: 'hey_jarvis',
  ),
  FakeHealthService? healthService,
}) async {
  final prefs = await mockPreferences(preferences);
  final authRepository = AuthRepository(FakeSecureStorage(secureStorage));
  await authRepository.restore();

  final crashBackend = RecordingCrashBackend();
  final crashReporting = CrashReportingService.forTesting(backend: crashBackend);
  await crashReporting.initialize(enabled: true);

  final analyticsBackend = RecordingAnalyticsBackend();
  final analytics = AnalyticsService(backend: analyticsBackend);
  await analytics.initialize(enabled: true);

  return TestDependencies(
    preferences: prefs,
    authRepository: authRepository,
    onboardingService: OnboardingService(prefs),
    wakeWordPlatform: FakeWakeWordPlatform(availabilityResult: wakeWordAvailability),
    crashReporting: crashReporting,
    crashBackend: crashBackend,
    analytics: analytics,
    analyticsBackend: analyticsBackend,
    networkInfo: FakeNetworkInfoService(),
    healthService: healthService ?? FakeHealthService(),
    reminderNotifications: FakeReminderNotifications(),
  );
}

/// Wraps [home] in a ProviderScope with every async dependency overridden.
///
/// Passing this through a helper keeps the override list literal inside a scope where
/// Dart can infer the element type: Riverpod does not export `Override`.
Widget testApp(TestDependencies deps, Widget home) {
  return ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(deps.preferences),
      authRepositoryProvider.overrideWithValue(deps.authRepository),
      onboardingServiceProvider.overrideWithValue(deps.onboardingService),
      wakeWordPlatformProvider.overrideWithValue(deps.wakeWordPlatform),
      crashReportingServiceProvider.overrideWithValue(deps.crashReporting),
      analyticsServiceProvider.overrideWithValue(deps.analytics),
      networkInfoServiceProvider.overrideWithValue(deps.networkInfo),
      healthServiceProvider.overrideWithValue(deps.healthService),
      reminderNotificationsProvider.overrideWithValue(deps.reminderNotifications),
    ],
    child: MaterialApp(
      theme: NovaTheme.darkTheme,
      home: home,
    ),
  );
}

/// Wraps an arbitrary widget (e.g. a router-driven `MaterialApp`) in the overrides.
Widget testScope(
  TestDependencies deps,
  Widget child, {
  NetworkService? networkService,
}) {
  return ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(deps.preferences),
      authRepositoryProvider.overrideWithValue(deps.authRepository),
      onboardingServiceProvider.overrideWithValue(deps.onboardingService),
      wakeWordPlatformProvider.overrideWithValue(deps.wakeWordPlatform),
      crashReportingServiceProvider.overrideWithValue(deps.crashReporting),
      analyticsServiceProvider.overrideWithValue(deps.analytics),
      networkInfoServiceProvider.overrideWithValue(deps.networkInfo),
      healthServiceProvider.overrideWithValue(deps.healthService),
      reminderNotificationsProvider.overrideWithValue(deps.reminderNotifications),
      // The dashboard and the feature screens fetch over this provider. Without
      // an override they escape to the real network and the widget test hangs.
      if (networkService != null)
        networkServiceProvider.overrideWithValue(networkService),
      if (networkService != null)
        authNetworkServiceProvider.overrideWithValue(networkService),
    ],
    // The design's avatar and waveform loops repeat forever, so `pumpAndSettle`
    // would never return. Every animated widget honours the OS "Reduce Motion"
    // setting (blueprint §6.5), so disabling it here also exercises that path.
    child: MediaQuery(
      data: const MediaQueryData(disableAnimations: true),
      child: child,
    ),
  );
}

/// Answers any request with an empty `{success, data}` envelope of the right
/// shape, so list screens settle into their designed empty states.
NetworkService emptyApiNetworkService() {
  return fakeNetworkService(
    FakeHttpAdapter((options) async {
      final path = options.path;
      if (path.contains('/tasks')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'tasks': <dynamic>[]},
        });
      }
      if (path.contains('/memories')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'memories': <dynamic>[]},
        });
      }
      if (path.contains('/reminders')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <dynamic>[],
        });
      }
      if (path.contains('/conversations')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'conversations': <dynamic>[]},
        });
      }
      if (path.contains('/settings/profile')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'id': 'user-1',
            'email': 'alex@example.com',
            'name': 'Alex',
          },
        });
      }
      if (path.contains('/device/wake-word/config')) {
        // The §13.10 record when the account has never saved one. Deliberately
        // `wakeWord: null` — the server does not know which classifiers the
        // device has, so it must not answer with a phrase.
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'wakeWord': null,
            'available': <dynamic>[],
            'updatedAt': null,
            'enforcedOnDevice': true,
            'control': 'preference_record',
            'note': 'The device enforces the wake word.',
          },
        });
      }
      return jsonResponse(<String, dynamic>{'success': true, 'data': null});
    }),
  );
}

/// Dio adapter that answers from a script instead of the network.
class FakeHttpAdapter implements HttpClientAdapter {
  FakeHttpAdapter(this.handler);

  final Future<ResponseBody> Function(RequestOptions options) handler;

  final List<RequestOptions> requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

/// Builds a JSON [ResponseBody] for [FakeHttpAdapter].
ResponseBody jsonResponse(Object body, {int statusCode = 200}) {
  return ResponseBody.fromString(
    jsonEncode(body),
    statusCode,
    headers: <String, List<String>>{
      Headers.contentTypeHeader: <String>[Headers.jsonContentType],
    },
  );
}

/// A [NetworkService] wired to [adapter] rather than a real socket.
NetworkService fakeNetworkService(
  HttpClientAdapter adapter, {
  FakeNetworkInfoService? networkInfo,
}) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.test.invalid'))
    ..httpClientAdapter = adapter;
  return NetworkService(
    dio: dio,
    networkInfo: networkInfo ?? FakeNetworkInfoService(),
  );
}

/// A [ProviderContainer] with the app's async dependencies overridden.
ProviderContainer createTestContainer(
  TestDependencies deps, {
  NetworkService? networkService,
  AuthApi? authApi,
}) {
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(deps.preferences),
      authRepositoryProvider.overrideWithValue(deps.authRepository),
      onboardingServiceProvider.overrideWithValue(deps.onboardingService),
      wakeWordPlatformProvider.overrideWithValue(deps.wakeWordPlatform),
      crashReportingServiceProvider.overrideWithValue(deps.crashReporting),
      analyticsServiceProvider.overrideWithValue(deps.analytics),
      networkInfoServiceProvider.overrideWithValue(deps.networkInfo),
      healthServiceProvider.overrideWithValue(deps.healthService),
      reminderNotificationsProvider.overrideWithValue(deps.reminderNotifications),
      if (networkService != null)
        networkServiceProvider.overrideWithValue(networkService),
      // AuthApi is built on the auth-only Dio (so that refreshing a token cannot
      // recurse), so the fake must be wired into that provider as well — otherwise
      // auth calls in tests escape to the real network and time out.
      if (networkService != null)
        authNetworkServiceProvider.overrideWithValue(networkService),
      if (authApi != null) authApiProvider.overrideWithValue(authApi),
    ],
  );
}

/// Uses a tall surface so long forms do not overflow during widget tests.
void useTallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}
