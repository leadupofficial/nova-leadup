import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:nova_mobile/core/network/network_info_service.dart';
import 'package:nova_mobile/services/network_service.dart';

class MockDio extends Mock implements Dio {}

class MockNetworkInfo extends Mock implements NetworkInfoService {}

void main() {
  setUpAll(() {
    registerFallbackValue(CancelToken());
    registerFallbackValue(RequestOptions(path: '/'));
    registerFallbackValue(Options());
  });

  late MockDio dio;
  late MockNetworkInfo info;

  RequestOptions buildOpts({String method = 'GET', String path = '/test'}) =>
      RequestOptions(
        data: null,
        headers: {},
        method: method,
        path: path,
        queryParameters: {},
        responseType: ResponseType.json,
        sendTimeout: const Duration(seconds: 10),
        receiveTimeout: const Duration(seconds: 30),
        connectTimeout: const Duration(seconds: 10),
        baseUrl: 'https://api.example.com',
      );

  setUp(() {
    dio = MockDio();
    info = MockNetworkInfo();
    when(() => info.isConnected).thenAnswer((_) async => true);
    when(() => dio.options).thenReturn(
      BaseOptions(
        baseUrl: 'https://api.example.com',
        sendTimeout: const Duration(seconds: 10),
        receiveTimeout: const Duration(seconds: 30),
        connectTimeout: const Duration(seconds: 10),
      ),
    );
    when(() => dio.interceptors).thenReturn(Interceptors());
  });

  group('RetryConfig', () {
    test('has reasonable defaults', () {
      const config = RetryConfig();
      expect(config.maxAttempts, greaterThan(0));
      expect(config.maxAttempts, lessThanOrEqualTo(5));
      expect(config.initialDelay, greaterThan(Duration.zero));
    });

    test('computes increasing backoff delays with jitter bounded by maxDelay',
        () {
      const config = RetryConfig();
      final d0 = config.computeDelay(0);
      final d1 = config.computeDelay(1);
      expect(d1, greaterThanOrEqualTo(d0));
      expect(d1.inMilliseconds, lessThan(60000));
    });
  });

  group('Exception types', () {
    test('NetworkException carries message and optional statusCode', () {
      final ex = NetworkException('boom', statusCode: 500);
      expect(ex.message, 'boom');
      expect(ex.statusCode, 500);
    });

    test('NetworkTimeoutException includes timeout duration', () {
      final ex = NetworkTimeoutException(
        timeout: const Duration(seconds: 10),
        message: 'timed out',
      );
      expect(ex.timeout, const Duration(seconds: 10));
    });

    test('NetworkConnectionException carries cause', () {
      final ex = NetworkConnectionException('no connection', cause: 'socket');
      expect(ex.message, 'no connection');
      expect(ex.cause, 'socket');
    });

    test('NetworkServerException carries statusCode', () {
      final ex = NetworkServerException('server error', statusCode: 502);
      expect(ex.statusCode, 502);
    });
  });

  group('NetworkService construction', () {
    test('instantiates with default config', () {
      final service = NetworkService(dio: dio, networkInfo: info);
      expect(service, isNotNull);
    });

    test('default timeouts are applied to Dio options', () {
      final service = NetworkService(dio: dio, networkInfo: info);
      expect(service.connectTimeout, const Duration(seconds: 10));
      expect(service.receiveTimeout, const Duration(seconds: 30));
      expect(service.sendTimeout, const Duration(seconds: 10));
    });

    test('custom timeouts override defaults', () {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        connectTimeout: const Duration(seconds: 5),
        receiveTimeout: const Duration(seconds: 15),
        sendTimeout: const Duration(seconds: 3),
      );
      expect(service.connectTimeout, const Duration(seconds: 5));
      expect(service.receiveTimeout, const Duration(seconds: 15));
      expect(service.sendTimeout, const Duration(seconds: 3));
    });
  });

  group('NetworkService - Request Timeout Handling', () {
    test('retries on receiveTimeout then succeeds', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      final timeoutError = DioException(
        requestOptions: opts,
        type: DioExceptionType.receiveTimeout,
      );

      var calls = 0;
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async {
        calls++;
        if (calls <= 2) throw timeoutError;
        return Response(requestOptions: opts, statusCode: 200, data: {'ok': true});
      });

      final result = await service.get('test');
      expect(result.statusCode, 200);
      expect(calls, 3);
    });

    test('retries on connectionTimeout then succeeds', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      final timeoutError = DioException(
        requestOptions: opts,
        type: DioExceptionType.connectionTimeout,
      );

      var calls = 0;
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw timeoutError;
        return Response(requestOptions: opts, statusCode: 200);
      });

      final result = await service.get('test');
      expect(result.statusCode, 200);
      expect(calls, 2);
    });

    test('throws NetworkException after exhausting retries on timeout', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 2,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenThrow(DioException(
        requestOptions: opts,
        type: DioExceptionType.receiveTimeout,
      ));

      expect(
        () => service.get('test'),
        throwsA(isA<NetworkException>()),
      );
    });

    test('a sendTimeout on POST is NOT retried, because a repeat can duplicate the write',
        () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts(method: 'POST', path: '/upload');
      when(() => dio.post(
            any(),
            data: any(named: 'data'),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenThrow(DioException(
        requestOptions: opts,
        type: DioExceptionType.sendTimeout,
      ));

      await expectLater(
        () => service.post('/upload', data: {}),
        throwsA(isA<NetworkException>()),
      );

      // One attempt only: the request may already have been applied server-side.
      verify(() => dio.post(
            any(),
            data: any(named: 'data'),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).called(1);
    });

    test('a 500 on GET IS retried up to the configured attempts', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      var calls = 0;
      final opts = buildOpts(method: 'GET', path: '/users');
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async {
        calls++;
        throw DioException(
          requestOptions: opts,
          type: DioExceptionType.badResponse,
          response: Response(requestOptions: opts, statusCode: 500),
        );
      });

      await expectLater(
        () => service.get('/users'),
        throwsA(isA<NetworkException>()),
      );
      expect(calls, 3);
    });
  });

  group('NetworkService - Request Cancellation', () {
    test('cancelled request throws NetworkException', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenThrow(DioException(
        requestOptions: opts,
        type: DioExceptionType.cancel,
      ));

      expect(
        () => service.get('test'),
        throwsA(isA<NetworkException>()),
      );
    });

    test('cancelled request carries "Request was cancelled" message', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenThrow(DioException(
        requestOptions: opts,
        type: DioExceptionType.cancel,
      ));

      try {
        await service.get('test');
        fail('expected throw');
      } on NetworkException catch (e) {
        expect(e.message, contains('cancelled'));
      }
    });
  });

  group('NetworkService - Retry After Network Recovery', () {
    test('blocks request when offline', () async {
      when(() => info.isConnected).thenAnswer((_) async => false);

      final service = NetworkService(dio: dio, networkInfo: info);

      expect(
        () => service.get('test'),
        throwsA(isA<NetworkConnectionException>()),
      );
    });

    test('recovers and succeeds when offline status flips online between retries',
        () async {
      var connectivityCalls = 0;
      when(() => info.isConnected).thenAnswer((_) async {
        connectivityCalls++;
        // First probe (pre-check): offline. Subsequent probes: online.
        return connectivityCalls > 1;
      });

      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      // Server responds OK on the second attempt: connection error first,
      // then 200 — this exercises the retry-then-success path with the
      // connectivity gate flipping between attempts.
      var serverCalls = 0;
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async {
        serverCalls++;
        if (serverCalls == 1) {
          throw DioException(
            requestOptions: opts,
            type: DioExceptionType.connectionError,
            error: const SocketException('offline'),
          );
        }
        return Response(
          requestOptions: opts,
          statusCode: 200,
          data: {'ok': true},
        );
      });

      final result = await service.get('test');
      expect(result.statusCode, 200);
      expect(serverCalls, 2);
      expect(connectivityCalls, greaterThanOrEqualTo(2));
    });

    test('retries server 503 errors then recovers', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      final serverError = DioException(
        requestOptions: opts,
        type: DioExceptionType.badResponse,
        response: Response(requestOptions: opts, statusCode: 503),
      );

      var calls = 0;
      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async {
        calls++;
        if (calls <= 2) throw serverError;
        return Response(requestOptions: opts, statusCode: 200, data: {'ok': true});
      });

      final result = await service.get('test');
      expect(result.statusCode, 200);
      expect(calls, 3);
    });

    test('does not retry client 4xx errors', () async {
      final service = NetworkService(
        dio: dio,
        networkInfo: info,
        retryConfig: const RetryConfig(
          maxAttempts: 3,
          initialDelay: Duration(milliseconds: 1),
        ),
      );

      final opts = buildOpts();
      final clientError = DioException(
        requestOptions: opts,
        type: DioExceptionType.badResponse,
        response: Response(requestOptions: opts, statusCode: 404),
      );

      when(() => dio.get(
            any(),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenThrow(clientError);

      expect(
        () => service.get('test'),
        throwsA(isA<NetworkException>()),
      );
    });
  });

  group('NetworkService - HTTP verbs', () {
    final opts = buildOpts();

    test('POST forwards data and returns response', () async {
      when(() => dio.post(
            any(),
            data: any(named: 'data'),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async => Response(
            requestOptions: opts,
            statusCode: 201,
            data: {'created': true},
          ));

      final service = NetworkService(dio: dio, networkInfo: info);
      final result = await service.post('/items', data: {'name': 'foo'});
      expect(result.statusCode, 201);
      expect(result.data, {'created': true});
    });

    test('PUT, PATCH, DELETE all proxy through retry wrapper', () async {
      when(() => dio.put(
            any(),
            data: any(named: 'data'),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async => Response(
            requestOptions: opts,
            statusCode: 200,
          ));
      when(() => dio.patch(
            any(),
            data: any(named: 'data'),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async => Response(
            requestOptions: opts,
            statusCode: 200,
          ));
      when(() => dio.delete(
            any(),
            data: any(named: 'data'),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenAnswer((_) async => Response(
            requestOptions: opts,
            statusCode: 204,
          ));

      final service = NetworkService(dio: dio, networkInfo: info);
      expect((await service.put('/items/1', data: {})).statusCode, 200);
      expect((await service.patch('/items/1', data: {})).statusCode, 200);
      expect((await service.delete('/items/1')).statusCode, 204);
    });
  });

  group('NetworkService - requestOnce (no-retry path)', () {
    test('blocks when offline', () async {
      when(() => info.isConnected).thenAnswer((_) async => false);
      final service = NetworkService(dio: dio, networkInfo: info);

      expect(
        () => service.requestOnce('GET', '/health'),
        throwsA(isA<NetworkConnectionException>()),
      );
    });

    test('passes through to dio.request without retrying', () async {
      final service = NetworkService(dio: dio, networkInfo: info);
      final opts = buildOpts();

      when(() => dio.request(
            any(),
            data: any(named: 'data'),
            queryParameters: any(named: 'queryParameters'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
          )).thenThrow(DioException(
        requestOptions: opts,
        type: DioExceptionType.receiveTimeout,
      ));

      expect(
        () => service.requestOnce('GET', '/health'),
        throwsA(isA<DioException>()),
      );
    });
  });
}
