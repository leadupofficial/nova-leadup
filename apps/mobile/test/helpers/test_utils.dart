import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:nova_mobile/core/network/network_info_service.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';
import 'package:nova_mobile/services/network_service.dart';

import './test_harness.dart';

/// True when the test should reach a live API.
bool get isLiveIntegration =>
    Platform.environment['NOVA_LIVE_API'] == '1';

/// True when the test should use the mock server (default).
bool get isMockIntegration => !isLiveIntegration;

/// The API base URL from --dart-define=API_URL or the production default.
String get integrationBaseUrl =>
    const String.fromEnvironment('API_URL', defaultValue: 'https://nova.leadup.in');

/// Dio BaseOptions pre-configured for integration tests.
BaseOptions integrationBaseOptions({String? baseUrl}) {
  final url = baseUrl ?? integrationBaseUrl;
  return BaseOptions(
    baseUrl: url,
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 30),
    sendTimeout: const Duration(seconds: 10),
    headers: const <String, dynamic>{
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  );
}

// ─── Always-online stub ───────────────────────────────────────────────────────

class _AlwaysOnline implements NetworkInfoService {
  @override
  Future<bool> get isConnected async => true;

  @override
  Stream<bool> get onConnectivityChanged =>
      const Stream<bool>.empty();
}

// ─── Live API clients ─────────────────────────────────────────────────────────

/// Builds a Dio client configured for the integration base URL.
Dio buildLiveDio() => Dio(integrationBaseOptions());

/// Builds an AuthApi connected to the live API.
AuthApi buildLiveAuthApi() =>
    AuthApi(NetworkService(dio: buildLiveDio(), networkInfo: _AlwaysOnline()));

/// Builds an AuthRepository backed by FakeSecureStorage for integration tests.
AuthRepository buildLiveAuthRepository() =>
    AuthRepository(FakeSecureStorage());

// ─── Mock HTTP adapter utilities ──────────────────────────────────────────────

/// Scriptable Dio adapter that answers from a handler.
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

/// Builds a JSON ResponseBody for MockHttpAdapter.
ResponseBody mockJsonResponse(Object body, {int statusCode = 200}) {
  return ResponseBody.fromString(
    jsonEncode(body),
    statusCode,
    headers: <String, List<String>>{
      Headers.contentTypeHeader: <String>[Headers.jsonContentType],
    },
  );
}

/// A NetworkService wired to a scripted adapter rather than a real socket.
NetworkService mockNetworkService(
  MockHttpAdapter adapter, {
  NetworkInfoService? networkInfo,
}) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.test.invalid'))
    ..httpClientAdapter = adapter;
  return NetworkService(dio: dio, networkInfo: networkInfo ?? _AlwaysOnline());
}

/// A NetworkService that answers every request with 200 {}.
/// Useful when the widget tree makes an API call but the test only cares
/// about routing / UI presence.
NetworkService emptyApiNetworkService() {
  final adapter = MockHttpAdapter((options) async {
    return mockJsonResponse(<String, dynamic>{'ok': true});
  });
  return mockNetworkService(adapter);
}

/// A NetworkService that answers every request with 200 {} but reports
/// the device as offline. Drives the offline-error UI paths.
NetworkService offlineApiNetworkService() {
  final adapter = MockHttpAdapter((options) async {
    return mockJsonResponse(<String, dynamic>{'ok': true});
  });
  return mockNetworkService(adapter, networkInfo: _OfflineNetworkInfoService());
}

class _OfflineNetworkInfoService implements NetworkInfoService {
  @override
  Future<bool> get isConnected async => false;

  @override
  Stream<bool> get onConnectivityChanged => const Stream<bool>.empty();
}

// ─── Test data generators ─────────────────────────────────────────────────────

/// A monotonically increasing integer for unique suffixes.
int _counter = 0;

/// Returns a string unique to this test invocation.
String uniqueSuffix() => '${++_counter}-${DateTime.now().microsecondsSinceEpoch % 100000}';

/// Returns a unique email address for test users.
String uniqueEmail(String tag) => 'test-$tag-${uniqueSuffix()}@nova.test';

/// Returns a unique password for test users.
String uniquePassword() => 'TestPass-${uniqueSuffix()}';
