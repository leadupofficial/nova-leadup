import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/api_config.dart';
import '../core/network/auth_interceptor.dart';
import '../core/network/network_info_service.dart';
import '../core/voice/wake_word_service.dart';
import '../features/auth/auth_api.dart';
import '../features/auth/auth_controller.dart';
import '../features/auth/auth_repository.dart';
import '../features/onboarding/onboarding_service.dart';
import '../services/analytics_service.dart';
import '../services/crash_reporting_service.dart';
import '../services/health_service.dart';
import '../services/network_service.dart';
import '../services/voice_stream_service.dart';

/// Infrastructure providers.
///
/// Anything that needs asynchronous setup (shared preferences, the auth repository,
/// the onboarding service) is created once during bootstrap and injected through
/// `ProviderScope.overrides`. Those providers therefore throw if they are read
/// without an override, which turns "forgot to wire it up" into an immediate,
/// obvious error instead of silent broken behaviour.

/// Overridden in `main()` with the instance awaited during bootstrap.
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) => throw UnimplementedError(
    'sharedPreferencesProvider must be overridden in ProviderScope. '
    'Bootstrap awaits SharedPreferences.getInstance() and injects it.',
  ),
);

/// Overridden in `main()` once the persisted session has been restored.
final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => throw UnimplementedError(
    'authRepositoryProvider must be overridden in ProviderScope. '
    'Bootstrap constructs AuthRepository, calls restore(), and injects it.',
  ),
);

/// Overridden in `main()` with the instance constructed from shared preferences.
final onboardingServiceProvider = Provider<OnboardingService>(
  (ref) => throw UnimplementedError(
    'onboardingServiceProvider must be overridden in ProviderScope. '
    'Bootstrap awaits SharedPreferences.getInstance() and injects it.',
  ),
);

/// Platform-backed encrypted storage for the auth session.
///
/// v11's default [AndroidOptions] already uses AES-GCM for data with RSA-OAEP key
/// wrapping, so no extra options are needed. (The former
/// `AndroidOptions(encryptedSharedPreferences: true)` flag no longer exists.)
final secureStorageProvider = Provider<FlutterSecureStorage>(
  (ref) => const FlutterSecureStorage(),
);

final networkInfoServiceProvider = Provider<NetworkInfoService>(
  (ref) => NetworkInfoServiceImpl(),
);

/// Shared Dio options for both the main and auth-only clients.
BaseOptions _baseOptions() {
  return BaseOptions(
    baseUrl: ApiConfig.baseUrl,
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 30),
    sendTimeout: const Duration(seconds: 10),
    headers: const <String, dynamic>{
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  );
}

/// Dio used **only** for the auth endpoints (login/register/refresh/logout).
///
/// Deliberately has no [AuthInterceptor]: the interceptor's refresh callback issues a
/// request on this client, and putting the interceptor here too would let a failing
/// refresh recurse into itself.
final authDioProvider = Provider<Dio>((ref) => Dio(_baseOptions()));

final authNetworkServiceProvider = Provider<NetworkService>(
  (ref) => NetworkService(
    dio: ref.watch(authDioProvider),
    networkInfo: ref.watch(networkInfoServiceProvider),
  ),
);

/// The app's main HTTP client. Attaches the access token and transparently refreshes
/// it once on a 401 (see [AuthInterceptor]).
final dioProvider = Provider<Dio>((ref) {
  final dio = Dio(_baseOptions());

  final interceptor = AuthInterceptor(
    repository: ref.watch(authRepositoryProvider),
    refreshAccessToken: (String refreshToken) async {
      // Uses the auth-only client, so this call cannot re-enter the interceptor.
      final session = await ref.read(authApiProvider).refresh(refreshToken);
      // The server rotates refresh tokens, so the whole session must be persisted.
      await ref.read(authRepositoryProvider).saveSession(
            session.token,
            user: session.user,
          );
      return session.token;
    },
    onRefreshFailed: () =>
        ref.read(authStateProvider.notifier).handleRefreshFailure(),
  );

  dio.interceptors.add(interceptor);
  interceptor.attach(dio);
  return dio;
});

