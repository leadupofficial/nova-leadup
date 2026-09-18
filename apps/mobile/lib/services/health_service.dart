import 'dart:async';
import 'package:dio/dio.dart';
import 'network_service.dart';

class HealthCheckResult {
  final bool healthy;
  final int? statusCode;
  final String endpoint;
  final String? error;

  const HealthCheckResult({
    required this.healthy,
    this.statusCode,
    required this.endpoint,
    this.error,
  });
}

class HealthService {
  final NetworkService network;

  HealthService({required this.network});

  Future<HealthCheckResult> check({String path = '/healthz'}) async {
    try {
      final response = await network.requestOnce('GET', path);
      final statusCode = response.statusCode;
      final isHealthy = statusCode != null && statusCode >= 200 && statusCode < 300;

      return HealthCheckResult(
        healthy: isHealthy,
        statusCode: statusCode,
        endpoint: path,
        error: isHealthy ? null : 'Server returned status $statusCode (unknown)',
      );
    } on NetworkException catch (e) {
      return HealthCheckResult(
        healthy: false,
        statusCode: e.statusCode,
        endpoint: path,
        error: e.message,
      );
    } on DioException catch (e) {
      return HealthCheckResult(
        healthy: false,
        statusCode: e.response?.statusCode,
        endpoint: path,
        error: e.type.toString(),
      );
    } catch (e) {
      return HealthCheckResult(
        healthy: false,
        endpoint: path,
        error: '${e.runtimeType}: $e',
      );
    }
  }

  Future<String> getStatus({String path = '/healthz'}) async {
    final result = await check(path: path);
    if (result.healthy) {
      return 'healthy';
    }
    return 'unhealthy: ${result.error ?? "unknown"}';
  }
}
