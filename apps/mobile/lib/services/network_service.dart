import 'dart:async';
import 'dart:math';
import 'package:dio/dio.dart';
import '../core/network/network_info_service.dart';

/// Configuration for network retry with exponential backoff and jitter.
class RetryConfig {
  final int maxAttempts;
  final Duration initialDelay;
  final Duration maxDelay;
  final double backoffMultiplier;
  final double jitter;

  const RetryConfig({
    this.maxAttempts = 3,
    this.initialDelay = const Duration(milliseconds: 500),
    this.maxDelay = const Duration(seconds: 30),
    this.backoffMultiplier = 2.0,
    this.jitter = 0.1,
  });

  Duration computeDelay(int attempt) {
    if (attempt <= 0) return initialDelay;
    final exponentialMs = initialDelay.inMilliseconds * pow(backoffMultiplier, attempt);
    final jitterDelta = (Random().nextDouble() * 2 - 1) * jitter * exponentialMs;
    final totalMs = (exponentialMs + jitterDelta).round();
    final clampedMs = min(totalMs, maxDelay.inMilliseconds);
    return Duration(milliseconds: max(clampedMs, 0));
  }
}

/// Base network exception class.
class NetworkException implements Exception {
  final String message;
  final int? statusCode;
  final dynamic cause;

  NetworkException(this.message, {this.statusCode, this.cause});

  @override
  String toString() => 'NetworkException(statusCode: $statusCode, message: $message, cause: $cause)';
}

/// Exception thrown when a network request times out.
class NetworkTimeoutException extends NetworkException {
  final Duration timeout;

  NetworkTimeoutException({
    required this.timeout,
    String message = 'Request timed out',
    int? statusCode,
    dynamic cause,
  }) : super(message, statusCode: statusCode, cause: cause);
}

/// Exception thrown when there is no internet connection or socket error.
class NetworkConnectionException extends NetworkException {
  NetworkConnectionException(super.message, {super.cause, super.statusCode});
}

/// Exception thrown when the server returns a 5xx error.
class NetworkServerException extends NetworkException {
  NetworkServerException(super.message, {required super.statusCode, super.cause});
}

/// Exception thrown when authentication fails (401/403).
class NetworkAuthException extends NetworkException {
  NetworkAuthException(super.message, {super.statusCode = 401, super.cause});
}

/// Exception thrown on client-side HTTP errors (4xx other than auth).
class NetworkClientException extends NetworkException {
  NetworkClientException(super.message, {required super.statusCode, super.cause});
}

/// Core network service with visible timeout configuration, exponential backoff,
/// circuit-breaker offline protection, and typed error differentiation.
class NetworkService {
  final Dio _dio;
  final NetworkInfoService _networkInfo;
  final RetryConfig _retryConfig;

  final Duration _connectTimeout;
  final Duration _receiveTimeout;
  final Duration _sendTimeout;

  Duration get connectTimeout => _connectTimeout;
  Duration get receiveTimeout => _receiveTimeout;
  Duration get sendTimeout => _sendTimeout;

  NetworkService({
    required this._dio,
    required this._networkInfo,
    this._retryConfig = const RetryConfig(),
    this._connectTimeout = const Duration(seconds: 10),
    this._receiveTimeout = const Duration(seconds: 30),
    this._sendTimeout = const Duration(seconds: 10),
  }) {
    _dio.options.connectTimeout = _connectTimeout;
    _dio.options.receiveTimeout = _receiveTimeout;
    _dio.options.sendTimeout = _sendTimeout;
  }

