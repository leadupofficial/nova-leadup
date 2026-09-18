import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/services/voice_stream_service.dart';

/// Waits until [condition] holds, or gives up after [timeout].
///
/// The reconnect schedule is driven by real timers, so a fixed `delayed` is a
/// race: under load the last attempt can succeed after the sleep has already
/// elapsed and the status still reads `reconnecting`. Polling waits for the
/// state the test is actually about without loosening the assertion.
Future<void> _waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition() && DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

/// A socket whose lifecycle the test drives by hand.
class FakeVoiceSocket implements VoiceSocket {
  final StreamController<dynamic> controller = StreamController<dynamic>.broadcast();
  final List<dynamic> sent = <dynamic>[];
  bool closed = false;

  @override
  Stream<dynamic> get stream => controller.stream;

  @override
  void add(dynamic data) {
    if (closed) throw StateError('socket already closed');
    sent.add(data);
  }

  @override
  Future<void> close() async {
    closed = true;
    if (!controller.isClosed) await controller.close();
  }

  /// Simulates the server dropping the connection.
  Future<void> drop() async {
    if (!controller.isClosed) await controller.close();
  }
}

/// Connector that fails a configurable number of times before succeeding.
class ScriptedConnector implements VoiceSocketConnector {
  ScriptedConnector({this.failuresBeforeSuccess = 0});

  int failuresBeforeSuccess;
  int connectCalls = 0;
  final List<FakeVoiceSocket> sockets = <FakeVoiceSocket>[];

  FakeVoiceSocket get lastSocket => sockets.last;

  @override
  Future<VoiceSocket> connect(Uri uri, {Map<String, dynamic>? headers}) async {
    connectCalls++;
    if (connectCalls <= failuresBeforeSuccess) {
      throw StateError('connect failed (attempt $connectCalls)');
    }
    final socket = FakeVoiceSocket();
    sockets.add(socket);
    return socket;
  }
}

