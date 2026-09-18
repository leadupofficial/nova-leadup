import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:nova_mobile/services/health_service.dart';
import 'package:nova_mobile/services/network_service.dart';

class _MockNetworkService extends Mock implements NetworkService {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _MockNetworkService network;
  late HealthService health;

  setUpAll(() {
    registerFallbackValue(Options());
  });

  setUp(() {
    network = _MockNetworkService();
    health = HealthService(network: network);
  });

  Response<dynamic> createResponse(int status, [dynamic body]) {
    return Response<dynamic>(
      requestOptions: RequestOptions(path: '/healthz'),
      statusCode: status,
      data: body,
    );
  }

  group('HealthService.check', () {
    test('returns healthy=true with statusCode on 200 response', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenAnswer((_) async => createResponse(200, 'OK'));

      final result = await health.check();

      expect(result.healthy, isTrue);
      expect(result.statusCode, equals(200));
      expect(result.endpoint, equals('/healthz'));
      expect(result.error, isNull);
    });

    test('returns healthy=true for any 2xx status code', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenAnswer((_) async => createResponse(204));

      final result = await health.check();

      expect(result.healthy, isTrue);
      expect(result.statusCode, equals(204));
    });

    test('returns healthy=false on 503 with statusCode', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenAnswer((_) async => createResponse(503, 'Unavailable'));

      final result = await health.check();

      expect(result.healthy, isFalse);
      expect(result.statusCode, equals(503));
    });

    test('returns healthy=false on 500 server error', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenAnswer((_) async => createResponse(500, 'Crash'));

      final result = await health.check();

      expect(result.healthy, isFalse);
      expect(result.statusCode, equals(500));
    });

    test('returns healthy=false when NetworkException is thrown', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenThrow(
        NetworkException('Connection lost', cause: Exception('socket')),
      );

      final result = await health.check();

      expect(result.healthy, isFalse);
      expect(result.error, contains('Connection lost'));
    });

    test('returns healthy=false on DioException', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: '/healthz'),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      final result = await health.check();

      expect(result.healthy, isFalse);
      expect(result.error, contains('connectionTimeout'));
    });

    test('returns healthy=false on TimeoutException', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenThrow(TimeoutException('Health probe timed out'));

      final result = await health.check();

      expect(result.healthy, isFalse);
      expect(result.error, contains('timed out'));
    });

    test('returns healthy=false on unexpected exception type', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenThrow(StateError('Unexpected state'));

      final result = await health.check();

      expect(result.healthy, isFalse);
      expect(result.error, contains('StateError'));
    });

    test('uses custom path when provided', () async {
      when(() => network.requestOnce(
            'GET',
            '/ready',
            options: any(named: 'options'),
          )).thenAnswer((_) async => createResponse(200, 'Ready'));

      final result = await health.check(path: '/ready');

      expect(result.healthy, isTrue);
      expect(result.endpoint, equals('/ready'));
    });
  });

  group('HealthService.getStatus', () {
    test('returns "healthy" string when check is healthy', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenAnswer((_) async => createResponse(200, 'OK'));

      final status = await health.getStatus();

      expect(status, equals('healthy'));
    });

    test('returns "unhealthy" string with error when check fails', () async {
      when(() => network.requestOnce(
            'GET',
            '/healthz',
            options: any(named: 'options'),
          )).thenAnswer((_) async => createResponse(500, 'Error'));

      final status = await health.getStatus();

      expect(status, contains('unhealthy'));
      expect(status, contains('unknown'));
    });
  });
}