  Future<Response<T>> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) {
    return _executeWithRetry(
      () => _dio.get<T>(
        path,
        queryParameters: queryParameters,
        options: options,
        cancelToken: cancelToken,
      ),
      idempotent: true,
    );
  }

  Future<Response<T>> post<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) {
    return _executeWithRetry(
      () => _dio.post<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: options,
        cancelToken: cancelToken,
      ),
    );
  }

  Future<Response<T>> put<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) {
    return _executeWithRetry(
      () => _dio.put<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: options,
        cancelToken: cancelToken,
      ),
      idempotent: true,
    );
  }

  Future<Response<T>> patch<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) {
    return _executeWithRetry(
      () => _dio.patch<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: options,
        cancelToken: cancelToken,
      ),
    );
  }

  Future<Response<T>> delete<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) {
    return _executeWithRetry(
      () => _dio.delete<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: options,
        cancelToken: cancelToken,
      ),
      idempotent: true,
    );
  }

  Future<Response<T>> requestOnce<T>(
    String method,
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) async {
    final isConnected = await _networkInfo.isConnected;
    if (!isConnected) {
      throw NetworkConnectionException('No network connection available');
    }

    final opts = options ?? Options();
    opts.method = method;

    try {
      return await _dio.request<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: opts,
        cancelToken: cancelToken,
      );
    } catch (e) {
      rethrow;
    }
  }

  /// Runs [requestFn], retrying only when the HTTP method makes a repeat safe.
  ///
  /// `POST` and `PATCH` are not idempotent: a request that timed out may still have
  /// been applied, so retrying can create a second task, reminder, memory or feature
  /// flag. Retries are therefore limited to `GET`, `PUT` and `DELETE` (and to the
  /// offline wait below, which happens *before* anything is sent on any method).
  Future<Response<T>> _executeWithRetry<T>(
    Future<Response<T>> Function() requestFn, {
    bool idempotent = false,
  }) async {
    int attempts = 0;

    while (true) {
      final isConnected = await _networkInfo.isConnected;
      if (!isConnected) {
        attempts++;
        if (attempts >= _retryConfig.maxAttempts) {
          throw NetworkConnectionException('Device is offline');
        }
        final delay = _retryConfig.computeDelay(attempts - 1);
        await Future.delayed(delay);
        continue;
      }

      try {
        attempts++;
        return await requestFn();
      } catch (error) {
        final mapped = _mapError(error);

        if (_shouldRetry(error, attempts, idempotent)) {
          final delay = _retryConfig.computeDelay(attempts - 1);
          await Future.delayed(delay);
          continue;
        }

        throw mapped;
      }
    }
  }

  bool _shouldRetry(dynamic error, int attempts, bool idempotent) {
    if (attempts >= _retryConfig.maxAttempts) return false;

    // A repeated non-idempotent write can duplicate the effect of one that already
    // succeeded before its response was lost.
    if (!idempotent) return false;

    if (error is DioException) {
      if (error.type == DioExceptionType.cancel) return false;

      if (error.type == DioExceptionType.connectionTimeout ||
          error.type == DioExceptionType.sendTimeout ||
          error.type == DioExceptionType.receiveTimeout ||
          error.type == DioExceptionType.connectionError) {
        return true;
      }

      final status = error.response?.statusCode;
      if (status != null && status >= 500) {
        return true;
      }
    }

    return false;
  }

  NetworkException _mapError(dynamic error) {
    if (error is NetworkException) return error;

    if (error is DioException) {
      if (error.type == DioExceptionType.cancel) {
        return NetworkException('Request was cancelled', cause: error);
      }

      if (error.type == DioExceptionType.connectionTimeout) {
        return NetworkTimeoutException(
          timeout: _connectTimeout,
          message: 'Connection timed out: ${error.message}',
          cause: error,
        );
      }
      if (error.type == DioExceptionType.sendTimeout) {
        return NetworkTimeoutException(
          timeout: _sendTimeout,
          message: 'Send timed out: ${error.message}',
          cause: error,
        );
      }
      if (error.type == DioExceptionType.receiveTimeout) {
        return NetworkTimeoutException(
          timeout: _receiveTimeout,
          message: 'Receive timed out: ${error.message}',
          cause: error,
        );
      }

      if (error.type == DioExceptionType.connectionError) {
        return NetworkConnectionException(
          'Network connection error: ${error.message}',
          cause: error.error ?? error,
        );
      }

      final status = error.response?.statusCode;
      if (status != null) {
        // Prefer the server's own explanation. The API answers errors as RFC 7807
        // problem+json (`{ type, title, detail, status }`), so `detail` is the
        // actionable part — e.g. "Invalid email or password" instead of a bare
        // "Authentication failed (401)".
        final serverMessage = _serverMessage(error);

        if (status == 401 || status == 403) {
          return NetworkAuthException(
            serverMessage ?? 'Authentication failed ($status)',
            statusCode: status,
            cause: error,
          );
        }
        if (status >= 500) {
          return NetworkServerException(
            serverMessage ?? 'Server error ($status): ${error.message}',
            statusCode: status,
            cause: error,
          );
        }
        return NetworkClientException(
          serverMessage ?? 'Client error ($status): ${error.message}',
          statusCode: status,
          cause: error,
        );
      }

      return NetworkException(error.message ?? 'Unknown network error', cause: error);
    }

    return NetworkException(error.toString(), cause: error);
  }

  /// Extracts a human-readable message from an error response body.
  ///
  /// Handles the API's problem+json shape (`detail`/`title`) as well as the
  /// `{ success, error }` and `{ message }` shapes used elsewhere.
  String? _serverMessage(DioException error) {
    final data = error.response?.data;

    if (data is Map) {
      final map = Map<String, dynamic>.from(data);
      for (final key in const ['detail', 'title', 'message', 'error']) {
        final value = map[key];
        if (value is String && value.trim().isNotEmpty) {
          final trimmed = value.trim();
          // Ignore the generic fallbacks the API emits for 5xx responses; they carry
          // no more information than the status code itself.
          if (trimmed == 'Request failed' || trimmed == 'Internal Server Error') continue;
          return trimmed;
        }
      }
      return null;
    }

    if (data is String && data.trim().isNotEmpty && data.length < 500) {
      return data.trim();
    }

    return null;
  }
}