void main() {
  group('VoiceReconnectConfig', () {
    test('first attempt uses the initial delay', () {
      const config = VoiceReconnectConfig(
        initialDelay: Duration(milliseconds: 400),
        jitter: 0,
      );
      expect(config.computeDelay(0), const Duration(milliseconds: 400));
    });

    test('delays grow exponentially and are capped by maxDelay', () {
      const config = VoiceReconnectConfig(
        initialDelay: Duration(milliseconds: 100),
        maxDelay: Duration(seconds: 2),
        multiplier: 2,
        jitter: 0,
      );

      expect(config.computeDelay(1), const Duration(milliseconds: 200));
      expect(config.computeDelay(2), const Duration(milliseconds: 400));
      expect(config.computeDelay(3), const Duration(milliseconds: 800));
      // 100 * 2^6 = 6400ms, clamped to the 2s ceiling.
      expect(config.computeDelay(6), const Duration(seconds: 2));
    });

    test('jitter stays within the configured fraction', () {
      const config = VoiceReconnectConfig(
        initialDelay: Duration(milliseconds: 1000),
        maxDelay: Duration(seconds: 60),
        jitter: 0.2,
      );

      // Random(seed) makes the assertion deterministic.
      final random = Random(7);
      for (var i = 0; i < 50; i++) {
        final delay = config.computeDelay(1, random: random);
        final base = 2000;
        expect(delay.inMilliseconds, greaterThanOrEqualTo((base * 0.8).floor()));
        expect(delay.inMilliseconds, lessThanOrEqualTo((base * 1.2).ceil()));
      }
    });
  });

  group('VoiceStreamService', () {
    test('connects and forwards incoming frames', () async {
      final connector = ScriptedConnector();
      final service = VoiceStreamService(
        uri: Uri.parse('wss://example.test/api/v1/voice/stream'),
        connector: connector,
      );

      final received = <dynamic>[];
      service.messages.listen(received.add);

      await service.connect();

      expect(service.status, VoiceStreamStatus.connected);
      expect(connector.connectCalls, 1);

      connector.lastSocket.controller.add('hello');
      await Future<void>.delayed(Duration.zero);

      expect(received, <dynamic>['hello']);
      await service.close();
    });

    test('reconnects automatically after the server drops the connection', () async {
      final connector = ScriptedConnector();
      final service = VoiceStreamService(
        uri: Uri.parse('wss://example.test/api/v1/voice/stream'),
        connector: connector,
        config: const VoiceReconnectConfig(
          initialDelay: Duration(milliseconds: 5),
          jitter: 0,
        ),
      );

      await service.connect();
      expect(connector.connectCalls, 1);

      await connector.lastSocket.drop();

      // Give the backoff timer room to fire.
      await Future<void>.delayed(const Duration(milliseconds: 80));

      expect(connector.connectCalls, 2);
      expect(service.status, VoiceStreamStatus.connected);
      await service.close();
    });

    test('retries a failed connect with increasing attempts', () async {
      final connector = ScriptedConnector(failuresBeforeSuccess: 3);
      final errors = <Object>[];
      final service = VoiceStreamService(
        uri: Uri.parse('wss://example.test/api/v1/voice/stream'),
        connector: connector,
        config: const VoiceReconnectConfig(
          initialDelay: Duration(milliseconds: 5),
          jitter: 0,
        ),
      );
      service.errors.listen(errors.add);

      await service.connect();
      await _waitFor(() => service.status == VoiceStreamStatus.connected);

      expect(connector.connectCalls, 4);
      expect(errors, hasLength(3));
      expect(service.status, VoiceStreamStatus.connected);
      await service.close();
    });

    test('gives up after maxAttempts and reports disconnected', () async {
      final connector = ScriptedConnector(failuresBeforeSuccess: 99);
      final service = VoiceStreamService(
        uri: Uri.parse('wss://example.test/api/v1/voice/stream'),
        connector: connector,
        config: const VoiceReconnectConfig(
          initialDelay: Duration(milliseconds: 1),
          jitter: 0,
          maxAttempts: 2,
        ),
      );

      await service.connect();
      await _waitFor(() => service.status == VoiceStreamStatus.disconnected);

      expect(service.status, VoiceStreamStatus.disconnected);
      // One initial attempt plus two retries.
      expect(connector.connectCalls, 3);
      await service.close();
    });

    test('send returns false while disconnected and true once connected', () async {
      final connector = ScriptedConnector();
      final service = VoiceStreamService(
        uri: Uri.parse('wss://example.test/api/v1/voice/stream'),
        connector: connector,
      );

      expect(service.send('frame'), isFalse);

      await service.connect();
      expect(service.send('frame'), isTrue);
      expect(connector.lastSocket.sent, <dynamic>['frame']);

      await service.close();
    });

    test('close stops reconnection permanently', () async {
      final connector = ScriptedConnector();
      final service = VoiceStreamService(
        uri: Uri.parse('wss://example.test/api/v1/voice/stream'),
        connector: connector,
        config: const VoiceReconnectConfig(
          initialDelay: Duration(milliseconds: 5),
          jitter: 0,
        ),
      );

      await service.connect();
      await service.close();

      await connector.lastSocket.drop();
      await Future<void>.delayed(const Duration(milliseconds: 60));

      expect(service.status, VoiceStreamStatus.closed);
      expect(connector.connectCalls, 1);
    });

    test('emits status transitions', () async {
      final connector = ScriptedConnector();
      final service = VoiceStreamService(
        uri: Uri.parse('wss://example.test/api/v1/voice/stream'),
        connector: connector,
      );

      final statuses = <VoiceStreamStatus>[];
      service.statuses.listen(statuses.add);

      await service.connect();
      await Future<void>.delayed(Duration.zero);

      expect(statuses, contains(VoiceStreamStatus.connecting));
      expect(statuses, contains(VoiceStreamStatus.connected));

      await service.close();
    });
  });
}
