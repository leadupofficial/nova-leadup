// On-device end-to-end support.
//
// Every other suite in `integration_test/` injects fakes through Riverpod
// overrides, so it exercises the widget tree against a scripted world. That is
// valuable, but it cannot answer the owner's questions: does the wake word
// service actually run, does a reminder actually reach the notification shade,
// does a memory survive a round trip to Postgres.
//
// This harness deliberately does the opposite. It boots the **real** app —
// `bootstrapDependencies()`, the real Keystore-backed secure store, the real
// shared preferences, the real platform channels, the real API over
// `adb reverse`. Nothing here is overridden except the two service singletons
// that `main()` itself constructs, and those keep their production behaviour.

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/app/bootstrap.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/config/api_config.dart';
import 'package:nova_mobile/services/analytics_service.dart';
import 'package:nova_mobile/services/crash_reporting_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Fail loudly and early if the build was not pointed at the local API. A debug
/// run against the unreachable production host would turn every assertion below
/// into a network timeout, which reads like a product bug and is not one.
const String _expectedApiUrl = String.fromEnvironment('API_URL');

void assertApiConfigured() {
  if (_expectedApiUrl.isEmpty) {
    fail(
      'API_URL was not supplied. Run with '
      '--dart-define=API_URL=http://localhost:3001 and `adb reverse tcp:3001 tcp:3001`.',
    );
  }
  // ignore: avoid_print
  print('[e2e] API_URL=$_expectedApiUrl effective=${ApiConfig.baseUrl}');
}

/// A real account created against the live API.
class E2eAccount {
  E2eAccount({
    required this.email,
    required this.password,
    required this.accessToken,
    required this.refreshToken,
    required this.expiresAt,
    required this.userId,
  });

  final String email;
  final String password;
  final String accessToken;
  final String refreshToken;
  final DateTime expiresAt;
  final String userId;
}

int _counter = 0;
String _suffix() =>
    '${++_counter}-${DateTime.now().microsecondsSinceEpoch % 1000000}';

/// Talks to the real API the way a second client would, so device state can be
/// seeded and cross-checked without going through the app under test.
class E2eApi {
  E2eApi({String? baseUrl})
      : _dio = Dio(
          BaseOptions(
            baseUrl: baseUrl ?? ApiConfig.baseUrl,
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 60),
            sendTimeout: const Duration(seconds: 15),
            headers: const <String, dynamic>{
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
          ),
        );

  final Dio _dio;

