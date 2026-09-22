import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:dio/dio.dart';
import 'package:nova_mobile/services/network_service.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';

import '../test/helpers/test_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('settings flow', () {
    var api = _buildLiveAuthApi();
    var repository = _buildLiveAuthRepository();

    tearDown(() async {
      await repository.clearTokens();
    });

    testWidgets('profile display name is visible on home', (tester) async {
      final email = _uniqueEmail('profile');
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
                'name': 'Nova User',
              }),
            },
          ),
          const NovaApp(),
        ),
      );
      await tester.pumpAndSettle(const Duration(seconds: 3));

      expect(find.text('Nova User'), findsWidgets);
    });

    testWidgets('onboarding shows welcome screen without completed status', (tester) async {
      await tester.pumpWidget(
        testApp(
          await createTestDependencies(
            preferences: <String, Object>{'nova_onboarding_status': 'incomplete'},
          ),
          const NovaApp(),
        ),
      );
      await tester.pumpAndSettle(const Duration(seconds: 3));

      expect(find.text('Welcome'), findsOneWidget);
    });

    testWidgets('home screen is reachable with stored session', (tester) async {
      final email = _uniqueEmail('settings');
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

    testWidgets('saved preferences persist across app restarts', (tester) async {
      final email = _uniqueEmail('prefs');
      final password = _uniquePassword();
      final session = await api.register(email: email, password: password);
      await repository.saveSession(session.token, user: session.user);

      final sessionStorage = <String, String>{
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
      };

      var deps = await createTestDependencies(
        preferences: <String, Object>{'nova_onboarding_status': 'complete', 'nova_language': 'es'},
        secureStorage: sessionStorage,
      );

      await tester.pumpWidget(testApp(deps, const NovaApp()));
      await tester.pumpAndSettle(const Duration(seconds: 3));

      deps = await createTestDependencies(
        preferences: <String, Object>{'nova_onboarding_status': 'complete', 'nova_language': 'es'},
        secureStorage: sessionStorage,
      );

      await tester.pumpWidget(testApp(deps, const NovaApp()));
      await tester.pumpAndSettle(const Duration(seconds: 3));

      expect(find.text('Wake word'), findsOneWidget);
    });

    testWidgets('repository clears tokens on clearSession', (tester) async {
      final email = _uniqueEmail('clear');
      final password = _uniquePassword();
      final session = await api.register(email: email, password: password);
      await repository.saveSession(session.token, user: session.user);

      expect(await repository.getTokens(), isNotNull);
      await repository.clearSession();
      expect(await repository.getTokens(), isNull);
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
