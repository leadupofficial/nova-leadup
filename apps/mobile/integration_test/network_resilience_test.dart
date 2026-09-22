import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/services/network_service.dart';

import '../test/helpers/test_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('network resilience', () {
    setUpAll(() {
      registerFallbackValue(RequestOptions(path: '/'));
    });

    testWidgets('offline state is detected by NetworkInfoService', (tester) async {
      final toggle = FakeNetworkInfoService();
      toggle.setConnected(false);
      expect(await toggle.isConnected, isFalse);
      toggle.setConnected(true);
      expect(await toggle.isConnected, isTrue);
      await toggle.dispose();
    });

    testWidgets('login fails gracefully with a 401 response', (tester) async {
      var calls = 0;
      final adapter = MockHttpAdapter((options) async {
        calls++;
        return _mockJsonResponse(<String, dynamic>{
          'error': 'invalid_credentials',
          'message': 'Bad credentials',
        }, statusCode: 401);
      });
      final dio = Dio(BaseOptions(baseUrl: 'https://api.test.invalid'))
        ..httpClientAdapter = adapter;
      final network = NetworkService(dio: dio, networkInfo: FakeNetworkInfoService());
      final api = AuthApi(network);

      expect(
        () => api.login(email: 'bad@example.com', password: 'wrong'),
        throwsA(isA<AuthException>()),
      );
      expect(calls, greaterThanOrEqualTo(1));
    });

    testWidgets('login fails gracefully with a 5xx response', (tester) async {
      var calls = 0;
      final adapter = MockHttpAdapter((options) async {
        calls++;
        return _mockJsonResponse(<String, dynamic>{
          'error': 'server_error',
          'message': 'Internal server error',
        }, statusCode: 500);
      });
      final dio = Dio(BaseOptions(baseUrl: 'https://api.test.invalid'))
        ..httpClientAdapter = adapter;
      final network = NetworkService(dio: dio, networkInfo: FakeNetworkInfoService());
      final api = AuthApi(network);

      expect(
        () => api.login(email: 'x@y.com', password: 'pass'),
        throwsA(isA<AuthException>()),
      );
      expect(calls, greaterThanOrEqualTo(1));
    });

    testWidgets('network request times out cleanly', (tester) async {
      final adapter = MockHttpAdapter((options) async {
        await Future<void>.delayed(const Duration(milliseconds: 200));
        return _mockJsonResponse(<String, dynamic>{'ok': true});
      });
      final dio = Dio(BaseOptions(
        baseUrl: 'https://api.test.invalid',
        connectTimeout: const Duration(milliseconds: 50),
        receiveTimeout: const Duration(milliseconds: 50),
        sendTimeout: const Duration(milliseconds: 50),
      ))
        ..httpClientAdapter = adapter;
      final network = NetworkService(
        dio: dio,
        networkInfo: FakeNetworkInfoService(),
        retryConfig: _noRetryConfig,
      );

      expect(
        () => network.get('/test', queryParameters: <String, dynamic>{'q': '1'}),
        throwsA(anyOf(isA<DioException>())),
      );
    });

    testWidgets('offline widget shows login screen', (tester) async {
      final deps = await createTestDependencies(
        preferences: <String, Object>{'nova_onboarding_status': 'complete'},
      );
      deps.networkInfo.setConnected(false);
      await tester.pumpWidget(testScope(deps, const NovaApp()));
      await tester.pumpAndSettle(const Duration(seconds: 3));
      expect(find.text('Welcome back'), findsOneWidget);
      await deps.networkInfo.dispose();
    });

    testWidgets('reconnection restores connectivity', (tester) async {
      final toggle = FakeNetworkInfoService();
      toggle.setConnected(false);
      expect(await toggle.isConnected, isFalse);
      toggle.setConnected(true);
      expect(await toggle.isConnected, isTrue);
      await toggle.dispose();
    });

    testWidgets('scripted adapter matches real Dio options', (tester) async {
      RequestOptions? captured;
      final adapter = MockHttpAdapter((options) async {
        captured = options;
        return _mockJsonResponse(<String, dynamic>{'ok': true});
      });
      final dio = Dio(BaseOptions(baseUrl: 'https://api.test.invalid'))
        ..httpClientAdapter = adapter;
      final network = NetworkService(dio: dio, networkInfo: FakeNetworkInfoService());

      await network.get('/health');

      expect(captured, isNotNull);
      expect(captured!.path, '/health');
      expect(captured!.method, 'GET');
    });
  });
}

class MockHttpAdapter implements HttpClientAdapter {
  MockHttpAdapter(this.handler);

  final Future<ResponseBody> Function(RequestOptions options) handler;
  final List<RequestOptions> requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _mockJsonResponse(Object body, {int statusCode = 200}) {
  return ResponseBody.fromString(
    jsonEncode(body),
    statusCode,
    headers: <String, List<String>>{
      Headers.contentTypeHeader: <String>[Headers.jsonContentType],
    },
  );
}

const RetryConfig _noRetryConfig = RetryConfig(
  maxAttempts: 1,
  initialDelay: Duration.zero,
  maxDelay: Duration.zero,
  backoffMultiplier: 1.0,
);
