import 'dart:async';
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

    test(
      'connects, sends start with a normalised language, then listens',
      () async {
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
      },
    );

    test('sends a bare protocol code for a supported policy', () async {
      await harness.controller.startTurn(language: 'ta');
      await settle();
      expect(jsonDecode(harness.socket.sent.first as String), <String, dynamic>{
        'type': 'start',
        'language': 'ta',
      });
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

    test(
      'a mic failure mid-turn moves to error and stops the stream',
      () async {
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
      },
    );
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

      expect(jsonDecode(harness.socket.sent.last as String), <String, dynamic>{
        'type': 'stop',
      });
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

    test(
      'tokens accumulate, sentences open playback, audio is appended',
      () async {
        await harness.controller.startTurn();
        await settle();
        harness.socket.push('{"type":"final","text":"hi"}');
        await settle();

        harness.socket.push('{"type":"token","text":"Hello"}');
        harness.socket.push('{"type":"token","text":" there"}');
        await settle();
        expect(harness.state.reply, 'Hello there');
        expect(harness.state.phase, VoiceRealtimePhase.thinking);

        harness.socket.push(
          '{"type":"sentence","text":"Hello there.","index":0}',
        );
        await settle();
        expect(harness.playback.beginTurns, 1);
        expect(harness.state.phase, VoiceRealtimePhase.speaking);
        expect(harness.state.sentenceIndex, 0);

        harness.socket.push(Uint8List.fromList(<int>[7, 7, 7]));
        await settle();
        expect(harness.playback.chunks.single, <int>[7, 7, 7]);
        expect(harness.state.phase, VoiceRealtimePhase.speaking);
      },
    );

    test(
      'a second sentence never reopens the player (no gap, no restart)',
      () async {
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
      },
    );

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

    test('done commits the reply and stays listening while the mic is open', () async {
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

    test(
      'a recognised turn is acknowledged before the reply arrives',
      () async {
        await harness.controller.startTurn();
        await settle();
        expect(harness.playback.acknowledgements, 0);

        harness.socket.push('{"type":"final","text":"what is on my calendar"}');
        await settle();

        // The blip fires on the final, not on the reply: it is covering the
        // model's time-to-first-token, so arriving with the answer would defeat it.
        expect(harness.playback.acknowledgements, 1);
        expect(harness.state.phase, VoiceRealtimePhase.thinking);
      },
    );

    test('a recogniser fallback is surfaced, not swallowed', () async {
      await harness.controller.startTurn();
      await settle();

      harness.socket.push(
        '{"type":"stt","provider":"deepgram","fallback":true,'
        '"reason":"sarvam closed the stream (1003): Credits exhausted. Visit the API Dashboard."}',
      );
      await settle();

      expect(harness.state.speechNotice, isNotNull);
      expect(harness.state.speechNotice, contains('deepgram'));
      // The provider's own words are trimmed to their first clause; the full
      // sentence would not fit a notice.
      expect(harness.state.speechNotice, contains('Credits exhausted'));
      expect(harness.state.speechNotice, isNot(contains('API Dashboard')));
    });

    test('a voice fallback is surfaced too', () async {
      await harness.controller.startTurn();
      await settle();

      harness.socket.push(
        '{"type":"tts","provider":"deepgram","fallback":true,"reason":"TTS provider failed (402)"}',
      );
      await settle();

      expect(harness.state.speechNotice, isNotNull);
      expect(harness.state.speechNotice, contains('deepgram'));
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

    test(
      'a server error stops the mic, flushes audio and reports the code',
      () async {
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
      },
    );

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

  group('device speech fallback', () {
    /// Drives the exact order the server uses when cloud TTS is out of credit:
    /// `sentence` (before synthesis), then `TTS_ERROR`, then more sentences.
    Future<void> reachCloudTtsFailure() async {
      await harness.controller.startTurn(language: 'en');
      await settle();
      harness.socket.push('{"type":"final","text":"what is on my schedule"}');
      harness.socket.push('{"type":"token","text":"You have two meetings."}');
      harness.socket.push(
        '{"type":"sentence","text":"You have two meetings.","index":0}',
      );
      await settle();
      harness.socket.push(
        '{"type":"error","code":"TTS_ERROR","message":"TTS provider failed (402)"}',
      );
      await settle();
    }

    test('TTS_ERROR does not fail the turn and switches to the device voice', () async {
      await reachCloudTtsFailure();

      expect(harness.state.phase, isNot(VoiceRealtimePhase.error));
      expect(harness.state.errorCode, isNull);
      // The reply that was already on screen is kept, not thrown away.
      expect(harness.state.reply, 'You have two meetings.');
      expect(harness.state.speechSource, VoiceSpeechSource.device);
      expect(harness.state.speechNotice, isNotNull);
      // The first sentence was sent *before* synthesis failed, so it has to be
      // replayed rather than lost.
      expect(harness.deviceTts.spoken, <String>['You have two meetings.']);
      expect(harness.deviceTts.spokenLanguages, <String?>['en-IN']);
    });

    test('streams later sentences to the device voice in order', () async {
      await reachCloudTtsFailure();

      harness.socket.push('{"type":"sentence","text":"First.","index":1}');
      harness.socket.push('{"type":"sentence","text":"Second.","index":2}');
      harness.socket.push('{"type":"sentence","text":"Third.","index":3}');
      await settle();

      expect(harness.deviceTts.spoken, <String>[
        'You have two meetings.',
        'First.',
        'Second.',
        'Third.',
      ]);
      expect(
        harness.deviceTts.spokenLanguages,
        everyElement('en-IN'),
        reason: 'the reply language must reach the device engine',
      );
    });

    test('no cloud audio after TTS_ERROR is fed to the player', () async {
      await reachCloudTtsFailure();
      final chunksBefore = harness.playback.chunks.length;

      harness.socket.push(Uint8List.fromList(<int>[1, 2, 3]));
      await settle();

      expect(harness.playback.chunks, hasLength(chunksBefore));
    });

    test('does not repeat a sentence the cloud already voiced', () async {
      await harness.controller.startTurn(language: 'en');
      await settle();
      harness.socket.push('{"type":"final","text":"hi"}');
      harness.socket.push(
        '{"type":"sentence","text":"Voiced by cloud.","index":0}',
      );
      // Cloud audio really did arrive for sentence 0.
      harness.socket.push(Uint8List.fromList(<int>[1, 2, 3]));
      await settle();
      expect(harness.playback.chunks, hasLength(1));

      harness.socket.push(
        '{"type":"error","code":"TTS_ERROR","message":"TTS provider failed (402)"}',
      );
      harness.socket.push(
        '{"type":"sentence","text":"Device says this.","index":1}',
      );
      await settle();

      expect(harness.deviceTts.spoken, <String>[
        'Device says this.',
      ], reason: 'the sentence the cloud already spoke must not be repeated');
    });

    test(
      'a device with no voice for the language says so instead of guessing',
      () async {
        harness.deviceTts.unsupported.add('ta-IN');

        await harness.controller.startTurn(language: 'ta');
        await settle();
        harness.socket.push('{"type":"final","text":"vanakkam"}');
        harness.socket.push(
          '{"type":"error","code":"TTS_ERROR","message":"402"}',
        );
        harness.socket.push('{"type":"sentence","text":"வணக்கம்.","index":0}');
        await settle();

        expect(
          harness.deviceTts.spoken,
          isEmpty,
          reason: 'nothing must be spoken in a voice the device does not have',
        );
        expect(harness.state.speechSource, VoiceSpeechSource.deviceUnavailable);
        expect(harness.state.deviceLanguageTag, 'ta-IN');
        expect(harness.state.speechNotice, contains('ta-IN'));
        // Still not an error: the text reply is intact.
        expect(harness.state.phase, isNot(VoiceRealtimePhase.error));
      },
    );

    test('done keeps speaking until the device engine has finished', () async {
      await reachCloudTtsFailure();

      // Hold the next utterance in flight so `done` arrives mid-speech, which
      // is what really happens: the model finishes before the voice does.
      final hold = Completer<void>();
      harness.deviceTts.hold = hold;
      harness.socket.push('{"type":"sentence","text":"Second.","index":1}');
      await settle();

      harness.socket.push(
        '{"type":"done","text":"You have two meetings. Second."}',
      );
      await settle();

      expect(
        harness.state.phase,
        VoiceRealtimePhase.speaking,
        reason: 'the committed reply is still being read out',
      );
      expect(harness.state.commits.last.text, 'You have two meetings. Second.');

      hold.complete();
      harness.deviceTts.hold = null;
      await settle();
      expect(harness.state.phase, VoiceRealtimePhase.listening);
    });

    test('cancelling a device-spoken reply stops the device voice', () async {
      await reachCloudTtsFailure();
      final stopsBefore = harness.deviceTts.stops;

      await harness.controller.cancel();
      await settle();

      expect(harness.deviceTts.stops, greaterThan(stopsBefore));
      expect(harness.state.speechSource, VoiceSpeechSource.cloud);
    });

    test('barging in stops the device voice', () async {
      await reachCloudTtsFailure();
      final stopsBefore = harness.deviceTts.stops;

      // A new turn is the barge-in gesture.
      await harness.controller.startTurn(language: 'en');
      await settle();

      expect(harness.deviceTts.stops, greaterThan(stopsBefore));
    });

    test('disposing the controller stops the device voice', () async {
      await reachCloudTtsFailure();
      final stopsBefore = harness.deviceTts.stops;

      await harness.dispose();

      expect(harness.deviceTts.stops, greaterThan(stopsBefore));
    });
  });
}
