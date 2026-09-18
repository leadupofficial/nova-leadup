import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/voice/device_tts.dart';
import 'package:nova_mobile/core/voice/voice_realtime_state.dart';

import 'voice_realtime_test_support.dart';

void main() {
  group('resolveDeviceLanguageTag', () {
    test('maps a fixed language policy to a BCP-47 tag', () {
      expect(resolveDeviceLanguageTag(languagePolicy: 'en', text: ''), 'en-IN');
      expect(resolveDeviceLanguageTag(languagePolicy: 'ta', text: ''), 'ta-IN');
      expect(resolveDeviceLanguageTag(languagePolicy: 'hi', text: ''), 'hi-IN');
      // The policy values come from shared preferences, so case/space must not
      // decide whether the device voice is used.
      expect(
        resolveDeviceLanguageTag(languagePolicy: ' TA ', text: ''),
        'ta-IN',
      );
    });

    test('auto follows the script the reply is actually written in', () {
      expect(
        resolveDeviceLanguageTag(languagePolicy: 'auto', text: 'வணக்கம்'),
        'ta-IN',
      );
      expect(
        resolveDeviceLanguageTag(languagePolicy: 'auto', text: 'नमस्ते'),
        'hi-IN',
      );
      // Latin text carries no script signal: the honest answer is the device
      // default, not a guess at English.
      expect(
        resolveDeviceLanguageTag(languagePolicy: 'auto', text: 'hello there'),
        isNull,
      );
    });

    test('tanglish and unknown policies fall back to the reply script', () {
      expect(
        resolveDeviceLanguageTag(
          languagePolicy: 'tanglish',
          text: 'epdi iruka',
        ),
        isNull,
      );
      expect(
        resolveDeviceLanguageTag(languagePolicy: 'tanglish', text: 'நலம்'),
        'ta-IN',
      );
      expect(resolveDeviceLanguageTag(languagePolicy: null, text: ''), isNull);
      expect(resolveDeviceLanguageTag(languagePolicy: '', text: ''), isNull);
    });
  });

  group('DeviceSpeechQueue', () {
    test('speaks utterances one at a time, in order', () async {
      final tts = FakeDeviceTts();
      final queue = DeviceSpeechQueue(tts);
      queue.enableDevice();

      queue.record('One.', languageTag: 'en-IN');
      queue.record('Two.', languageTag: 'en-IN');
      queue.record('Three.', languageTag: 'en-IN');
      await Future<void>.delayed(Duration.zero);

      expect(tts.spoken, <String>['One.', 'Two.', 'Three.']);
      await queue.stop();
    });

    test(
      'replays sentences recorded before the fallback was enabled',
      () async {
        final tts = FakeDeviceTts();
        final queue = DeviceSpeechQueue(tts);

        // The server sends the first sentence before synthesis fails.
        queue.record('First.', languageTag: 'en-IN');
        expect(tts.spoken, isEmpty);

        queue.enableDevice();
        await Future<void>.delayed(Duration.zero);

        expect(tts.spoken, <String>['First.']);
        await queue.stop();
      },
    );

    test('reports a language the device has no voice for', () async {
      final tts = FakeDeviceTts(unsupported: {'ta-IN'});
      final queue = DeviceSpeechQueue(tts);
      queue.enableDevice();

      queue.record('வணக்கம்.', languageTag: 'ta-IN');
      await Future<void>.delayed(Duration.zero);

      expect(
        tts.spoken,
        isEmpty,
        reason: 'nothing must be spoken in a voice the device does not have',
      );
      expect(queue.source, VoiceSpeechSource.deviceUnavailable);
      expect(queue.languageTag, 'ta-IN');
      expect(queue.notice, contains('ta-IN'));
      await queue.stop();
    });

    test(
      'stop drops the backlog instead of leaking it into the next turn',
      () async {
        final tts = FakeDeviceTts();
        final queue = DeviceSpeechQueue(tts);
        queue.enableDevice();

        queue.record('One.', languageTag: 'en-IN');
        await queue.stop();
        queue.record('Two.', languageTag: 'en-IN');
        await Future<void>.delayed(Duration.zero);

        // `One` was dropped by the stop; `Two` was recorded after it and is the
        // only thing that may be heard.
        expect(tts.spoken, <String>['Two.']);
        await queue.stop();
      },
    );

    test('resetTurn forgets the previous turn and its notice', () async {
      final tts = FakeDeviceTts(unsupported: {'ta-IN'});
      final queue = DeviceSpeechQueue(tts);
      queue.enableDevice();
      queue.record('வணக்கம்.', languageTag: 'ta-IN');
      await Future<void>.delayed(Duration.zero);
      expect(queue.source, VoiceSpeechSource.deviceUnavailable);

      queue.resetTurn();

      expect(queue.isDeviceEnabled, isFalse);
      expect(queue.source, VoiceSpeechSource.cloud);
      expect(queue.languageTag, isNull);
      expect(queue.notice, isNull);
    });
  });
}