  /// Registers a brand-new account. The API rate-limits auth at 10 req/min, so
  /// callers should create one account and reuse it within a file.
  Future<E2eAccount> register({String tag = 'e2e'}) async {
    final email = 'e2e-$tag-${_suffix()}@nova.test';
    final password = 'E2ePass-${_suffix()}';
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/v1/auth/register',
      data: <String, dynamic>{
        'email': email,
        'password': password,
        'name': 'E2E $tag',
      },
    );
    final body = _unwrap(response.data);
    final token = (body['token'] ?? body['tokens'] ?? body) as Map<String, dynamic>;
    final user = (body['user'] ?? const <String, dynamic>{}) as Map<String, dynamic>;
    return E2eAccount(
      email: email,
      password: password,
      accessToken: (token['accessToken'] ?? token['access_token']).toString(),
      refreshToken: (token['refreshToken'] ?? token['refresh_token']).toString(),
      expiresAt: DateTime.tryParse(
            (token['expiresAt'] ?? token['expires_at'] ?? '').toString(),
          ) ??
          DateTime.now().add(const Duration(minutes: 15)),
      userId: (user['id'] ?? '').toString(),
    );
  }

  /// Logs in an existing account. Used by the shell-driven seed, where a fixed
  /// email must survive repeated runs.
  Future<E2eAccount> login({
    required String email,
    required String password,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/v1/auth/login',
      data: <String, dynamic>{'email': email, 'password': password},
    );
    final body = _unwrap(response.data);
    final token = (body['token'] ?? body['tokens'] ?? body) as Map<String, dynamic>;
    final user = (body['user'] ?? const <String, dynamic>{}) as Map<String, dynamic>;
    return E2eAccount(
      email: email,
      password: password,
      accessToken: (token['accessToken'] ?? token['access_token']).toString(),
      refreshToken: (token['refreshToken'] ?? token['refresh_token']).toString(),
      expiresAt: DateTime.tryParse(
            (token['expiresAt'] ?? token['expires_at'] ?? '').toString(),
          ) ??
          DateTime.now().add(const Duration(minutes: 15)),
      userId: (user['id'] ?? '').toString(),
    );
  }

  Map<String, dynamic> _unwrap(Map<String, dynamic>? data) {
    if (data == null) throw StateError('empty response body');
    final inner = data['data'];
    return inner is Map<String, dynamic> ? inner : data;
  }

  Map<String, String> _auth(String token) =>
      <String, String>{'Authorization': 'Bearer $token'};

  // ── Reminders ─────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> createReminder(
    String token, {
    required String title,
    required DateTime triggerAt,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/v1/reminders',
      data: <String, dynamic>{
        'title': title,
        'triggerAt': triggerAt.toUtc().toIso8601String(),
      },
      options: Options(headers: _auth(token)),
    );
    return _unwrap(response.data);
  }

  Future<List<Map<String, dynamic>>> listReminders(String token) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/v1/reminders',
      options: Options(headers: _auth(token)),
    );
    final body = _unwrap(response.data);
    final list = body['reminders'] ?? body['data'] ?? body;
    return (list as List<dynamic>).cast<Map<String, dynamic>>();
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /// The account's own tasks, through its own token.
  ///
  /// Read with the device's credential rather than an operator's, so a task appearing here proves it
  /// belongs to *this* account. That distinction matters for the conversational test: the assertion
  /// is not "somewhere a task exists" but "the tool call this conversation made created one for the
  /// user who asked".
  Future<List<Map<String, dynamic>>> listTasks(String token) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/v1/tasks',
      options: Options(headers: _auth(token)),
    );
    final body = _unwrap(response.data);
    final list = body['tasks'] ?? body['data'] ?? body;
    return (list as List<dynamic>).cast<Map<String, dynamic>>();
  }

  // ── Memories ──────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> createMemory(
    String token, {
    required String content,
    String category = 'fact',
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/v1/memories',
      // `sourceType` is REQUIRED by CreateMemorySchema (it has no zod `.default()`),
      // alongside `category`. Omitting it produces a bare `"Required"` with no field
      // named, so the shape here must match what the app itself sends.
      data: <String, dynamic>{
        'content': content,
        'category': category,
        'sourceType': 'manual',
      },
      options: Options(headers: _auth(token)),
    );
    return _unwrap(response.data);
  }

  Future<List<Map<String, dynamic>>> listMemories(String token) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/v1/memories',
      options: Options(headers: _auth(token)),
    );
    final body = _unwrap(response.data);
    final list = body['memories'] ?? body['data'] ?? body;
    return (list as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> searchMemories(
    String token,
    String query,
  ) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/v1/memories/search',
      // `MemorySearchSchema` names this field `query`, not `q` — sending `q` is
      // answered with a bare `400 "Required"`.
      queryParameters: <String, dynamic>{'query': query},
      options: Options(headers: _auth(token)),
    );
    return _unwrap(response.data);
  }

  void close() => _dio.close(force: true);
}

/// Writes a real session into the device's real secure store and marks
/// onboarding complete in real shared preferences, so the app under test starts
/// where the assertions need it to.
Future<void> seedSession(
  E2eAccount account, {
  bool onboardingComplete = true,
}) async {
  const storage = FlutterSecureStorage();
  await storage.write(
    key: 'auth_token',
    value: jsonEncode(<String, dynamic>{
      'access_token': account.accessToken,
      'refresh_token': account.refreshToken,
      'expires_at': account.expiresAt.toIso8601String(),
    }),
  );
  await storage.write(
    key: 'auth_user',
    value: jsonEncode(<String, dynamic>{
      'id': account.userId,
      'email': account.email,
      'name': 'E2E User',
    }),
  );

  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(
    'nova_onboarding_status',
    onboardingComplete ? 'complete' : 'incomplete',
  );
}

/// Removes every trace of a previous run, so a cold start is genuinely cold.
Future<void> wipeDeviceState() async {
  const storage = FlutterSecureStorage();
  await storage.deleteAll();
  final prefs = await SharedPreferences.getInstance();
  await prefs.clear();
}

/// Boots the real application exactly as `main()` does.
///
/// Returns the bootstrap dependencies so a test can inspect the same stores the
/// app is using. The two service singletons are constructed here rather than
/// reached through their global, because their backends (Firebase) are absent
/// from a test build; both keep their console/no-op production behaviour.
Future<BootstrapDependencies> launchRealApp(WidgetTester tester) async {
  final dependencies = await bootstrapDependencies();

  final crashReporting = CrashReportingService();
  await crashReporting.initialize(enabled: false);

  final analytics = AnalyticsService.instance;
  await analytics.initialize(enabled: false);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(dependencies.preferences),
        secureStorageProvider.overrideWithValue(dependencies.secureStorage),
        authRepositoryProvider.overrideWithValue(dependencies.authRepository),
        onboardingServiceProvider.overrideWithValue(dependencies.onboardingService),
        networkInfoServiceProvider
            .overrideWithValue(dependencies.networkInfoService),
        crashReportingServiceProvider.overrideWithValue(crashReporting),
        analyticsServiceProvider.overrideWithValue(analytics),
      ],
      child: const NovaApp(),
    ),
  );

  // The first frame runs the router's redirects, which await the auth state.
  await pumpFor(tester, const Duration(seconds: 2));
  return dependencies;
}

