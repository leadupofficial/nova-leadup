import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/features/auth/auth_controller.dart';

import '../helpers/test_harness.dart';

/// Stands in for an unforeseen bug in the auth layer.
class _ExplodingAuthApi extends AuthApi {
  _ExplodingAuthApi()
      : super(fakeNetworkService(FakeHttpAdapter((_) async => jsonResponse(<String, dynamic>{}))));

  @override
  Future<AuthSession> login({required String email, required String password}) {
    throw StateError('unexpected auth-layer failure');
  }
}

void main() {
  group('login', () {
    test('stores the session and authenticates the controller', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      final adapter = FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{
          'access_token': 'access-token',
          'refresh_token': 'refresh-token',
          'expires_in': 3600,
          'user': <String, dynamic>{
            'id': 'user-1',
            'email': 'alex@example.com',
            'name': 'Alex',
          },
        }),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      expect(container.read(authStateProvider).isAuthenticated, isFalse);

      final succeeded = await container
          .read(authStateProvider.notifier)
          .login(email: 'alex@example.com', password: 'secret123');

      expect(succeeded, isTrue);
      final state = container.read(authStateProvider);
      expect(state.isAuthenticated, isTrue);
      expect(state.user?.displayName, 'Alex');
      expect(state.error, isNull);

      // The session is persisted, not just held in memory.
      expect(deps.authRepository.isLoggedIn, isTrue);
      expect(deps.authRepository.currentToken?.accessToken, 'access-token');
      expect(deps.authRepository.currentUser?.id, 'user-1');

      // Analytics picks up the signed-in user.
      expect(deps.analyticsBackend.userId, 'user-1');
      expect(deps.analyticsBackend.events, contains('login'));
    });

    test('unwraps the API {success, data} envelope', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      // The real shape returned by services/api/src/routes/auth.ts.
      final adapter = FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'access_token': 'envelope-access',
            'refresh_token': 'envelope-refresh',
            'token_type': 'Bearer',
            'expires_in': 900,
            'user': <String, dynamic>{
              'id': 'user-9',
              'email': 'envelope@example.com',
              'name': 'Envelope User',
            },
          },
        }),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      final succeeded = await container
          .read(authStateProvider.notifier)
          .login(email: 'envelope@example.com', password: 'secret123');

      expect(succeeded, isTrue);
      expect(deps.authRepository.currentToken?.accessToken, 'envelope-access');
      expect(deps.authRepository.currentToken?.refreshToken, 'envelope-refresh');
      expect(deps.authRepository.currentUser?.id, 'user-9');
      expect(container.read(authStateProvider).user?.displayName, 'Envelope User');

      // Credentials must be sent to the login endpoint as JSON.
      final body = adapter.requests.single.data as Map<String, dynamic>;
      expect(body['email'], 'envelope@example.com');
      expect(adapter.requests.single.path, endsWith('/api/v1/auth/login'));
    });

    test('reports a clear error when the server returns no token', () async {
        final deps = await createTestDependencies();
        addTearDown(deps.dispose);

        // Defensive: a malformed or non-token response must produce an actionable
        // message rather than a null-cast crash.
        final adapter = FakeHttpAdapter(
          (options) async => jsonResponse(<String, dynamic>{
            'message': 'Login endpoint',
            'email': 'alex@example.com',
          }),
        );
        final container = createTestContainer(
          deps,
          networkService: fakeNetworkService(adapter),
        );
        addTearDown(container.dispose);

        final succeeded = await container
            .read(authStateProvider.notifier)
            .login(email: 'alex@example.com', password: 'secret123');

        expect(succeeded, isFalse);
        final state = container.read(authStateProvider);
        expect(state.isAuthenticated, isFalse);
        expect(state.isSubmitting, isFalse);
        expect(state.error, contains('no access token'));
        expect(deps.authRepository.isLoggedIn, isFalse);
      },
    );

    test('surfaces a rejected-credentials error', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      final adapter = FakeHttpAdapter(
        (options) async => jsonResponse(
          <String, dynamic>{'error': 'Invalid credentials'},
          statusCode: 401,
        ),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      final succeeded = await container
          .read(authStateProvider.notifier)
          .login(email: 'alex@example.com', password: 'wrong');

      expect(succeeded, isFalse);
      final state = container.read(authStateProvider);
      expect(state.isAuthenticated, isFalse);
      expect(state.error, isNotNull);
      // The API's own problem+json message is surfaced rather than a bare status code.
      expect(state.error, contains('Invalid credentials'));
    });

    test('surfaces a transport failure without leaving the controller stuck', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      final adapter = FakeHttpAdapter(
        (options) async => throw StateError('socket exploded'),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      final succeeded = await container
          .read(authStateProvider.notifier)
          .login(email: 'alex@example.com', password: 'secret123');

      expect(succeeded, isFalse);
      final state = container.read(authStateProvider);
      expect(state.isSubmitting, isFalse);
      expect(state.error, isNotNull);
    });

    test('reports unexpected (non-auth) failures to crash reporting', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      final container = createTestContainer(
        deps,
        authApi: _ExplodingAuthApi(),
      );
      addTearDown(container.dispose);

      final succeeded = await container
          .read(authStateProvider.notifier)
          .login(email: 'alex@example.com', password: 'secret123');

      expect(succeeded, isFalse);
      expect(container.read(authStateProvider).isSubmitting, isFalse);
      // A generic failure must not leak internals to the user, but must be reported.
      expect(container.read(authStateProvider).error, 'Something went wrong. Please try again.');
      expect(deps.crashBackend.errors, hasLength(1));
      expect(deps.crashBackend.reasons.single, 'login');
    });
  });

  group('register', () {
    test('sends the name and the trimmed credentials', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      final adapter = FakeHttpAdapter(
        (options) async => jsonResponse(
          <String, dynamic>{
            'access_token': 'access-token',
            'refresh_token': 'refresh-token',
            'expires_in': 3600,
          },
          statusCode: 201,
        ),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      final succeeded = await container.read(authStateProvider.notifier).register(
            email: 'new@example.com',
            password: 'secret123',
            name: 'Sam',
          );

      expect(succeeded, isTrue);
      expect(adapter.requests, hasLength(1));
      final body = adapter.requests.single.data as Map<String, dynamic>;
      expect(body['email'], 'new@example.com');
      expect(body['password'], 'secret123');
      expect(body['name'], 'Sam');
      expect(deps.analyticsBackend.events, contains('sign_up'));
    });

    test('omits the name when it is blank', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      final adapter = FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{
          'access_token': 'a',
          'refresh_token': 'r',
          'expires_in': 60,
        }),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      await container
          .read(authStateProvider.notifier)
          .register(email: 'a@b.com', password: 'secret123');

      final body = adapter.requests.single.data as Map<String, dynamic>;
      expect(body.containsKey('name'), isFalse);
    });
  });

  group('logout', () {
    test('clears the persisted session and returns to unauthenticated', () async {
      final deps = await createTestDependencies(
        secureStorage: <String, String>{
          'auth_token':
              '{"access_token":"a","refresh_token":"r","expires_at":"2099-01-01T00:00:00.000"}',
          'auth_user': '{"id":"user-1","email":"alex@example.com","name":"Alex"}',
        },
      );
      addTearDown(deps.dispose);

      // restore() has already run inside createTestDependencies.
      expect(deps.authRepository.isLoggedIn, isTrue);

      final adapter = FakeHttpAdapter(
        (options) async => ResponseBody.fromString('', 204),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      expect(container.read(authStateProvider).isAuthenticated, isTrue);

      await container.read(authStateProvider.notifier).logout();

      final state = container.read(authStateProvider);
      expect(state.isAuthenticated, isFalse);
      expect(state.user, isNull);
      expect(deps.authRepository.isLoggedIn, isFalse);
      expect(deps.authRepository.currentUser, isNull);
      expect(deps.crashBackend.userId, isNull);
      expect(deps.analyticsBackend.events, contains('logout'));
    });

    test('logs out locally even when the server call fails', () async {
      final deps = await createTestDependencies(
        secureStorage: <String, String>{
          'auth_token':
              '{"access_token":"a","refresh_token":"r","expires_at":"2099-01-01T00:00:00.000"}',
        },
      );
      addTearDown(deps.dispose);

      final adapter = FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{}, statusCode: 500),
      );
      final container = createTestContainer(
        deps,
        networkService: fakeNetworkService(adapter),
      );
      addTearDown(container.dispose);

      await container.read(authStateProvider.notifier).logout();

      // Trapping the user in an authenticated state on a server error would be worse
      // than a best-effort logout.
      expect(container.read(authStateProvider).isAuthenticated, isFalse);
      expect(deps.authRepository.isLoggedIn, isFalse);
    });
  });
}
