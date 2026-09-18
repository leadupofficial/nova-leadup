import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../features/auth/auth_repository.dart';

/// Mints a fresh access token from a refresh token, or returns null on failure.
typedef RefreshAccessToken = Future<AuthToken?> Function(String refreshToken);

/// Attaches the stored access token to outgoing requests and transparently refreshes
/// it once when the server answers `401`.
///
/// **Why this is necessary.** The API issues 15-minute access tokens
/// (`services/api/.env` sets `JWT_EXPIRES_IN=15m`) alongside a 7-day refresh token.
/// Without this interceptor, every user would be silently signed out mid-session 15
/// minutes after logging in, because nothing ever exchanged the refresh token.
///
/// **Concurrency.** All requests that hit a `401` at the same moment share a single
/// refresh. This matters because the server *rotates* refresh tokens: two concurrent
/// refreshes would invalidate each other and one caller would be logged out.
///
/// The refresh call itself must be issued on a Dio instance without this interceptor,
/// otherwise a failing refresh would recurse.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required this.repository,
    required this.refreshAccessToken,
    this.onRefreshFailed,
    this.refreshExcludedPaths = const <String>[
      '/auth/login',
      '/auth/register',
      '/auth/refresh',
    ],
  });

  final AuthRepository repository;
  final RefreshAccessToken refreshAccessToken;

  /// Invoked once when a refresh attempt fails, so the app can drop to signed-out.
  final Future<void> Function()? onRefreshFailed;

  /// Endpoints where a 401 means "bad credentials", not "expired token".
  final List<String> refreshExcludedPaths;

  Dio? _dio;
  Future<AuthToken?>? _inFlight;

  /// Gives the interceptor a handle for replaying the original request.
  void attach(Dio dio) => _dio = dio;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (!options.headers.containsKey('Authorization')) {
      final token = repository.currentToken;
      if (token != null) {
        options.headers['Authorization'] = token.bearerHeader;
      }
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    if (!_shouldAttemptRefresh(err)) {
      return handler.next(err);
    }

    final newToken = await _refreshOnce();
    if (newToken == null) {
      return handler.next(err);
    }

    final dio = _dio;
    if (dio == null) {
      return handler.next(err);
    }

    // Replay the original request exactly once with the new credentials.
    final options = err.requestOptions;
    options.headers['Authorization'] = newToken.bearerHeader;
    options.extra['nova_auth_retried'] = true;

    try {
      final response = await dio.fetch<dynamic>(options);
      handler.resolve(response);
    } on DioException catch (retryError) {
      handler.next(retryError);
    }
  }

  bool _shouldAttemptRefresh(DioException err) {
    if (err.response?.statusCode != 401) return false;
    // Only retry a request that has not already been replayed.
    if (err.requestOptions.extra['nova_auth_retried'] == true) return false;

    final path = err.requestOptions.uri.path;
    for (final excluded in refreshExcludedPaths) {
      if (path.endsWith(excluded)) return false;
    }

    return repository.currentToken != null;
  }

  /// Single-flight refresh shared by every concurrent 401.
  Future<AuthToken?> _refreshOnce() {
    return _inFlight ??= _performRefresh().whenComplete(() {
      _inFlight = null;
    });
  }

  Future<AuthToken?> _performRefresh() async {
    final refreshToken = repository.currentToken?.refreshToken;
    if (refreshToken == null || refreshToken.isEmpty) {
      await _notifyRefreshFailed();
      return null;
    }

    try {
      final token = await refreshAccessToken(refreshToken);
      // The callback signals failure either by throwing or by returning null.
      if (token == null) {
        await _notifyRefreshFailed();
      }
      return token;
    } catch (error, stackTrace) {
      debugPrint('[AuthInterceptor] Token refresh failed: $error\n$stackTrace');
      await _notifyRefreshFailed();
      return null;
    }
  }

  /// Notifies the app at most once per refresh attempt, and never lets a throwing
  /// listener break request handling.
  Future<void> _notifyRefreshFailed() async {
    try {
      await onRefreshFailed?.call();
    } catch (error, stackTrace) {
      debugPrint('[AuthInterceptor] onRefreshFailed threw: $error\n$stackTrace');
    }
  }
}
