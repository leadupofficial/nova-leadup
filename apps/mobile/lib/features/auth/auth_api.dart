import 'package:dio/dio.dart';

import '../../config/api_config.dart';
import '../../services/network_service.dart';
import 'auth_repository.dart';

/// Raised for any authentication failure that the UI should surface verbatim.
class AuthException implements Exception {
  const AuthException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => 'AuthException(${statusCode ?? "-"}): $message';
}

/// A successful authentication: tokens plus, when the server returns one, the user.
class AuthSession {
  const AuthSession({required this.token, this.user});

  final AuthToken token;
  final AuthUser? user;
}

/// Authentication endpoints, kept separate from [AuthRepository] so that the
/// repository stays a pure token store (which is what `auth_repository_test.dart`
/// exercises).
///
/// The API wraps every payload in `{ success: true, data: {...} }` (see
/// `services/api/src/routes/auth.ts`), so responses are unwrapped before parsing. A
/// bare top-level payload is accepted too, which keeps this working against older
/// server revisions and keeps the unit tests simple.
class AuthApi {
  AuthApi(this._network);

  final NetworkService _network;

  Future<AuthSession> login({
    required String email,
    required String password,
  }) {
    return _authenticate(
      ApiConfig.authLogin,
      <String, dynamic>{'email': email, 'password': password},
    );
  }

  Future<AuthSession> register({
    required String email,
    required String password,
    String? name,
  }) {
    return _authenticate(
      ApiConfig.authRegister,
      <String, dynamic>{
        'email': email,
        'password': password,
        if (name != null && name.isNotEmpty) 'name': name,
      },
    );
  }

  /// Exchanges a refresh token for a new token pair.
  ///
  /// The server rotates refresh tokens, so the caller must persist the returned
  /// `refresh_token`: the presented one is single-use from then on.
  Future<AuthSession> refresh(String refreshToken) async {
    final Response<dynamic> response;
    try {
      // The backend's refresh schema reads `refreshToken` (camelCase), unlike the
      // snake_case token fields it returns.
      response = await _network.post<dynamic>(
        ApiConfig.authRefresh,
        data: <String, dynamic>{'refreshToken': refreshToken},
      );
    } on NetworkException catch (error) {
      throw AuthException(error.message, statusCode: error.statusCode);
    }

    final map = _unwrap(response.data, endpoint: ApiConfig.authRefresh);
    final accessToken = map['access_token'] ?? map['accessToken'];
    if (accessToken is! String || accessToken.isEmpty) {
      throw AuthException(
        'The server did not return an access token when refreshing.',
        statusCode: response.statusCode,
      );
    }

    final userJson = map['user'];
    return AuthSession(
      token: AuthToken.fromJson(map),
      user: userJson is Map
          ? AuthUser.fromJson(Map<String, dynamic>.from(userJson))
          : null,
    );
  }

  /// Best-effort server-side logout.
  ///
  /// Sends the refresh token when available so the server revokes exactly this
  /// device's session rather than every session belonging to the user.
  Future<void> logout(String accessToken, {String? refreshToken}) async {
    try {
      await _network.post<dynamic>(
        ApiConfig.authLogout,
        data: <String, dynamic>{
          'refreshToken': ?refreshToken,
        },
        options: Options(
          headers: <String, dynamic>{'Authorization': 'Bearer $accessToken'},
        ),
      );
    } on NetworkException {
      // Logging out locally must succeed even when the server call does not:
      // otherwise the user is trapped in an authenticated state.
    }
  }

  Future<AuthSession> _authenticate(
    String url,
    Map<String, dynamic> body,
  ) async {
    final Response<dynamic> response;
    try {
      response = await _network.post<dynamic>(url, data: body);
    } on NetworkException catch (error) {
      throw AuthException(error.message, statusCode: error.statusCode);
    }

    final map = _unwrap(response.data, endpoint: url);
    final accessToken = map['access_token'] ?? map['accessToken'];
    final refreshToken = map['refresh_token'] ?? map['refreshToken'];

    if (accessToken is! String || accessToken.isEmpty) {
      throw AuthException(
        'The server accepted the request but returned no access token.',
        statusCode: response.statusCode,
      );
    }
    if (refreshToken is! String || refreshToken.isEmpty) {
      throw AuthException(
        'The server returned an access token but no refresh token.',
        statusCode: response.statusCode,
      );
    }

    final userJson = map['user'];
    return AuthSession(
      token: AuthToken.fromJson(map),
      user: userJson is Map
          ? AuthUser.fromJson(Map<String, dynamic>.from(userJson))
          : null,
    );
  }

  /// Accepts both `{ success, data: {...} }` and a bare payload object.
  Map<String, dynamic> _unwrap(dynamic rawResponse, {required String endpoint}) {
    if (rawResponse is! Map) {
      throw AuthException('Unexpected response from $endpoint (expected a JSON object).');
    }

    final body = Map<String, dynamic>.from(rawResponse);
    final data = body['data'];
    if (data is Map) {
      return Map<String, dynamic>.from(data);
    }
    return body;
  }
}
