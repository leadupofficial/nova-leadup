import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:record/record.dart';

import 'package:nova_mobile/core/voice/voice_capture.dart'
    show VoiceCaptureException, VoiceCaptureFailure, VoiceMicPermission;

import '../helpers/fake_meeting_recorder.dart';

/// The meeting capture service, exercised with a fake `record` plugin.
///
/// Nothing here opens a microphone. What is pinned: the 16 kHz mono WAV
/// preference (and the AAC fallback), genuine pause/resume, the dBFS→0..1 level
/// mapping, and the stop byte contract — including that the temp file is only
/// removed once its bytes are in memory.
void main() {
  test('a denied permission refuses before the recorder is touched', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(
      recorder: fake,
      permission: VoiceMicPermission.denied,
    );
    addTearDown(recorder.dispose);

    await expectLater(
      recorder.start(),
      throwsA(
        isA<VoiceCaptureException>().having(
          (e) => e.failure,
          'failure',
          VoiceCaptureFailure.permissionDenied,
        ),
      ),
    );
    expect(fake.started, isFalse);
  });

  test('records 16 kHz mono WAV when the platform supports it', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await recorder.start();

    expect(fake.lastConfig!.encoder, AudioEncoder.wav);
    expect(fake.lastConfig!.sampleRate, 16000);
    expect(fake.lastConfig!.numChannels, 1);
    expect(fake.lastPath, endsWith('.wav'));
    expect(recorder.isRecording, isTrue);

    final clip = await recorder.stop();
    expect(clip.mimeType, 'audio/wav');
  });

  test('falls back to AAC-LC when WAV cannot be encoded', () async {
    final fake = FakeAudioRecorder(
      supportedEncoders: const <AudioEncoder>{AudioEncoder.aacLc},
    );
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await recorder.start();
    expect(fake.lastConfig!.encoder, AudioEncoder.aacLc);
    expect(fake.lastPath, endsWith('.m4a'));

    final clip = await recorder.stop();
    expect(clip.mimeType, 'audio/mp4');
  });

  test('maps dBFS onto 0..1 for the live waveform', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    final levels = <double>[];
    final sub = recorder.levels.listen(levels.add);
    addTearDown(sub.cancel);

    await recorder.start();
    fake.emitAmplitude(-60);
    fake.emitAmplitude(0);
    fake.emitAmplitude(-30);
    await Future<void>.delayed(Duration.zero);

    expect(levels, hasLength(3));
    expect(levels[0], 0.0);
    expect(levels[1], 1.0);
    expect(levels[2], closeTo(0.5, 0.0001));
    await recorder.stop();
  });

  test('pause and resume genuinely reach the platform', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await recorder.start();
    expect(recorder.isPaused, isFalse);

    await recorder.pause();
    expect(recorder.isPaused, isTrue);
    expect(fake.paused, isTrue);
    expect(fake.pauseCalls, 1);

    await recorder.resume();
    expect(recorder.isPaused, isFalse);
    expect(fake.paused, isFalse);
    expect(fake.resumeCalls, 1);

    // Not recording is a no-op rather than an error.
    await recorder.stop();
    await recorder.pause();
    expect(fake.pauseCalls, 1);
    await recorder.resume();
    expect(fake.resumeCalls, 1);
  });

  test('no level is published while paused', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    final levels = <double>[];
    final sub = recorder.levels.listen(levels.add);
    addTearDown(sub.cancel);

    await recorder.start();
    await recorder.pause();
    fake.emitAmplitude(0);
    await Future<void>.delayed(Duration.zero);

    expect(levels, isEmpty);
    await recorder.cancel();
  });

  test('stop returns the bytes and only then deletes the temp file', () async {
    final fake = FakeAudioRecorder(bytes: const <int>[9, 8, 7, 6, 5]);
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await recorder.start();
    final path = fake.lastPath!;
    expect(File(path).existsSync(), isTrue);

    final clip = await recorder.stop();

    expect(clip.bytes, <int>[9, 8, 7, 6, 5]);
    expect(clip.byteLength, 5);
    expect(clip.mimeType, 'audio/wav');
    expect(recorder.isRecording, isFalse);
    // Deleted after the read, never before it.
    expect(File(path).existsSync(), isFalse);
  });

  test('an empty capture is a failure, not a zero-byte upload', () async {
    final fake = FakeAudioRecorder(bytes: const <int>[]);
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await recorder.start();
    await expectLater(
      recorder.stop(),
      throwsA(
        isA<VoiceCaptureException>().having(
          (e) => e.failure,
          'failure',
          VoiceCaptureFailure.emptyRecording,
        ),
      ),
    );
  });

  test('cancel discards the file without returning bytes', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await recorder.start();
    final path = fake.lastPath!;
    await recorder.cancel();

    expect(recorder.isRecording, isFalse);
    expect(fake.cancelCalls, 1);
    expect(File(path).existsSync(), isFalse);
    await expectLater(recorder.stop(), throwsA(isA<VoiceCaptureException>()));
  });

  test('a meeting is not capped at two minutes', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await recorder.start();
    await Future<void>.delayed(const Duration(milliseconds: 60));

    // Nothing stopped it: the only way to end a meeting recording is stop().
    expect(recorder.isRecording, isTrue);
    expect(fake.stopCalls, 0);
    await recorder.stop();
  });

  test('start refuses a second session and stop refuses an empty one', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    addTearDown(recorder.dispose);

    await expectLater(recorder.stop(), throwsA(isA<VoiceCaptureException>()));
    await recorder.start();
    await expectLater(recorder.start(), throwsA(isA<VoiceCaptureException>()));
    await recorder.stop();
  });

  test('dispose releases the recorder and is idempotent', () async {
    final fake = FakeAudioRecorder();
    final recorder = fakeMeetingRecorder(recorder: fake);
    await recorder.start();
    await recorder.dispose();
    await recorder.dispose();

    expect(fake.disposed, isTrue);
    await expectLater(recorder.start(), throwsA(isA<VoiceCaptureException>()));
  });
}
