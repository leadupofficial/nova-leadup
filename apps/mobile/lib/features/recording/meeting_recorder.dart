import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/permissions/permission_provider.dart';
// Reuses the capture seam `VoiceCapture` established — the injected permission
// requester, recorder factory and temp-directory lookup — so tests need no
// platform channel and there is one microphone-permission call site.
import '../../core/voice/voice_capture.dart'
    show
        MicPermissionRequester,
        RecorderFactory,
        TempDirectoryProvider,
        VoiceCapture,
        VoiceCaptureException,
        VoiceCaptureFailure,
        VoiceMicPermission;

/// Real microphone capture for meeting recordings (§5.11).
///
/// Deliberately a sibling of [VoiceCapture] (`lib/core/voice/voice_capture.dart`)
/// rather than a clone of the Converse loop, because the two have different
/// shapes:
///
///  * a meeting is long, so there is **no auto-stop cap** — the 2-minute limit
///    that protects the voice loop would cut a meeting off mid-sentence;
///  * a meeting can be **paused and resumed**, and the screen's timer stops
///    while it is paused, so the pause must genuinely stop the platform;
///  * the caller needs the raw bytes for `POST /recordings/:id/audio`, not
///    base64 for the STT route.
///
/// The permission requester, recorder factory and temp-directory lookup are all
/// injected, exactly as in [VoiceCapture], so tests exercise pause/resume/level
/// behaviour with a fake recorder and no platform channel and no microphone.
///
/// Recording is 16 kHz mono, which is what the speech-to-text providers want.
/// WAV is preferred for a lossless upload; when the platform cannot encode it
/// the encoder falls back to AAC-LC (an `.m4a`/`audio/mp4` container).
class MeetingRecorder {
  MeetingRecorder(
    this._requestPermission, {
    RecorderFactory? recorderFactory,
    TempDirectoryProvider? temporaryDirectory,
    this.amplitudeInterval = const Duration(milliseconds: 120),
  }) : _recorderFactory = recorderFactory ?? AudioRecorder.new,
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory;

  final MicPermissionRequester _requestPermission;
  final RecorderFactory _recorderFactory;
  final TempDirectoryProvider _temporaryDirectory;

  /// Sampling period for the live input level.
  final Duration amplitudeInterval;

  AudioRecorder? _recorder;
  String? _path;
  String _mimeType = 'audio/wav';
  StreamSubscription<Amplitude>? _amplitude;
  bool _recording = false;
  bool _paused = false;
  bool _disposed = false;

  final _levels = StreamController<double>.broadcast();

  /// Input loudness in `0..1` while recording (0 when the platform reports
  /// nothing usable). `record` reports dBFS, where 0 is full scale.
  Stream<double> get levels => _levels.stream;

  bool get isRecording => _recording;
  bool get isPaused => _recording && _paused;

