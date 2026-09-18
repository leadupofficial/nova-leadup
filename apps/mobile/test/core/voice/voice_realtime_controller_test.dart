import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/voice/voice_capture.dart';
import 'package:nova_mobile/core/voice/voice_realtime_controller.dart';

import 'voice_realtime_test_support.dart';

void main() {
  late VoiceRealtimeHarness harness;

  setUp(() => harness = VoiceRealtimeHarness());
  tearDown(() => harness.dispose());

  group('starting a turn', () {
    test('starts idle', () {
      expect(harness.state.phase, VoiceRealtimePhase.idle);
      expect(harness.state.micActive, isFalse);
    });

    test('connects, sends start with a normalised language, then listens', () async {
      await harness.controller.startTurn(language: 'tanglish');
      await settle();

      expect(harness.connector.connectCalls, 1);
      expect(harness.socket.sent.first, isA<String>());
      expect(
        jsonDecode(harness.socket.sent.first as String),
        <String, dynamic>{'type': 'start', 'language': 'auto'},
      );
      expect(harness.state.phase, VoiceRealtimePhase.listening);
      expect(harness.state.micActive, isTrue);
      expect(harness.capture.startCalls, 1);
    });

    test('sends a bare protocol code for a supported policy', () async {
      await harness.controller.startTurn(language: 'ta');
      await settle();
      expect(
        jsonDecode(harness.socket.sent.first as String),
        <String, dynamic>{'type': 'start', 'language': 'ta'},
      );
    });

    test('a denied microphone is a typed error, not a crash', () async {
      harness.capture.failWith = const VoiceCaptureException(
        VoiceCaptureFailure.permissionPermanentlyDenied,
        'Microphone access is blocked. Turn it on for NOVA in Settings.',
      );

      await harness.controller.startTurn();
      await settle();

      expect(harness.state.phase, VoiceRealtimePhase.error);
      expect(harness.state.errorCode, 'permissionPermanentlyDenied');
      expect(harness.state.errorMessage, contains('Settings'));
      expect(harness.state.micActive, isFalse);
      // The server was told the turn is over instead of being left waiting.
      expect(
        harness.socket.sent,
        contains(jsonEncode(<String, String>{'type': 'cancel'})),
      );
    });

    test('a mic failure mid-turn moves to error and stops the stream', () async {
      await harness.controller.startTurn();
      await settle();

      harness.capture.failLater(
        const VoiceCaptureException(
          VoiceCaptureFailure.noMicrophone,
          'No usable microphone was found on this device.',
        ),
      );
      await settle();

      expect(harness.state.phase, VoiceRealtimePhase.error);
      expect(harness.state.errorMessage, contains('No usable microphone'));
    });
  });

  group('microphone frames', () {
    test('are forwarded as binary frames while listening', () async {
      await harness.controller.startTurn();
      await settle();

      harness.capture.emit(<int>[1, 2, 3, 4]);
      await settle();

      final binary = harness.socket.sent.whereType<Uint8List>().toList();
      expect(binary, hasLength(1));
      expect(binary.single, <int>[1, 2, 3, 4]);
    });

    test('are dropped once the turn is no longer listening', () async {
      await harness.controller.startTurn();
      await settle();
      await harness.controller.stopTurn();
      await settle();

      harness.capture.emit(<int>[9, 9]);
      await settle();

      expect(harness.socket.sent.whereType<Uint8List>(), isEmpty);
    });

    test('stopTurn sends stop, closes the mic and waits for final', () async {
      await harness.controller.startTurn();
      await settle();
      await harness.controller.stopTurn();
      await settle();

      expect(
        jsonDecode(harness.socket.sent.last as String),
        <String, dynamic>{'type': 'stop'},
      );
      expect(harness.capture.isStreaming, isFalse);
      expect(harness.state.phase, VoiceRealtimePhase.thinking);
      expect(harness.state.micActive, isFalse);
    });
  });

  group('server events drive the state machine', () {
    test('partial renders live and is replaced by final', () async {
      await harness.controller.startTurn();
      await settle();

      harness.socket.push('{"type":"partial","text":"vanak"}');
      await settle();
      expect(harness.state.partial, 'vanak');
      expect(harness.state.phase, VoiceRealtimePhase.listening);

      harness.socket.push('{"type":"partial","text":"vanakkam"}');
      await settle();
      expect(harness.state.partial, 'vanakkam');

      harness.socket.push('{"type":"final","text":"vanakkam"}');
      await settle();
      expect(harness.state.partial, '');
      expect(harness.state.phase, VoiceRealtimePhase.thinking);
      expect(harness.state.commits, hasLength(1));
      expect(harness.state.commits.single.user, isTrue);
      expect(harness.state.commits.single.text, 'vanakkam');
    });

    test('tokens accumulate, sentences open playback, audio is appended', () async {
      await harness.controller.startTurn();
      await settle();
      harness.socket.push('{"type":"final","text":"hi"}');
      await settle();

      harness.socket.push('{"type":"token","text":"Hello"}');
      harness.socket.push('{"type":"token","text":" there"}');
      await settle();
      expect(harness.state.reply, 'Hello there');
      expect(harness.state.phase, VoiceRealtimePhase.thinking);

      harness.socket.push('{"type":"sentence","text":"Hello there.","index":0}');
      await settle();
      expect(harness.playback.beginTurns, 1);
      expect(harness.state.phase, VoiceRealtimePhase.speaking);
      expect(harness.state.sentenceIndex, 0);

      harness.socket.push(Uint8List.fromList(<int>[7, 7, 7]));
      await settle();
      expect(harness.playback.chunks.single, <int>[7, 7, 7]);
      expect(harness.state.phase, VoiceRealtimePhase.speaking);
    });

    test('a second sentence never reopens the player (no gap, no restart)', () async {
      await harness.controller.startTurn();
      await settle();
      // `startTurn` begins by flushing whatever was playing; ignore that one.
      final stopsAfterStart = harness.playback.stops;

      harness.socket.push('{"type":"final","text":"hi"}');
      harness.socket.push('{"type":"sentence","text":"One.","index":0}');
      harness.socket.push(Uint8List.fromList(<int>[1]));
      harness.socket.push('{"type":"sentence","text":"Two.","index":1}');
      harness.socket.push(Uint8List.fromList(<int>[2]));
      await settle();

      expect(harness.playback.beginTurns, 1);
      expect(harness.playback.stops, stopsAfterStart);
      expect(harness.playback.chunks, hasLength(2));
      expect(harness.state.sentenceIndex, 1);
    });

    test('speaking:false flushes the player', () async {
      await harness.controller.startTurn();
      await settle();
      harness.socket.push('{"type":"sentence","text":"One.","index":0}');
      await settle();
      expect(harness.state.phase, VoiceRealtimePhase.speaking);

      harness.socket.push('{"type":"speaking","value":false}');
      await settle();

      expect(harness.playback.stops, greaterThan(0));
      expect(harness.state.phase, VoiceRealtimePhase.thinking);
    });

    test('done commits the reply and stays listening while the mic is open',
        () async {
      await harness.controller.startTurn();
      await settle();
      harness.socket.push('{"type":"final","text":"hi"}');
      harness.socket.push('{"type":"sentence","text":"Hello.","index":0}');
      harness.socket.push('{"type":"done","text":"Hello there."}');
      await settle();

      expect(harness.playback.endTurns, 1);
      // The turn ended but the session did not: the microphone is still open and
      // the provider is still transcribing, so the user can just keep talking.
      // Reporting idle here is what made hands-free conversation look broken.
      expect(harness.state.phase, VoiceRealtimePhase.listening);
      expect(harness.state.micActive, isTrue);
      expect(harness.state.reply, '');
      expect(harness.state.commits, hasLength(2));
      expect(harness.state.commits.last.user, isFalse);
      expect(harness.state.commits.last.text, 'Hello there.');
    });

    test('done returns to idle once the microphone has been stopped', () async {
      await harness.controller.startTurn();
      await settle();
      await harness.controller.stopTurn();
      harness.socket.push('{"type":"final","text":"hi"}');
      harness.socket.push('{"type":"done","text":"Hello there."}');
      await settle();

      // Nothing is capturing, so the session really is finished.
      expect(harness.state.phase, VoiceRealtimePhase.idle);
      expect(harness.state.micActive, isFalse);
    });

    test('a server error stops the mic, flushes audio and reports the code', () async {
      await harness.controller.startTurn();
      await settle();

      harness.socket.push(
        '{"type":"error","code":"stt_unavailable","message":"Speech to text is down."}',
      );
      await settle();

      expect(harness.state.phase, VoiceRealtimePhase.error);
      expect(harness.state.errorCode, 'stt_unavailable');
      expect(harness.state.errorMessage, 'Speech to text is down.');
      expect(harness.playback.stops, greaterThan(0));
    });

    test('unknown types and malformed frames are ignored, not fatal', () async {
      await harness.controller.startTurn();
      await settle();
      final before = harness.state;

      harness.socket.push('{"type":"avatar_blink"}');
      harness.socket.push('this is not json');
      harness.socket.push(42);
      await settle();

      expect(harness.state.phase, before.phase);
      expect(harness.state.partial, before.partial);
    });

    test('clearError returns to idle', () async {
      await harness.controller.startTurn();
      await settle();
      harness.socket.push('{"type":"error","code":"x","message":"y"}');
      await settle();
      expect(harness.state.phase, VoiceRealtimePhase.error);

      harness.controller.clearError();
      expect(harness.state.phase, VoiceRealtimePhase.idle);
      expect(harness.state.errorMessage, isNull);
    });
  });
}
