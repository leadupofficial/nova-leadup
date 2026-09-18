@TestOn('vm')
library;

import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/config/api_config.dart';
import 'package:nova_mobile/core/network/auth_interceptor.dart';
import 'package:nova_mobile/core/network/network_info_service.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';
import 'package:nova_mobile/services/network_service.dart';

import '../helpers/test_harness.dart';

/// Contract test: the **real** Dart auth client against a **real** running API.
///
/// This is the check that matters for "can the mobile app log in?" — it exercises the
/// actual request/response shapes, the `{success, data}` envelope, and the transparent
/// refresh-and-replay path, none of which a fake adapter can prove.
///
/// Skipped by default. Run it against a local API:
///
/// ```bash
/// # 1. start Postgres + apply the canonical schema
/// bash packages/database/scripts/start-pgvector.sh
/// DATABASE_URL=postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova pnpm --filter @nova/database migrate
/// # 2. start the API (see services/api/.env for JWT_SECRET etc.)
/// # 3. run this test
/// cd apps/mobile
/// NOVA_LIVE_API=1 flutter test --dart-define=API_URL=http://127.0.0.1:3001 \
///   test/integration/auth_live_test.dart
/// ```
class _AlwaysOnline implements NetworkInfoService {
  @override
  Future<bool> get isConnected async => true;

  @override
  Stream<bool> get onConnectivityChanged => const Stream<bool>.empty();
}

BaseOptions _options() => BaseOptions(
      baseUrl: ApiConfig.baseUrl,
      connectTimeout: const Duration(seconds: 5),
      receiveTimeout: const Duration(seconds: 15),
      headers: const <String, dynamic>{
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    );

void main() {
  final live = Platform.environment['NOVA_LIVE_API'] == '1';

  group(
    'live auth contract',
    skip: live ? null : 'set NOVA_LIVE_API=1 (and --dart-define=API_URL) to run',
    () {
      late AuthRepository repository;
      late AuthApi authApi;
      late NetworkService mainNetwork;

      setUp(() {
        repository = AuthRepository(FakeSecureStorage());

        // Auth calls go through their own client, exactly as the app wires it.
        final authDio = Dio(_options());
        authApi = AuthApi(
          NetworkService(dio: authDio, networkInfo: _AlwaysOnline()),
        );

        // The app's main client carries the refresh interceptor.
        final mainDio = Dio(_options());
        final interceptor = AuthInterceptor(
          repository: repository,
          refreshAccessToken: (String refreshToken) async {
            final session = await authApi.refresh(refreshToken);
            await repository.saveSession(session.token, user: session.user);
            return session.token;
          },
        );
        mainDio.interceptors.add(interceptor);
        interceptor.attach(mainDio);
        mainNetwork = NetworkService(dio: mainDio, networkInfo: _AlwaysOnline());
      });

      test('register -> /me -> transparent refresh -> /me, all against the live API', () async {
        final email =
            'dart-live-${DateTime.now().microsecondsSinceEpoch}@test.example.com';

        // 1. Register through the real client and parse the real envelope.
        final session = await authApi.register(
          email: email,
          password: 'live-contract-pw-123',
          name: 'Live Contract',
        );
        expect(session.token.accessToken, isNotEmpty);
        expect(session.token.refreshToken, isNotEmpty);
        expect(session.user?.email, email);

        await repository.saveSession(session.token, user: session.user);

        // 2. Authenticated request through the interceptor.
        final me1 = await mainNetwork.get<Map<String, dynamic>>('/api/v1/auth/me');
        expect(me1.statusCode, 200);
        final user = (me1.data!['data'] as Map)['user'] as Map;
        expect(user['email'], email);

        // 3. Force an expiry by corrupting the access token; the interceptor must
        //    refresh it and replay the request without the caller knowing.
        await repository.saveTokens(
          AuthToken(
            accessToken: 'deliberately-invalid-jwt',
            refreshToken: session.token.refreshToken,
            expiresAt: DateTime.now().add(const Duration(minutes: 1)),
          ),
        );

        final me2 = await mainNetwork.get<Map<String, dynamic>>('/api/v1/auth/me');
        expect(
          me2.statusCode,
          200,
          reason: 'the interceptor should have refreshed the token and replayed /me',
        );
        expect(
          repository.currentToken?.accessToken,
          isNot('deliberately-invalid-jwt'),
          reason: 'the refreshed access token must be persisted',
        );
        // The server rotates refresh tokens, so the stored one must have changed too.
        expect(repository.currentToken?.refreshToken, isNot(session.token.refreshToken));

        // 4. Logging in again with the same credentials must also work.
        final again = await authApi.login(email: email, password: 'live-contract-pw-123');
        expect(again.token.accessToken, isNotEmpty);
      });

      test('wrong password is rejected with the server\'s own message', () async {
        final email =
            'dart-live-bad-${DateTime.now().microsecondsSinceEpoch}@test.example.com';
        await authApi.register(
          email: email,
          password: 'live-contract-pw-123',
          name: 'Bad Password',
        );

        await expectLater(
          authApi.login(email: email, password: 'definitely-wrong'),
          throwsA(
            isA<AuthException>()
                .having((e) => e.statusCode, 'statusCode', 401)
                .having((e) => e.message, 'message', 'Invalid email or password'),
          ),
        );
      });
    },
  );
}
