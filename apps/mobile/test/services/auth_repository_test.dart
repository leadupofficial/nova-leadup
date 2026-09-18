import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';

class FakeFlutterSecureStorage extends Fake implements FlutterSecureStorage {
  final Map<String, String?> _store = {};

  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _store[key] = value;
  }

  @override
  Future<String?> read({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _store[key];

  @override
  Future<void> delete({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _store.remove(key);

  @override
  Future<bool> containsKey({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _store.containsKey(key);
}

void main() {
  group('AuthToken', () {
    test('creates from JSON with default expires_in', () {
      final token = AuthToken.fromJson({
        'access_token': 'access123',
        'refresh_token': 'refresh123',
      });

      expect(token.accessToken, 'access123');
      expect(token.refreshToken, 'refresh123');
      expect(token.expiresAt, isA<DateTime>());
    });

    test('creates from JSON with custom expires_in', () {
      final token = AuthToken.fromJson({
        'access_token': 'acc',
        'refresh_token': 'ref',
        'expires_in': 7200,
      });

      expect(token.accessToken, 'acc');
      expect(token.refreshToken, 'ref');
      expect(token.expiresAt.difference(DateTime.now()).inSeconds, greaterThan(7100));
    });

    test('isExpired returns true when past expiry', () {
      final token = AuthToken(
        accessToken: 'acc',
        refreshToken: 'ref',
        expiresAt: DateTime.now().subtract(const Duration(hours: 1)),
      );

      expect(token.isExpired, isTrue);
    });

    test('isExpired returns false when within 1-minute grace window', () {
      final token = AuthToken(
        accessToken: 'acc',
        refreshToken: 'ref',
        expiresAt: DateTime.now().add(const Duration(seconds: 30)),
      );

      expect(token.isExpired, isFalse);
    });

    test('bearerHeader returns correct format', () {
      final token = AuthToken(
        accessToken: 'my-token',
        refreshToken: 'ref',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );

      expect(token.bearerHeader, 'Bearer my-token');
    });

    test('toJson round-trips correctly', () {
      final original = AuthToken(
        accessToken: 'acc',
        refreshToken: 'ref',
        expiresAt: DateTime(2026, 1, 1),
      );

      final json = original.toJson();
      final restored = AuthToken.fromJson(json);

      expect(restored.accessToken, 'acc');
      expect(restored.refreshToken, 'ref');
    });
  });

  group('AuthRepository', () {
    late FakeFlutterSecureStorage fakeStorage;
    late AuthRepository repo;

    setUp(() {
      fakeStorage = FakeFlutterSecureStorage();
      repo = AuthRepository(fakeStorage);
    });

    test('saveTokens persists token data', () async {
      final token = AuthToken(
        accessToken: 'acc',
        refreshToken: 'ref',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );

      await repo.saveTokens(token);
      final stored = await fakeStorage.read(key: 'auth_token');
      expect(stored, isNotNull);
      final decoded = jsonDecode(stored!) as Map<String, dynamic>;
      expect(decoded['access_token'], 'acc');
      expect(decoded['refresh_token'], 'ref');
    });

    test('getTokens returns null when no token stored', () async {
      final result = await repo.getTokens();
      expect(result, isNull);
    });

    test('getTokens returns AuthToken after save', () async {
      final token = AuthToken(
        accessToken: 'acc',
        refreshToken: 'ref',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );
      await repo.saveTokens(token);

      final result = await repo.getTokens();
      expect(result, isNotNull);
      expect(result!.accessToken, 'acc');
      expect(result.refreshToken, 'ref');
    });

    test('getTokens returns null on corrupt data', () async {
      await fakeStorage.write(key: 'auth_token', value: 'not-valid-json');

      final result = await repo.getTokens();
      expect(result, isNull);
    });

    test('clearTokens removes stored data', () async {
      final token = AuthToken(
        accessToken: 'acc',
        refreshToken: 'ref',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );
      await repo.saveTokens(token);

      await repo.clearTokens();
      final result = await repo.getTokens();
      expect(result, isNull);
    });

    test('isLoggedIn returns true after save', () async {
      final token = AuthToken(
        accessToken: 'acc',
        refreshToken: 'ref',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );
      await repo.saveTokens(token);

      expect(repo.isLoggedIn, isTrue);
    });

    test('isLoggedIn returns false before any token is saved', () async {
      expect(repo.isLoggedIn, isFalse);
    });
  });
}
