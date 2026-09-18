import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/voice/voice_protocol.dart';

/// Decoding is verified against synthetic frames rather than a live socket, so
/// the client half of the frozen protocol is pinned while the server is built.
void main() {
  const decoder = VoiceProtocolDecoder();
  const encoder = VoiceProtocolEncoder();

  group('VoiceProtocolDecoder', () {
    test('decodes every documented server event', () {
      expect(decoder.decode('{"type":"ready"}'), isA<VoiceReadyEvent>());

      final partial = decoder.decode('{"type":"partial","text":"vanak"}');
      expect(partial, isA<VoicePartialEvent>());
      expect((partial as VoicePartialEvent).text, 'vanak');

      final finalTurn = decoder.decode('{"type":"final","text":"vanakkam"}');
      expect(finalTurn, isA<VoiceFinalEvent>());
      expect((finalTurn as VoiceFinalEvent).text, 'vanakkam');

      final token = decoder.decode('{"type":"token","text":"Hi"}');
      expect(token, isA<VoiceTokenEvent>());
      expect((token as VoiceTokenEvent).text, 'Hi');

      final sentence = decoder.decode(
        '{"type":"sentence","text":"Hello.","index":3}',
      );
      expect(sentence, isA<VoiceSentenceEvent>());
      expect((sentence as VoiceSentenceEvent).text, 'Hello.');
      expect(sentence.index, 3);

      final speaking = decoder.decode('{"type":"speaking","value":true}');
      expect(speaking, isA<VoiceSpeakingEvent>());
      expect((speaking as VoiceSpeakingEvent).value, isTrue);

      final done = decoder.decode('{"type":"done","text":"Full reply"}');
      expect(done, isA<VoiceDoneEvent>());
      expect((done as VoiceDoneEvent).text, 'Full reply');

      final error = decoder.decode(
        '{"type":"error","code":"stt_failed","message":"nope"}',
      );
      expect(error, isA<VoiceServerErrorEvent>());
      expect((error as VoiceServerErrorEvent).code, 'stt_failed');
      expect(error.message, 'nope');
    });

    test('binary frames become audio events with the same bytes', () {
      final bytes = Uint8List.fromList(<int>[1, 2, 3, 250]);
      final event = decoder.decode(bytes);
      expect(event, isA<VoiceAudioEvent>());
      expect((event as VoiceAudioEvent).bytes, bytes);

      final asList = decoder.decode(<int>[4, 5, 6]);
      expect(asList, isA<VoiceAudioEvent>());
      expect((asList as VoiceAudioEvent).bytes, <int>[4, 5, 6]);
    });

    test('missing text and index fall back to safe defaults', () {
      expect((decoder.decode('{"type":"partial"}') as VoicePartialEvent).text, '');
      expect((decoder.decode('{"type":"sentence"}') as VoiceSentenceEvent).text, '');
      expect((decoder.decode('{"type":"sentence"}') as VoiceSentenceEvent).index, 0);
      expect(
        (decoder.decode('{"type":"speaking"}') as VoiceSpeakingEvent).value,
        isFalse,
      );
    });

    test('an unknown type is surfaced, not treated as an error', () {
      final event = decoder.decode('{"type":"avatar_blink"}');
      expect(event, isA<VoiceUnknownEvent>());
      expect((event as VoiceUnknownEvent).type, 'avatar_blink');
    });

    test('malformed frames throw VoiceProtocolException', () {
      expect(() => decoder.decode('not json'), throwsA(isA<VoiceProtocolException>()));
      expect(() => decoder.decode('[1,2,3]'), throwsA(isA<VoiceProtocolException>()));
      expect(() => decoder.decode(42), throwsA(isA<VoiceProtocolException>()));
      expect(() => decoder.decode(null), throwsA(isA<VoiceProtocolException>()));
    });
  });

  group('VoiceProtocolEncoder', () {
    test('writes exactly the frozen wire shapes', () {
      expect(
        jsonDecode(encoder.start(language: 'ta')),
        <String, dynamic>{'type': 'start', 'language': 'ta'},
      );
      expect(jsonDecode(encoder.stop()), <String, dynamic>{'type': 'stop'});
      expect(jsonDecode(encoder.cancel()), <String, dynamic>{'type': 'cancel'});
      expect(
        jsonDecode(encoder.text('hello')),
        <String, dynamic>{'type': 'text', 'text': 'hello'},
      );
    });
  });

  group('normalizeVoiceLanguage', () {
    test('passes through the protocol codes', () {
      expect(normalizeVoiceLanguage('en'), 'en');
      expect(normalizeVoiceLanguage('ta'), 'ta');
      expect(normalizeVoiceLanguage('hi'), 'hi');
      expect(normalizeVoiceLanguage('auto'), 'auto');
    });

    test('maps app-only policies and junk onto auto', () {
      // `tanglish` is a persona setting with no wire code.
      expect(normalizeVoiceLanguage('tanglish'), 'auto');
      expect(normalizeVoiceLanguage('TA'), 'ta');
      expect(normalizeVoiceLanguage(null), 'auto');
      expect(normalizeVoiceLanguage('  '), 'auto');
      expect(normalizeVoiceLanguage('klingon'), 'auto');
    });
  });
}
