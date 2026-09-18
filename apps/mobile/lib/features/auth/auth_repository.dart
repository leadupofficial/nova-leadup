import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class AuthToken {
  final String accessToken;
  final String refreshToken;
  final DateTime expiresAt;

  AuthToken({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresAt,
  });

  factory AuthToken.fromJson(Map<String, dynamic> json) {
    DateTime expiry;
    if (json['expires_at'] != null) {
      expiry = DateTime.parse(json['expires_at'] as String);
    } else {
      final expiresIn = (json['expires_in'] as num?)?.toInt() ?? 3600;
      expiry = DateTime.now().add(Duration(seconds: expiresIn));
    }

    return AuthToken(
      accessToken: json['access_token'] as String,
      refreshToken: json['refresh_token'] as String,
      expiresAt: expiry,
    );
  }

  Map<String, dynamic> toJson() => {
        'access_token': accessToken,
        'refresh_token': refreshToken,
        'expires_at': expiresAt.toIso8601String(),
      };

  bool get isExpired => DateTime.now().isAfter(expiresAt);

  String get bearerHeader => 'Bearer $accessToken';
}

/// The signed-in user, as returned by the API.
class AuthUser {
  const AuthUser({required this.id, required this.email, this.name});

  final String id;
  final String email;
  final String? name;

  factory AuthUser.fromJson(Map<String, dynamic> json) => AuthUser(
        id: (json['id'] ?? json['user_id'] ?? json['sub'] ?? '').toString(),
        email: (json['email'] ?? '').toString(),
        name: json['name'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'email': email,
        if (name != null) 'name': name,
      };

  /// Falls back to the local part of the email when the server sends no name.
  String get displayName {
    final trimmed = name?.trim();
    if (trimmed != null && trimmed.isNotEmpty) return trimmed;
    if (email.contains('@')) return email.split('@').first;
    return email.isEmpty ? 'there' : email;
  }
}

/// Persists the authentication session in the platform secure store.
///
/// Deliberately knows nothing about HTTP: [AuthApi] performs the network calls and
/// this class owns storage, which keeps it trivially testable.
class AuthRepository {
  static const _tokenKey = 'auth_token';
  static const _userKey = 'auth_user';

  final FlutterSecureStorage _storage;

  AuthToken? _currentToken;
  AuthUser? _currentUser;
  bool _isLoggedIn = false;

  AuthRepository(this._storage);

  bool get isLoggedIn => _isLoggedIn;

  AuthToken? get currentToken => _currentToken;

  AuthUser? get currentUser => _currentUser;

  /// Loads any persisted session into memory so routing can read it synchronously.
  /// Call once during app bootstrap.
  Future<void> restore() async {
    _currentToken = await getTokens();
    _currentUser = await _readUser();
    _isLoggedIn = _currentToken != null;
  }

  Future<void> saveTokens(AuthToken token) async {
    final encoded = jsonEncode(token.toJson());
    await _storage.write(key: _tokenKey, value: encoded);
    _currentToken = token;
    _isLoggedIn = true;
  }

  Future<AuthToken?> getTokens() async {
    try {
      final data = await _storage.read(key: _tokenKey);
      if (data == null) {
        _isLoggedIn = false;
        return null;
      }
      final decoded = jsonDecode(data) as Map<String, dynamic>;
      final token = AuthToken.fromJson(decoded);
      _isLoggedIn = true;
      return token;
    } catch (_) {
      _isLoggedIn = false;
      return null;
    }
  }

  /// Persists a full session: tokens and, when available, the user profile.
  Future<void> saveSession(AuthToken token, {AuthUser? user}) async {
    await saveTokens(token);
    if (user != null) {
      _currentUser = user;
      await _storage.write(key: _userKey, value: jsonEncode(user.toJson()));
    }
  }

  Future<void> clearTokens() async {
    await _storage.delete(key: _tokenKey);
    _currentToken = null;
    _isLoggedIn = false;
  }

  /// Clears everything, including the cached profile.
  Future<void> clearSession() async {
    await clearTokens();
    _currentUser = null;
    try {
      await _storage.delete(key: _userKey);
    } catch (_) {
      // A failure to remove the profile must not block logout.
    }
  }

  Future<AuthUser?> _readUser() async {
    try {
      final data = await _storage.read(key: _userKey);
      if (data == null) return null;
      return AuthUser.fromJson(jsonDecode(data) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }
}