  /// Requests permission and begins writing to a temp file. Throws
  /// [VoiceCaptureException] when the microphone cannot be used.
  Future<void> start() async {
    if (_disposed) {
      throw const VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'The recorder has already been disposed.',
      );
    }
    if (_recording) {
      throw const VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'A recording is already in progress.',
      );
    }

    await _assertPermission();
    final recorder = _ensureRecorder();
    await _assertInputDevice(recorder);
    final format = await _formatFor(recorder);

    final directory = await _temporaryDirectory();
    final path =
        '${directory.path}/nova_meeting_'
        '${DateTime.now().millisecondsSinceEpoch}${format.extension}';

    try {
      await recorder.start(format.config, path: path);
    } catch (error) {
      throw _startFailure(error);
    }

    _recording = true;
    _paused = false;
    _path = path;
    _mimeType = format.mimeType;
    _listenForLevel(recorder);
  }

  /// Pauses capture. The caller's timer stops too; no audio is written while
  /// paused. Safe to call when not recording or already paused.
  Future<void> pause() async {
    if (!_recording || _paused || _disposed) return;
    await _recorder?.pause();
    _paused = true;
  }

  /// Resumes capture after [pause]. Safe to call when not paused.
  Future<void> resume() async {
    if (!_recording || !_paused || _disposed) return;
    await _recorder?.resume();
    _paused = false;
  }

  /// Ends the session and returns the finished bytes.
  ///
  /// The temp file is only deleted **after** its bytes have been read into
  /// memory, so a read failure cannot destroy the only copy of the recording —
  /// in that case the file is left on disk and the error names its path.
  /// Throws [VoiceCaptureException] when the platform cannot stop, when nothing
  /// was captured, or when the file cannot be read back.
  Future<MeetingAudioClip> stop() async {
    if (!_recording) {
      throw const VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'There is no recording in progress to stop.',
      );
    }
    _recording = false;
    _paused = false;
    await _amplitude?.cancel();
    _amplitude = null;

    final recorder = _recorder;
    final startedPath = _path;
    _path = null;
    if (recorder == null) {
      throw const VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'The recorder was not available to stop.',
      );
    }

    String? stoppedPath;
    try {
      stoppedPath = await recorder.stop();
    } catch (error) {
      _deleteQuietly(startedPath);
      throw VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'Recording could not be stopped: $error',
        cause: error,
      );
    }

    final path = stoppedPath ?? startedPath;
    if (path == null) throw _emptyFailure();

    final Uint8List bytes;
    try {
      bytes = await File(path).readAsBytes();
    } catch (error) {
      // Keep the file: it is the only copy of the meeting.
      throw VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'The recording could not be read back from $path: $error',
        cause: error,
      );
    }
    _deleteQuietly(path);
    if (bytes.isEmpty) throw _emptyFailure();
    return MeetingAudioClip(bytes: bytes, mimeType: _mimeType);
  }

  /// Ends the session and discards the file without returning bytes.
  Future<void> cancel() async {
    await _amplitude?.cancel();
    _amplitude = null;
    _paused = false;

    if (!_recording) {
      _deleteQuietly(_path);
      _path = null;
      return;
    }
    _recording = false;

    final path = _path;
    _path = null;
    try {
      await _recorder?.cancel();
    } catch (error) {
      debugPrint('[MeetingRecorder] cancel failed: $error');
    }
    _deleteQuietly(path);
  }

  /// Releases the recorder. Idempotent.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await cancel();
    await _levels.close();
    final recorder = _recorder;
    _recorder = null;
    try {
      await recorder?.dispose();
    } catch (error) {
      debugPrint('[MeetingRecorder] dispose failed: $error');
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  AudioRecorder _ensureRecorder() => _recorder ??= _recorderFactory();

  Future<void> _assertPermission() async {
    final VoiceMicPermission permission;
    try {
      permission = await _requestPermission();
    } catch (error) {
      throw VoiceCaptureException(
        VoiceCaptureFailure.permissionDenied,
        'The microphone permission could not be requested: $error',
        cause: error,
      );
    }

    switch (permission) {
      case VoiceMicPermission.granted:
        return;
      case VoiceMicPermission.permanentlyDenied:
      case VoiceMicPermission.restricted:
        throw const VoiceCaptureException(
          VoiceCaptureFailure.permissionPermanentlyDenied,
          'Microphone access is blocked. Turn it on for NOVA in Settings.',
        );
      case VoiceMicPermission.denied:
        throw const VoiceCaptureException(
          VoiceCaptureFailure.permissionDenied,
          'NOVA needs microphone access to record this meeting.',
        );
    }
  }

  Future<void> _assertInputDevice(AudioRecorder recorder) async {
    try {
      final devices = await recorder.listInputDevices();
      if (devices.isEmpty) {
        throw const VoiceCaptureException(
          VoiceCaptureFailure.noMicrophone,
          'No microphone was found on this device.',
        );
      }
    } on VoiceCaptureException {
      rethrow;
    } catch (_) {
      // Device enumeration is not implemented everywhere; let start() decide.
    }
  }

  Future<({RecordConfig config, String extension, String mimeType})>
  _formatFor(AudioRecorder recorder) async {
    var encoder = AudioEncoder.wav;
    try {
      if (!await recorder.isEncoderSupported(AudioEncoder.wav)) {
        encoder = AudioEncoder.aacLc;
      }
    } catch (_) {
      // Treat an unimplemented capability probe as "WAV is fine"; if start()
      // then refuses the encoder the caller sees a real start failure.
    }
    return (
      config: RecordConfig(
        encoder: encoder,
        bitRate: 128000,
        sampleRate: 16000,
        numChannels: 1,
      ),
      extension: encoder == AudioEncoder.wav ? '.wav' : '.m4a',
      mimeType: encoder == AudioEncoder.wav ? 'audio/wav' : 'audio/mp4',
    );
  }

  void _listenForLevel(AudioRecorder recorder) {
    _amplitude = recorder
        .onAmplitudeChanged(amplitudeInterval)
        .listen(
          (amplitude) {
            if (_paused) return;
            _addLevel(amplitude.current);
          },
          onError: (Object error) =>
              debugPrint('[MeetingRecorder] amplitude error: $error'),
        );
  }

  void _addLevel(double dbfs) {
    if (_levels.isClosed) return;
    if (dbfs.isNaN || dbfs.isInfinite) {
      _levels.add(0);
      return;
    }
    // dBFS is <= 0 in practice; speech sits roughly between -60 and 0.
    _levels.add(((dbfs + 60) / 60).clamp(0.0, 1.0));
  }

  VoiceCaptureException _startFailure(Object error) {
    final text = error.toString().toLowerCase();
    if (text.contains('permission') ||
        text.contains('not authorized') ||
        text.contains('denied')) {
      return VoiceCaptureException(
        VoiceCaptureFailure.permissionDenied,
        'NOVA could not open the microphone: permission was denied.',
        cause: error,
      );
    }
    if (text.contains('device') ||
        text.contains('microphone') ||
        text.contains('input')) {
      return VoiceCaptureException(
        VoiceCaptureFailure.noMicrophone,
        'No usable microphone was found on this device.',
        cause: error,
      );
    }
    return VoiceCaptureException(
      VoiceCaptureFailure.recordingFailed,
      'Recording could not start: $error',
      cause: error,
    );
  }

  VoiceCaptureException _emptyFailure() => const VoiceCaptureException(
    VoiceCaptureFailure.emptyRecording,
    'Nothing was recorded. Check the microphone and try again.',
  );

  void _deleteQuietly(String? path) {
    if (path == null) return;
    try {
      final file = File(path);
      if (file.existsSync()) file.deleteSync();
    } catch (error) {
      debugPrint('[MeetingRecorder] could not delete $path: $error');
    }
  }
}

/// One finished meeting recording, ready for the raw-bytes upload.
@immutable
class MeetingAudioClip {
  const MeetingAudioClip({required this.bytes, required this.mimeType});

  final Uint8List bytes;

  /// Container MIME type: `audio/wav` or `audio/mp4`.
  final String mimeType;

  int get byteLength => bytes.length;
}

/// The app-wide meeting capture service.
///
/// Microphone permission is requested through the repo's [PermissionNotifier]
/// rather than a second `permission_handler` call site, so the permissions
/// screen and the recorder agree on the reported status.
final meetingRecorderProvider = Provider<MeetingRecorder>((ref) {
  final recorder = MeetingRecorder(() async {
    final status = await ref
        .read(permissionProvider.notifier)
        .requestMicrophone();
    return switch (status) {
      NovaPermissionStatus.granted => VoiceMicPermission.granted,
      NovaPermissionStatus.permanentlyDenied =>
        VoiceMicPermission.permanentlyDenied,
      NovaPermissionStatus.restricted => VoiceMicPermission.restricted,
      NovaPermissionStatus.denied ||
      NovaPermissionStatus.notDetermined => VoiceMicPermission.denied,
    };
  });
  ref.onDispose(recorder.dispose);
  return recorder;
});
