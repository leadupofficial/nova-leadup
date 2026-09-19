import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nova_mobile/core/api/nova_api.dart';
import 'package:nova_mobile/features/recording/meeting_recorder.dart';
import 'package:nova_mobile/features/recording/recording_controller.dart';
import 'package:nova_mobile/services/network_service.dart';

import '../helpers/fake_meeting_recorder.dart';
import '../helpers/test_harness.dart';

/// The recorder's screen state machine.
///
/// The network is a scripted adapter and the microphone a fake recorder, so what
/// is asserted here is the sequence and the honesty of it: consent before a row,
/// a row before audio, retry-on-failure only, and never a claim that audio was
/// stored when the server refused it.
void main() {
  late List<RequestOptions> captured;

  /// A [NetworkService] with retries disabled, so a scripted 503 fails at once
  /// instead of sleeping through the backoff in a unit test.
  NetworkService fastNetwork(FakeHttpAdapter adapter) => NetworkService(
    dio: Dio(BaseOptions(baseUrl: 'https://api.test.invalid'))
      ..httpClientAdapter = adapter,
    networkInfo: FakeNetworkInfoService(),
    retryConfig: const RetryConfig(maxAttempts: 1),
  );

  FakeHttpAdapter recordingAdapter({
    int uploadStatus = 200,
    int processStatus = 202,
    Duration uploadDelay = Duration.zero,
  }) {
    return FakeHttpAdapter((RequestOptions options) async {
      captured.add(options);
      final path = options.path;
      if (path.endsWith('/audio')) {
        if (uploadDelay > Duration.zero) await Future<void>.delayed(uploadDelay);
        if (uploadStatus >= 400) {
          return jsonResponse(
            <String, dynamic>{
              'success': false,
              'error': 'Object storage is unavailable',
            },
            statusCode: uploadStatus,
          );
        }
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'recording': <String, dynamic>{
              'id': 'rec-1',
              'title': 'Meeting',
              'status': 'uploaded',
            },
            'storage': <String, dynamic>{
              'objectStorage': true,
              'key': 'recordings/rec-1.wav',
              'bytes': 4,
              'checksum': 'abc',
            },
          },
        });
      }
      if (path.endsWith('/process')) {
        if (processStatus >= 400) {
          return jsonResponse(
            <String, dynamic>{'success': false, 'error': 'No audio was uploaded'},
            statusCode: processStatus,
          );
        }
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'recordingId': 'rec-1',
            'status': 'processing',
          },
        }, statusCode: 202);
      }
      if (options.method == 'PATCH') {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'id': 'rec-1',
            'title': 'Meeting',
            'status': 'completed',
            'durationSeconds': options.data is Map
                ? (options.data as Map)['durationSeconds']
                : 0,
          },
        });
      }
      if (options.method == 'POST') {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'id': 'rec-1',
            'title': 'Meeting',
            'status': 'recording',
          },
        }, statusCode: 201);
      }
      return jsonResponse(<String, dynamic>{'success': true, 'data': null});
    });
  }

  ProviderContainer containerFor(FakeHttpAdapter adapter) {
    final container = ProviderContainer(
      overrides: [
        novaApiProvider.overrideWithValue(NovaApi(fastNetwork(adapter))),
        meetingRecorderProvider.overrideWithValue(
          fakeMeetingRecorder(recorder: FakeAudioRecorder()),
        ),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  RequestOptions? requestFor(String suffix) {
    for (final r in captured.reversed) {
      if (r.path.endsWith(suffix)) return r;
    }
    return null;
  }

  setUp(() => captured = <RequestOptions>[]);

  test('does nothing until consent is acknowledged', () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);

    final started = await controller.start(title: 'Standup');

    expect(started, isFalse);
    expect(captured, isEmpty);
    expect(controller.state.phase, RecordingPhase.consent);
    expect(controller.state.error, contains('Acknowledge'));
  });

  test('start writes the consent record, opens the mic and runs', () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);

    final started = await controller.start(title: 'Standup');

    expect(started, isTrue);
    expect(controller.state.phase, RecordingPhase.recording);
    expect(controller.state.recordingId, 'rec-1');

    final create = requestFor('/recordings');
    final body = create!.data as Map<String, dynamic>;
    expect(body['title'], 'Standup');
    expect(body['consentRecorded'], isTrue);
    await controller.discard();
  });

  test('stop uploads raw bytes with the container type, then processes',
      () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.start(title: 'Standup');

    final id = await controller.stop();

    expect(id, 'rec-1');
    expect(controller.state.phase, RecordingPhase.processing);

    final patch = requestFor('/recordings/rec-1');
    if (patch == null || patch.method != 'PATCH') {
      fail('expected a PATCH of the recording row');
    }
    final patchBody = patch.data as Map<String, dynamic>;
    expect(patchBody['status'], 'completed');
    expect(patchBody.containsKey('durationSeconds'), isTrue);

    final upload = requestFor('/audio');
    expect(upload, isNotNull);
    expect(upload!.method, 'POST');
    // Raw bytes, not base64 and not multipart.
    expect(upload.data, isA<List<int>>());
    expect((upload.data as List<int>), <int>[1, 2, 3, 4]);
    expect(upload.headers['Content-Type'], 'audio/wav');
    expect(upload.queryParameters['durationSeconds'], isNotNull);
    expect(upload.queryParameters.containsKey('language'), isFalse);

    expect(requestFor('/process')?.method, 'POST');
  });

  test('a failed upload is stated plainly and keeps the row', () async {
    final container = containerFor(recordingAdapter(uploadStatus: 503));
    final controller = container.read(recordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.start();

    final id = await controller.stop();

    expect(id, isNull);
    expect(controller.state.phase, RecordingPhase.failed);
    expect(controller.state.recordingId, 'rec-1');
    expect(controller.state.error, contains('not on the server'));
    // It must not claim the audio was stored.
    expect(controller.state.storedInObjectStorage, isNot(true));
  });

  test('a process failure says the audio was saved', () async {
    final container = containerFor(recordingAdapter(processStatus: 409));
    final controller = container.read(recordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.start();

    final id = await controller.stop();

    expect(id, isNull);
    expect(controller.state.phase, RecordingPhase.failed);
    expect(controller.state.error, contains('audio was saved'));
  });

  test('the timer runs while recording and stops while paused', () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.start();

    await Future<void>.delayed(const Duration(milliseconds: 1100));
    expect(controller.state.elapsedSeconds, greaterThanOrEqualTo(1));

    await controller.pause();
    expect(controller.state.phase, RecordingPhase.paused);
    final atPause = controller.state.elapsedSeconds;
    await Future<void>.delayed(const Duration(milliseconds: 1200));
    expect(
      controller.state.elapsedSeconds,
      atPause,
      reason: 'paused must not tick',
    );

    await controller.resume();
    await Future<void>.delayed(const Duration(milliseconds: 1100));
    expect(controller.state.elapsedSeconds, greaterThan(atPause));

    await controller.discard();
  });

  test('the voice path refuses start without consent', () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);

    final refused = await controller.startFromVoice(consentAcknowledged: false);
    expect(refused.ok, isFalse);
    expect(captured, isEmpty);

    final started = await controller.startFromVoice(consentAcknowledged: true);
    expect(started.ok, isTrue);
    expect(started.route, '/tasks/record');
    expect(controller.state.phase, RecordingPhase.recording);

    final stopped = await controller.stopFromVoice();
    expect(stopped.ok, isTrue);
    expect(stopped.route, '/recordings/rec-1');
  });

  test('stopFromVoice reports when nothing is running', () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);

    final result = await controller.stopFromVoice();
    expect(result.ok, isFalse);
    expect(result.message, contains('No recording'));
  });

  test('prepareNewSession leaves an active session alone', () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.start();

    controller.prepareNewSession();

    expect(controller.state.phase, RecordingPhase.recording,
        reason: 'a voice-started session must survive navigation');
    await controller.discard();
  });

  test('prepareNewSession resets to consent and clears the acknowledgement',
      () async {
    final container = containerFor(recordingAdapter());
    final controller = container.read(recordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);

    controller.prepareNewSession();

    expect(controller.state.phase, RecordingPhase.consent);
    expect(controller.state.consentAcknowledged, isFalse);
  });
}