final networkServiceProvider = Provider<NetworkService>(
  (ref) => NetworkService(
    dio: ref.watch(dioProvider),
    networkInfo: ref.watch(networkInfoServiceProvider),
  ),
);

final healthServiceProvider = Provider<HealthService>((ref) {
  return HealthService(
    network: ref.watch(networkServiceProvider),
  );
});

/// Dedicated Dio for health checks with a shorter 5-second timeout and a fresh
/// BaseOptions that does not inherit the main client's 30-second timeouts or
/// interceptors (auth token refresh would be pointless and risky for /healthz).
final healthDioProvider = Provider<Dio>((ref) {
  return Dio(
    BaseOptions(
      baseUrl: ApiConfig.baseUrl,
      connectTimeout: const Duration(seconds: 5),
      receiveTimeout: const Duration(seconds: 5),
      sendTimeout: const Duration(seconds: 5),
      headers: const <String, dynamic>{
        'Accept': 'application/json',
      },
    ),
  );
});

final healthNetworkServiceProvider = Provider<NetworkService>((ref) {
  return NetworkService(
    dio: ref.watch(healthDioProvider),
    networkInfo: ref.watch(networkInfoServiceProvider),
  );
});

final healthServiceWithTimeoutProvider = Provider<HealthService>((ref) {
  return HealthService(network: ref.watch(healthNetworkServiceProvider));
});

/// Authentication API. Uses [authNetworkServiceProvider] so that signing in never
/// depends on an existing (possibly expired) session.
final authApiProvider = Provider<AuthApi>(
  (ref) => AuthApi(ref.watch(authNetworkServiceProvider)),
);

final crashReportingServiceProvider = Provider<CrashReportingService>(
  (ref) => CrashReportingService(),
);

final analyticsServiceProvider = Provider<AnalyticsService>(
  (ref) => AnalyticsService.instance,
);

/// Native wake word transport.
///
/// Only Android has a native implementation today (`WakeWordService.kt`). Elsewhere
/// the app gets [UnsupportedWakeWordPlatform], which reports `unsupported_platform`
/// so the UI can explain the situation rather than offering a dead toggle. Override
/// this in tests with a fake.
final wakeWordPlatformProvider = Provider<WakeWordPlatform>((ref) {
  if (defaultTargetPlatform == TargetPlatform.android) {
    return MethodChannelWakeWordPlatform();
  }
  return const UnsupportedWakeWordPlatform();
});

/// Reconnecting WebSocket client for real-time voice streaming
/// (`/api/v1/voice/realtime`).
///
/// The access token is passed as an `Authorization` header rather than a query
/// parameter. Query-string tokens appear in server logs, proxy trails, and
/// HTTP referrer headers, so they are stripped from the URI entirely. The
/// server side (`realtime/index.ts`) reads the bearer from either the header
/// or the `token` query parameter, so removing the parameter does not break
/// any deployment.
///
/// The token is resolved through [VoiceStreamService.uriResolver] on every
/// connect attempt rather than once at construction. An access token lives 15
/// minutes, so a URI captured at construction time would make every reconnect
/// after that point fail authentication forever. Watching the auth state
/// as well means signing out disposes this service (and closes its socket)
/// instead of leaving an authenticated connection alive.
final voiceStreamServiceProvider = Provider<VoiceStreamService>((ref) {
  ref.watch(authStateProvider.select((state) => state.isAuthenticated));

  final service = VoiceStreamService(
    uriResolver: () => Uri.parse(ApiConfig.voiceWs),
    headersResolver: () {
      final token = ref.read(authRepositoryProvider).currentToken;
      if (token == null) return <String, String>{};
      return <String, String>{'Authorization': 'Bearer ${token.accessToken}'};
    },
  );
  ref.onDispose(service.close);
  return service;
});