/// Pumps real frames for [duration].
///
/// `pumpAndSettle` is unusable in this app: the avatar and the voice waveform
/// animate forever, so it never returns. Every wait in this suite is therefore
/// an explicit pump loop.
Future<void> pumpFor(WidgetTester tester, Duration duration) async {
  final deadline = DateTime.now().add(duration);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Pumps until [finder] matches, or fails with [reason] after [timeout].
///
/// Returns as soon as the condition is true, so the common case is fast.
Future<void> waitFor(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 30),
  String? reason,
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      // Let the frame that produced the match finish painting.
      await tester.pump(const Duration(milliseconds: 100));
      return;
    }
  }
  fail(
    reason ??
        'Timed out after ${timeout.inSeconds}s waiting for: $finder',
  );
}

/// Pumps until [condition] is true, for checks that are not widget finders
/// (a platform channel answer, a file on disk, a server round trip).
Future<void> waitUntil(
  WidgetTester tester,
  Future<bool> Function() condition, {
  Duration timeout = const Duration(seconds: 30),
  String? reason,
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (await condition()) return;
    await tester.pump(const Duration(milliseconds: 200));
  }
  fail(reason ?? 'Timed out after ${timeout.inSeconds}s waiting for condition');
}

/// Every string currently rendered, so a test can assert on content it cannot
/// address with a stable key.
List<String> visibleText(WidgetTester tester) {
  return tester
      .widgetList<Text>(find.byType(Text))
      .map((Text widget) => widget.data ?? widget.textSpan?.toPlainText() ?? '')
      .where((String value) => value.trim().isNotEmpty)
      .toList();
}

/// Result of one HTTP probe, for tests that assert on the API directly.
class ProbeResult {
  ProbeResult(this.statusCode, this.body, this.elapsed);

  final int statusCode;
  final Object? body;
  final Duration elapsed;

  bool get ok => statusCode >= 200 && statusCode < 300;

  @override
  String toString() => 'HTTP $statusCode in ${elapsed.inMilliseconds}ms';
}

/// A separate Dio client, for latency and stress probes that must not share a
/// connection pool with the app under test.
Dio probeClient() => Dio(
      BaseOptions(
        baseUrl: ApiConfig.baseUrl,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 120),
        sendTimeout: const Duration(seconds: 15),
        headers: const <String, dynamic>{
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      ),
    );

/// Times a single request, swallowing transport errors into the result so a
/// stress sweep can report a failure rate instead of aborting on the first one.
Future<ProbeResult> timedProbe(
  Dio dio,
  String path, {
  String? token,
  String method = 'GET',
  Object? data,
}) async {
  final stopwatch = Stopwatch()..start();
  try {
    final response = await dio.request<Object?>(
      path,
      data: data,
      options: Options(
        method: method,
        headers: token == null
            ? null
            : <String, String>{'Authorization': 'Bearer $token'},
        // A non-2xx must come back as a value, not an exception, so the sweep
        // can measure 500s instead of dying on the first one.
        validateStatus: (int? _) => true,
      ),
    );
    stopwatch.stop();
    return ProbeResult(response.statusCode ?? 0, response.data, stopwatch.elapsed);
  } catch (error) {
    stopwatch.stop();
    return ProbeResult(0, error.toString(), stopwatch.elapsed);
  }
}

/// Nearest-rank percentile over a list of durations, in milliseconds.
int percentileMs(List<Duration> samples, double percentile) {
  if (samples.isEmpty) return 0;
  final sorted = <int>[
    for (final Duration sample in samples) sample.inMilliseconds,
  ]..sort();
  final rank = ((percentile / 100) * sorted.length).ceil().clamp(1, sorted.length);
  return sorted[rank - 1];
}

String describeLatency(List<Duration> samples) {
  if (samples.isEmpty) return 'no samples';
  final total = samples.fold<int>(0, (int sum, Duration d) => sum + d.inMilliseconds);
  return 'n=${samples.length} '
      'min=${samples.map((Duration d) => d.inMilliseconds).reduce((a, b) => a < b ? a : b)}ms '
      'p50=${percentileMs(samples, 50)}ms '
      'p95=${percentileMs(samples, 95)}ms '
      'p99=${percentileMs(samples, 99)}ms '
      'max=${samples.map((Duration d) => d.inMilliseconds).reduce((a, b) => a > b ? a : b)}ms '
      'mean=${(total / samples.length).toStringAsFixed(0)}ms';
}
