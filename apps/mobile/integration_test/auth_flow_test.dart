import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';
import 'package:nova_mobile/services/network_service.dart';

import '../test/helpers/test_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('auth flow', () {
    var api = _buildLiveAuthApi();
    var repository = _buildLiveAuthRepository();

    tearDown(() async {
      await repository.clearTokens();
    });

    testWidgets('register creates a new user', (tester) async {
      final email = _uniqueEmail('register');
      final password = _uniquePassword();

      final session = await api.register(email: email, password: password);
      expect(session.token.accessToken, isNotEmpty);
      expect(session.token.refreshToken, isNotEmpty);
      expect(session.user, isNotNull);
    });

    testWidgets('login returns tokens for valid credentials', (tester) async {
      final email = _uniqueEmail('login');
      final password = _uniquePassword();
      await api.register(email: email, password: password);

      final session = await api.login(email: email, password: password);
      expect(session.token.accessToken, isNotEmpty);
      expect(session.token.refreshToken, isNotEmpty);
    });

    testWidgets('login rejects invalid password', (tester) async {
      final email = _uniqueEmail('badpw');
      final password = _uniquePassword();
      await api.register(email: email, password: password);

      expect(
        () => api.login(email: email, password: 'WrongPassword!'),
        throwsA(isA<AuthException>()),
      );
    });

    testWidgets('refresh extends a valid session', (tester) async {
      final email = _uniqueEmail('refresh');
      final password = _uniquePassword();
      final session = await api.register(email: email, password: password);

      final refreshed = await api.refresh(session.token.refreshToken);
      expect(refreshed.token.accessToken, isNotEmpty);
      expect(refreshed.token.refreshToken, isNotEmpty);
    });

    testWidgets('logout revokes the session', (tester) async {
      final email = _uniqueEmail('logout');
      final password = _uniquePassword();
      final session = await api.register(email: email, password: password);

      await api.logout(session.token.accessToken, refreshToken: session.token.refreshToken);
      expect(
        () => api.refresh(session.token.refreshToken),
        throwsA(isA<AuthException>()),
      );
    });

    testWidgets('repository persists a session across restarts', (tester) async {
      final token = AuthToken(
        accessToken: 'test-access-${_uniqueSuffix()}',
        refreshToken: 'test-refresh-${_uniqueSuffix()}',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );

      await repository.saveSession(
        token,
        user: const AuthUser(id: '1', email: 'test@test.com', name: 'Test'),
      );
      final restored = await repository.getTokens();
      expect(restored, isNotNull);
      expect(restored!.accessToken, token.accessToken);
      expect(restored.refreshToken, token.refreshToken);

      await repository.clearTokens();
      expect(await repository.getTokens(), isNull);
    });

    testWidgets('the app boots into home with a stored session', (tester) async {
      final email = _uniqueEmail('boot');
      final password = _uniquePassword();
      final session = await api.register(email: email, password: password);
      await repository.saveSession(session.token, user: session.user);

      await tester.pumpWidget(
        testApp(
          await createTestDependencies(
            preferences: <String, Object>{'nova_onboarding_status': 'complete'},
            secureStorage: <String, String>{
              'auth_token': jsonEncode(<String, dynamic>{
                'access_token': session.token.accessToken,
                'refresh_token': session.token.refreshToken,
                'expires_at': session.token.expiresAt.toIso8601String(),
              }),
              'auth_user': jsonEncode(<String, dynamic>{
                'id': 'user-1',
                'email': email,
                'name': 'Alex',
              }),
            },
          ),
          const NovaApp(),
        ),
      );
      await tester.pumpAndSettle(const Duration(seconds: 3));

      expect(find.text('Wake word'), findsOneWidget);
    });

    testWidgets('no session routes to login screen', (tester) async {
      await tester.pumpWidget(
        testApp(
          await createTestDependencies(
            preferences: <String, Object>{'nova_onboarding_status': 'complete'},
          ),
          const NovaApp(),
        ),
      );
      await tester.pumpAndSettle(const Duration(seconds: 3));

      expect(find.text('Welcome back'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
    });
  });
}

AuthApi _buildLiveAuthApi() {
  final dio = Dio(BaseOptions(
    baseUrl: const String.fromEnvironment('API_URL', defaultValue: 'https://nova.leadup.in'),
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 30),
    sendTimeout: const Duration(seconds: 10),
    headers: const <String, dynamic>{'Accept': 'application/json', 'Content-Type': 'application/json'},
  ));
  return AuthApi(NetworkService(dio: dio, networkInfo: FakeNetworkInfoService()));
}

AuthRepository _buildLiveAuthRepository() => AuthRepository(FakeSecureStorage());

int _counter = 0;
String _uniqueSuffix() => '${++_counter}-${DateTime.now().microsecondsSinceEpoch % 100000}';
String _uniqueEmail(String tag) => 'test-$tag-${_uniqueSuffix()}@nova.test';
String _uniquePassword() => 'TestPass-${_uniqueSuffix()}';
