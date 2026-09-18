import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/voice/voice_realtime_controller.dart';

import 'voice_realtime_test_support.dart';

void main() {
  late VoiceRealtimeHarness harness;

  setUp(() => harness = VoiceRealtimeHarness());
  tearDown(() => harness.dispose());

  group('barge-in and cancellation', () {
    Future<void> reachSpeaking(VoiceRealtimeHarness h) async {
      await h.controller.startTurn();
      await settle();
      h.socket.push('{"type":"final","text":"hi"}');
      h.socket.push('{"type":"sentence","text":"A long reply.","index":0}');
      h.socket.push(Uint8List.fromList(<int>[1, 2]));
      await settle();
      expect(h.state.phase, VoiceRealtimePhase.speaking);
    }

    test('starting a turn while NOVA speaks cancels and flushes', () async {
      await reachSpeaking(harness);
      final stopsBefore = harness.playback.stops;

      await harness.controller.startTurn();
      await settle();

      expect(harness.playback.stops, greaterThan(stopsBefore));
      expect(
        harness.socket.sent,
        contains(jsonEncode(<String, String>{'type': 'cancel'})),
      );
      expect(
        harness.socket.sent,
        contains(
          jsonEncode(<String, String>{'type': 'start', 'language': 'auto'}),
        ),
      );
      expect(harness.state.phase, VoiceRealtimePhase.listening);
      expect(harness.state.micActive, isTrue);
    });

    test('cancel sends cancel, closes the mic, flushes audio and idles', () async {
      await reachSpeaking(harness);

      await harness.controller.cancel();
      await settle();

      expect(harness.capture.isStreaming, isFalse);
      expect(harness.playback.stops, greaterThan(0));
      expect(harness.state.phase, VoiceRealtimePhase.idle);
      expect(harness.state.micActive, isFalse);
    });
  });

  group('connection faults', () {
    test('a dropped socket while listening becomes an honest error', () async {
      await harness.controller.startTurn();
      await settle();

      await harness.socket.drop();
      await settle();

      expect(harness.state.phase, VoiceRealtimePhase.error);
      expect(harness.state.errorCode, 'reconnecting');
      expect(harness.capture.isStreaming, isFalse);
    });

    test('a reconnect clears a fault-driven error', () async {
      await harness.controller.startTurn();
      await settle();
      await harness.socket.drop();
      await settle();
      expect(harness.state.phase, VoiceRealtimePhase.error);

      // The service reconnects on its own and the new socket says ready.
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(harness.connector.connectCalls, greaterThan(1));
      harness.socket.push('{"type":"ready"}');
      await settle();

      expect(harness.state.phase, VoiceRealtimePhase.idle);
      expect(harness.state.errorMessage, isNull);
    });
  });

  group('typed input through the same pipeline', () {
    test('sendText writes a text frame and moves to thinking', () async {
      final accepted = await harness.controller.sendText('  hello  ');
      await settle();

      expect(accepted, isTrue);
      expect(
        jsonDecode(harness.socket.sent.last as String),
        <String, dynamic>{'type': 'text', 'text': 'hello'},
      );
      expect(harness.state.phase, VoiceRealtimePhase.thinking);
    });

    test('blank text is rejected without touching the socket', () async {
      expect(await harness.controller.sendText('   '), isFalse);
      expect(harness.connector.sockets, isEmpty);
    });
  });

  group('teardown', () {
    test('disposing the container stops the microphone and the player', () async {
      await harness.controller.startTurn();
      await settle();

      harness.container.dispose();
      await settle();

      expect(harness.capture.stopCalls, greaterThan(0));
      expect(harness.capture.isStreaming, isFalse);
      expect(harness.playback.stops, greaterThan(0));
    });
  });
}
