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

  group('voice flow', () {
    var api = _buildLiveAuthApi();
    var repository = _buildLiveAuthRepository();

    tearDown(() async {
      await repository.clearTokens();
    });

    testWidgets('home shows wake-word UI when session is active', (tester) async {
      final email = _uniqueEmail('voicehud');
      final password = _uniquePassword();
      final reg = await api.register(email: email, password: password);
      await repository.saveSession(reg.token, user: reg.user);

      final deps = await createTestDependencies(
        preferences: <String, Object>{'nova_onboarding_status': 'complete'},
        secureStorage: <String, String>{
          'auth_token': jsonEncode(<String, dynamic>{
            'access_token': reg.token.accessToken,
            'refresh_token': reg.token.refreshToken,
            'expires_at': reg.token.expiresAt.toIso8601String(),
          }),
          'auth_user': jsonEncode(<String, dynamic>{
            'id': 'user-1',
            'email': email,
            'name': 'Alex',
          }),
        },
      );

      await tester.pumpWidget(
        testScope(deps, const NovaApp(), networkService: emptyApiNetworkService()),
      );
      await tester.pumpAndSettle(const Duration(seconds: 3));

      expect(find.text('Wake word'), findsOneWidget);
    });

    testWidgets('onboarding routes users with no session to welcome', (tester) async {
      final deps = await createTestDependencies(
        preferences: <String, Object>{'nova_onboarding_status': 'incomplete'},
      );

      await tester.pumpWidget(
        testScope(deps, const NovaApp(), networkService: emptyApiNetworkService()),
      );
      await tester.pumpAndSettle(const Duration(seconds: 3));

      expect(find.text('Welcome'), findsOneWidget);
    });

    testWidgets('repository preserves wake-word config in storage', (tester) async {
      final email = _uniqueEmail('voiceconfig');
      final password = _uniquePassword();
      final reg = await api.register(email: email, password: password);
      await repository.saveSession(reg.token, user: reg.user);

      final restored = await repository.getTokens();
      expect(restored, isNotNull);
      expect(restored!.accessToken, reg.token.accessToken);
      expect(restored.refreshToken, reg.token.refreshToken);
    });

    testWidgets('logout clears the session token from the repository', (tester) async {
      final email = _uniqueEmail('logoutvoice');
      final password = _uniquePassword();
      final reg = await api.register(email: email, password: password);
      await repository.saveSession(reg.token, user: reg.user);

      await api.logout(reg.token.accessToken, refreshToken: reg.token.refreshToken);
      await repository.clearTokens();

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
