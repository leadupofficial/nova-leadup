import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nova_mobile/core/api/nova_api.dart';

import '../helpers/test_harness.dart';

/// Wire-format pins for the recording pipeline.
///
/// The audio route takes the raw bytes with the container MIME type in
/// `Content-Type` — not base64 and not multipart — and a refusal must surface as
/// a [NovaApiException] carrying the status and the server's own words, so the
/// screen can say the audio was not stored rather than claim it was.
void main() {
  late List<RequestOptions> captured;

  NovaApi apiWith(FakeHttpAdapter adapter) =>
      NovaApi(fakeNetworkService(adapter));

  setUp(() => captured = <RequestOptions>[]);

  test('uploads the raw bytes with the container type and query hints',
      () async {
    final api = apiWith(
      FakeHttpAdapter((options) async {
        captured.add(options);
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'recording': <String, dynamic>{'id': 'rec-1', 'title': 'x'},
            'storage': <String, dynamic>{
              'objectStorage': true,
              'key': 'recordings/rec-1.wav',
              'bytes': 4,
              'checksum': 'abc',
            },
          },
        });
      }),
    );

    final result = await api.uploadRecordingAudio(
      'rec-1',
      <int>[1, 2, 3, 4],
      'audio/wav',
      language: 'ta',
      durationSeconds: 95,
    );

    final options = captured.single;
    expect(options.method, 'POST');
    expect(options.path, endsWith('/recordings/rec-1/audio'));
    expect(options.data, isA<List<int>>());
    expect(options.headers['Content-Type'], 'audio/wav');
    expect(options.queryParameters['language'], 'ta');
    expect(options.queryParameters['durationSeconds'], 95);

    expect(result.storage.objectStorage, isTrue);
    expect(result.storage.key, 'recordings/rec-1.wav');
    expect(result.recording.id, 'rec-1');
  });

  test('a 413 is an exception with the status, not a success', () async {
    final api = apiWith(
      FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{
          'success': false,
          'error': 'Upload exceeds the 32 MB limit',
        }, statusCode: 413),
      ),
    );

    await expectLater(
      api.uploadRecordingAudio('rec-1', <int>[1], 'audio/wav'),
      throwsA(
        isA<NovaApiException>()
            .having((e) => e.statusCode, 'statusCode', 413)
            .having((e) => e.message, 'message', contains('32 MB')),
      ),
    );
  });

  test('a 503 STORAGE_UNAVAILABLE carries the server message', () async {
    final api = apiWith(
      FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{
          'success': false,
          'error': 'Object storage is not configured',
        }, statusCode: 503),
      ),
    );

    await expectLater(
      api.uploadRecordingAudio('rec-1', <int>[1], 'audio/wav'),
      throwsA(
        isA<NovaApiException>()
            .having((e) => e.statusCode, 'statusCode', 503)
            .having((e) => e.message, 'message', contains('not configured')),
      ),
    );
  });

  test('createRecording sends the consent flag', () async {
    final api = apiWith(
      FakeHttpAdapter((options) async {
        captured.add(options);
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'id': 'rec-1', 'title': 'Standup'},
        }, statusCode: 201);
      }),
    );

    await api.createRecording(
      title: 'Standup',
      language: 'en',
      consentRecorded: true,
    );

    final body = captured.single.data as Map<String, dynamic>;
    expect(body['consentRecorded'], isTrue);
    expect(body['language'], 'en');
  });

  test('getRecording parses the structured summary, transcript and segments',
      () async {
    final api = apiWith(
      FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'recording': <String, dynamic>{
              'id': 'rec-1',
              'title': 'Standup',
              'status': 'completed',
              'durationSeconds': 95,
            },
            'transcript': <String, dynamic>{
              'id': 'tr-1',
              'recordingId': 'rec-1',
              'fullText': 'We agreed to ship.',
              'language': 'en',
            },
            'summary': <String, dynamic>{
              'id': 'sum-1',
              'summary': 'A short standup.',
              'decisions': <dynamic>['Ship on Friday'],
              'actionItems': <dynamic>[
                <String, dynamic>{
                  'text': 'Send the deck',
                  'owner': 'Priya',
                  'dueDate': 'Friday',
                  'dueDateIso': '2026-01-09',
                },
              ],
              'extractedContacts': <dynamic>[
                <String, dynamic>{
                  'name': 'Kumar',
                  'detail': '+91 98765 43210',
                  'source': 'transcript',
                },
              ],
            },
            'segments': <dynamic>[
              <String, dynamic>{
                'id': 'seg-1',
                'speakerIndex': 0,
                'startMs': 0,
                'endMs': 1200,
                'text': 'We agreed to ship.',
                'confidence': 0.9,
              },
            ],
          },
        }),
      ),
    );

    final detail = await api.getRecording('rec-1');

    expect(detail.recording.status, 'completed');
    expect(detail.transcript, 'We agreed to ship.');
    expect(detail.summary!.actionItems.single.owner, 'Priya');
    expect(detail.summary!.actionItems.single.dueDate, 'Friday');
    expect(detail.summary!.extractedContacts.single.name, 'Kumar');
    expect(detail.segments.single.speakerIndex, 0);
    expect(detail.hasNothing, isFalse);
  });

  test('getRecordingCapabilities reports what the server can do', () async {
    final api = apiWith(
      FakeHttpAdapter(
        (options) async => jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'transcription': 'async',
            'diarisation': false,
            'objectStorage': true,
            'maxUploadBytes': 33554432,
            'reason': <String, dynamic>{'diarisation': 'not implemented'},
          },
        }),
      ),
    );

    final capabilities = await api.getRecordingCapabilities();

    expect(capabilities.transcription, 'async');
    expect(capabilities.canTranscribe, isTrue);
    // The capability table says there is no speaker attribution.
    expect(capabilities.diarisation, isFalse);
    expect(capabilities.objectStorage, isTrue);
    expect(capabilities.maxUploadBytes, 33554432);
  });

  test('processRecording posts to the process route', () async {
    final api = apiWith(
      FakeHttpAdapter((options) async {
        captured.add(options);
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'recordingId': 'rec-1',
            'status': 'processing',
          },
        }, statusCode: 202);
      }),
    );

    await api.processRecording('rec-1', language: 'ta');

    final options = captured.single;
    expect(options.path, endsWith('/recordings/rec-1/process'));
    expect((options.data as Map)['language'], 'ta');
  });
}
