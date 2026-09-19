import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:record/record.dart';

import 'package:nova_mobile/core/voice/voice_capture.dart' show VoiceMicPermission;
import 'package:nova_mobile/features/recording/meeting_recorder.dart';

/// A scriptable `record` plugin for the meeting recorder.
///
/// `AudioRecorder` is a concrete class, so this `implements` it and overrides
/// only what the recorder touches; every other member would throw through
/// [Fake], which is exactly what a test wants. [start] writes real bytes to the
/// path it is given so `MeetingRecorder.stop()` exercises the genuine
/// file-read path with no microphone and no platform channel.
class FakeAudioRecorder extends Fake implements AudioRecorder {
  FakeAudioRecorder({
    this.bytes = const <int>[1, 2, 3, 4],
    this.supportedEncoders = const <AudioEncoder>{
      AudioEncoder.wav,
      AudioEncoder.aacLc,
    },
    this.devices = const <InputDevice>[
      InputDevice(id: 'default', label: 'Fake microphone'),
    ],
  });

  /// What `start` writes and `stop` therefore yields.
  final List<int> bytes;
  final Set<AudioEncoder> supportedEncoders;
  final List<InputDevice> devices;

  RecordConfig? lastConfig;
  String? lastPath;
  bool started = false;
  bool paused = false;
  bool disposed = false;

  int pauseCalls = 0;
  int resumeCalls = 0;
  int stopCalls = 0;
  int cancelCalls = 0;

  final StreamController<Amplitude> _amplitudes =
      StreamController<Amplitude>.broadcast();

  /// Pushes one dBFS reading through the level stream.
  void emitAmplitude(double dbfs) {
    if (!_amplitudes.isClosed) {
      _amplitudes.add(Amplitude(current: dbfs, max: dbfs));
    }
  }

  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    lastConfig = config;
    lastPath = path;
    started = true;
    paused = false;
    await File(path).writeAsBytes(bytes);
  }

  @override
  Future<String?> stop() async {
    stopCalls++;
    return lastPath;
  }

  @override
  Future<void> pause() async {
    pauseCalls++;
    paused = true;
  }

  @override
  Future<void> resume() async {
    resumeCalls++;
    paused = false;
  }

  @override
  Future<void> cancel() async {
    cancelCalls++;
    final path = lastPath;
    if (path != null) {
      final file = File(path);
      if (file.existsSync()) file.deleteSync();
    }
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    await _amplitudes.close();
  }

  @override
  Future<bool> isEncoderSupported(AudioEncoder encoder) async =>
      supportedEncoders.contains(encoder);

  @override
  Future<List<InputDevice>> listInputDevices() async => devices;

  @override
  Stream<Amplitude> onAmplitudeChanged(Duration interval) => _amplitudes.stream;
}

/// Builds a real [MeetingRecorder] wired to [FakeAudioRecorder] and a real temp
/// directory, so nothing in a recorder test touches a microphone.
MeetingRecorder fakeMeetingRecorder({
  FakeAudioRecorder? recorder,
  VoiceMicPermission permission = VoiceMicPermission.granted,
  Directory? temporaryDirectory,
}) {
  final fake = recorder ?? FakeAudioRecorder();
  final directory =
      temporaryDirectory ??
      Directory.systemTemp.createTempSync('nova_meeting_test_');
  return MeetingRecorder(
    () async => permission,
    recorderFactory: () => fake,
    temporaryDirectory: () async => directory,
  );
}
