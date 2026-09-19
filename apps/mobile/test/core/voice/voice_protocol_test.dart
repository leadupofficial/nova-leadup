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

    test('decodes the recogniser fallback notice', () {
      // The server says which recogniser actually served the turn; the client
      // used to drop this on the floor, so a fallback turn looked identical to
      // one that used the provider the language nominally selects.
      final event = decoder.decode(
        '{"type":"stt","provider":"deepgram","fallback":true,'
        '"reason":"sarvam closed the stream (1003): Credits exhausted."}',
      );
      expect(event, isA<VoiceSttFallbackEvent>());
      final fallback = event as VoiceSttFallbackEvent;
      expect(fallback.provider, 'deepgram');
      expect(fallback.fallback, isTrue);
      expect(fallback.reason, contains('Credits exhausted'));
    });

    test('decodes the voice fallback notice', () {
      final event = decoder.decode(
        '{"type":"tts","provider":"deepgram","fallback":true,"reason":"TTS provider failed (402)"}',
      );
      expect(event, isA<VoiceTtsFallbackEvent>());
      final fallback = event as VoiceTtsFallbackEvent;
      expect(fallback.provider, 'deepgram');
      expect(fallback.fallback, isTrue);
    });

    test('decodes the tool event', () {
      // The app has to know an action landed before the spoken reply finishes.
      final event = decoder.decode(
        '{"type":"tool","name":"create_reminder","ok":true,'
        '"summary":"Reminder set for Buy milk on Sun 20 Sept, 06:00 pm (Asia/Kolkata)."}',
      );
      expect(event, isA<VoiceToolEvent>());
      final tool = event as VoiceToolEvent;
      expect(tool.name, 'create_reminder');
      expect(tool.ok, isTrue);
      expect(tool.summary, contains('Buy milk'));
      expect(tool.summary, contains('06:00 pm'));
    });

    test('a failed tool event is still decoded', () {
      final event = decoder.decode(
        '{"type":"tool","name":"create_task","ok":false,"summary":"Could not create task."}',
      );
      expect((event as VoiceToolEvent).ok, isFalse);
    });

    test('a tool event carries why the approval gate stopped it', () {
      // "Not run because you said no" must be distinguishable from "the tool
      // failed", or the app reports a fault where the user made a choice.
      for (final (wire, expected) in <(String, VoiceApprovalOutcome)>[
        ('rejected', VoiceApprovalOutcome.rejected),
        ('timeout', VoiceApprovalOutcome.timeout),
        ('cancelled', VoiceApprovalOutcome.cancelled),
        ('payload_mismatch', VoiceApprovalOutcome.payloadMismatch),
        ('unbound', VoiceApprovalOutcome.unbound),
      ]) {
        final event =
            decoder.decode(
                  '{"type":"tool","name":"create_reminder","ok":false,'
                  '"summary":"Not run.","approval":"$wire"}',
                )
                as VoiceToolEvent;
        expect(event.approval, expected, reason: 'wire value $wire');
      }

      final granted =
          decoder.decode('{"type":"tool","name":"create_reminder","ok":true,"summary":"Done."}')
              as VoiceToolEvent;
      expect(granted.approval, isNull);
    });

    test('an unknown approval reason is ignored rather than guessed', () {
      final event =
          decoder.decode(
                '{"type":"tool","name":"create_reminder","ok":false,'
                '"summary":"?","approval":"something_new"}',
              )
              as VoiceToolEvent;
      expect(event.approval, isNull);
    });

    test('decodes the approval request the sheet is built from', () {
      // §5.7: the sheet must show exactly what will happen. Every field it
      // renders therefore has to survive decoding, including the payload.
      final event = decoder.decode(
        '{"type":"approval_request","approvalId":"appr-7","turnId":4,'
        '"tool":"create_reminder","level":1,'
        '"summary":"Create a reminder \\"Call the bank\\" that goes off at 2026-09-19T17:00:00+05:30.",'
        '"input":{"title":"Call the bank","trigger_at":"2026-09-19T17:00:00+05:30"},'
        '"expiresAt":"2026-09-19T08:00:00.000Z"}',
      );
      expect(event, isA<VoiceApprovalRequestEvent>());
      final request = event as VoiceApprovalRequestEvent;
      expect(request.approvalId, 'appr-7');
      expect(request.turnId, 4);
      expect(request.tool, 'create_reminder');
      expect(request.level, 1);
      expect(request.summary, contains('Call the bank'));
      expect(request.input['title'], 'Call the bank');
      expect(request.input['trigger_at'], '2026-09-19T17:00:00+05:30');
      expect(request.expiresAt, DateTime.utc(2026, 9, 19, 8));
    });

    test('an approval request missing its optional fields still decodes', () {
      final event =
          decoder.decode('{"type":"approval_request"}')
              as VoiceApprovalRequestEvent;
      expect(event.approvalId, '');
      expect(event.tool, 'unknown');
      expect(event.input, isEmpty);
      expect(event.expiresAt, isNull);
    });

    test('a malformed input payload becomes empty rather than throwing', () {
      // A malformed frame must not take down the turn: the sheet can render an
      // action with no parameters, and the user can still deny it.
      final event =
          decoder.decode('{"type":"approval_request","input":"not-a-map"}')
              as VoiceApprovalRequestEvent;
      expect(event.input, isEmpty);
    });

    test('the decoded input is a copy, not a view of the frame', () {
      final event =
          decoder.decode('{"type":"approval_request","input":{"a":1}}')
              as VoiceApprovalRequestEvent;
      event.input['a'] = 2;
      expect(event.input['a'], 2);
    });

    test('a fallback notice with missing fields does not throw', () {
      final event = decoder.decode('{"type":"tts"}');
      expect(event, isA<VoiceTtsFallbackEvent>());
      expect((event as VoiceTtsFallbackEvent).provider, 'unknown');
      expect(event.fallback, isFalse);
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

    test('writes the approval answer with the id it is answering', () {
      // The id is what stops an answer being paired with a later request.
      expect(
        jsonDecode(
          encoder.approvalResponse(approvalId: 'appr-7', approve: true),
        ),
        <String, dynamic>{
          'type': 'approval_response',
          'approvalId': 'appr-7',
          'approve': true,
        },
      );
      expect(
        jsonDecode(
          encoder.approvalResponse(approvalId: 'appr-7', approve: false),
        ),
        <String, dynamic>{
          'type': 'approval_response',
          'approvalId': 'appr-7',
          'approve': false,
        },
      );
    });

    test('echoes the turn when the request carried one', () {
      expect(
        jsonDecode(
          encoder.approvalResponse(
            approvalId: 'appr-7',
            approve: true,
            turnId: 4,
          ),
        ),
        <String, dynamic>{
          'type': 'approval_response',
          'approvalId': 'appr-7',
          'approve': true,
          'turnId': 4,
        },
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
