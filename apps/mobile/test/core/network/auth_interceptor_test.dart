import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/network/auth_interceptor.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';

import '../../helpers/test_harness.dart';

/// The API issues 15-minute access tokens, so the interceptor is what keeps a signed-in
/// user signed in. These tests pin that behaviour.
void main() {
  late FakeSecureStorage storage;
  late AuthRepository repository;

  AuthToken token({String access = 'old-access', String refresh = 'refresh-token'}) {
    return AuthToken(
      accessToken: access,
      refreshToken: refresh,
      expiresAt: DateTime.now().add(const Duration(hours: 1)),
    );
  }

  Future<void> seed({String access = 'old-access', String refresh = 'refresh-token'}) async {
    storage = FakeSecureStorage();
    repository = AuthRepository(storage);
    await repository.saveTokens(token(access: access, refresh: refresh));
  }

  /// Builds a Dio wired to a scripted adapter, with the interceptor attached.
  ({Dio dio, AuthInterceptor interceptor}) buildDio({
    required Future<ResponseBody> Function(RequestOptions options) handler,
    RefreshAccessToken? refresh,
    Future<void> Function()? onRefreshFailed,
  }) {
    final dio = Dio(BaseOptions(baseUrl: 'https://api.test.invalid'));
    dio.httpClientAdapter = FakeHttpAdapter(handler);

    final interceptor = AuthInterceptor(
      repository: repository,
      refreshAccessToken: refresh ?? (_) async => null,
      onRefreshFailed: onRefreshFailed,
    );
    dio.interceptors.add(interceptor);
    interceptor.attach(dio);
    return (dio: dio, interceptor: interceptor);
  }

  test('attaches the stored access token to outgoing requests', () async {
    await seed();
    RequestOptions? seen;

    final built = buildDio(handler: (options) async {
      seen = options;
      return jsonResponse(<String, dynamic>{'ok': true});
    });

    await built.dio.get<dynamic>('/api/v1/tasks');

    expect(seen?.headers['Authorization'], 'Bearer old-access');
  });

  test('refreshes once on 401 and replays the request with the new token', () async {
    await seed();
    var calls = 0;
    var refreshCalls = 0;
    final refreshedTokens = <String>[];

    final built = buildDio(
      handler: (options) async {
        calls++;
        if (options.headers['Authorization'] == 'Bearer new-access') {
          return jsonResponse(<String, dynamic>{'success': true, 'data': <dynamic>[]});
        }
        return jsonResponse(<String, dynamic>{'detail': 'Token expired'}, statusCode: 401);
      },
      refresh: (refreshToken) async {
        refreshCalls++;
        refreshedTokens.add(refreshToken);
        final fresh = token(access: 'new-access', refresh: 'rotated-refresh');
        await repository.saveTokens(fresh);
        return fresh;
      },
    );

    final response = await built.dio.get<dynamic>('/api/v1/tasks');

    expect(response.statusCode, 200);
    expect(refreshCalls, 1);
    expect(refreshedTokens, <String>['refresh-token']);
    // Original request + one replay.
    expect(calls, 2);
    // The rotated refresh token is persisted, so the next refresh still works.
    expect(repository.currentToken?.refreshToken, 'rotated-refresh');
  });

  test('shares a single refresh across concurrent 401s', () async {
    await seed();
    var refreshCalls = 0;

    final built = buildDio(
      handler: (options) async {
        if (options.headers['Authorization'] == 'Bearer new-access') {
          return jsonResponse(<String, dynamic>{'ok': true});
        }
        return jsonResponse(<String, dynamic>{'detail': 'expired'}, statusCode: 401);
      },
      refresh: (_) async {
        refreshCalls++;
        // A slow refresh widens the window in which other requests can pile up.
        await Future<void>.delayed(const Duration(milliseconds: 30));
        final fresh = token(access: 'new-access');
        await repository.saveTokens(fresh);
        return fresh;
      },
    );

    final responses = await Future.wait(<Future<Response<dynamic>>>[
      built.dio.get<dynamic>('/a'),
      built.dio.get<dynamic>('/b'),
      built.dio.get<dynamic>('/c'),
    ]);

    expect(responses.every((r) => r.statusCode == 200), isTrue);
    // The server rotates refresh tokens, so more than one refresh would invalidate
    // its own siblings.
    expect(refreshCalls, 1);
  });

  test('surfaces the original 401 and notifies when the refresh fails', () async {
    await seed();
    var failures = 0;

    final built = buildDio(
      handler: (options) async =>
          jsonResponse(<String, dynamic>{'detail': 'expired'}, statusCode: 401),
      refresh: (_) async => null,
      onRefreshFailed: () async => failures++,
    );

    await expectLater(
      built.dio.get<dynamic>('/api/v1/tasks'),
      throwsA(isA<DioException>()),
    );
    expect(failures, 1);
  });

  test('does not attempt a refresh for a failed login', () async {
    await seed();
    var refreshCalls = 0;

    final built = buildDio(
      handler: (options) async => jsonResponse(
        <String, dynamic>{'detail': 'Invalid email or password'},
        statusCode: 401,
      ),
      refresh: (_) async {
        refreshCalls++;
        return null;
      },
    );

    await expectLater(
      built.dio.post<dynamic>('/api/v1/auth/login'),
      throwsA(isA<DioException>()),
    );
    // A 401 from /auth/login means bad credentials, not an expired token.
    expect(refreshCalls, 0);
  });

  test('never retries a request more than once', () async {
    await seed();
    var refreshCalls = 0;
    var calls = 0;

    final built = buildDio(
      handler: (options) async {
        calls++;
        // Always 401: the replay itself fails, and the interceptor must stop there.
        return jsonResponse(<String, dynamic>{'detail': 'expired'}, statusCode: 401);
      },
      refresh: (_) async {
        refreshCalls++;
        final fresh = token(access: 'new-access');
        await repository.saveTokens(fresh);
        return fresh;
      },
    );

    await expectLater(
      built.dio.get<dynamic>('/api/v1/tasks'),
      throwsA(isA<DioException>()),
    );
    expect(refreshCalls, 1);
    expect(calls, 2);
  });
}
