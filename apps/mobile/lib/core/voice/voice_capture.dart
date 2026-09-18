import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../permissions/permission_provider.dart';

/// Microphone permission as resolved by the OS.
///
/// Deliberately a local enum rather than a `permission_handler` type so the
/// capture service can be constructed with a fake requester in tests without
/// touching a platform channel.
enum VoiceMicPermission { granted, denied, permanentlyDenied, restricted }

/// Why a capture could not start, finish, or produce audio.
enum VoiceCaptureFailure {
  permissionDenied,
  permissionPermanentlyDenied,
  noMicrophone,
  recordingFailed,
  emptyRecording,
}

/// A capture failure with a message already worded for the user.
class VoiceCaptureException implements Exception {
  const VoiceCaptureException(this.failure, this.message, {this.cause});

  final VoiceCaptureFailure failure;
  final String message;
  final Object? cause;

  /// True when the OS will never show the prompt again and only Settings can
  /// re-enable the microphone.
  bool get needsSettings =>
      failure == VoiceCaptureFailure.permissionPermanentlyDenied;

  @override
  String toString() => 'VoiceCaptureException(${failure.name}): $message';
}

/// One finished recording.
@immutable
class VoiceClip {
  const VoiceClip({required this.bytes, required this.mimeType});

  final Uint8List bytes;

  /// Container MIME type, e.g. `audio/mp4` for the AAC/M4A default.
  final String mimeType;

  int get byteLength => bytes.length;

  /// What `NovaApi.transcribeAudio` expects.
  String get base64Data => base64Encode(bytes);
}

/// Events produced by a capture session.
///
/// A single stream is the only place a clip can appear, so the automatic
/// max-duration stop and a user-initiated stop travel the same path and the
/// screen cannot end up with an orphaned recording.
sealed class VoiceCaptureEvent {
  const VoiceCaptureEvent();
}

class VoiceClipCaptured extends VoiceCaptureEvent {
  const VoiceClipCaptured(this.clip);
  final VoiceClip clip;
}

class VoiceCaptureFailed extends VoiceCaptureEvent {
  const VoiceCaptureFailed(this.error);
  final VoiceCaptureException error;
}

typedef MicPermissionRequester = Future<VoiceMicPermission> Function();
typedef RecorderFactory = AudioRecorder Function();
typedef TempDirectoryProvider = Future<Directory> Function();

/// Wraps the `record` plugin for the Converse voice loop: permission, a
/// temporary file, the bytes as base64, and a live input level.
///
/// The recorder itself is created lazily on [start] so that constructing this
/// service (for example when a Riverpod provider is first read) never touches a
/// platform channel. [dispose] always releases the session.
class VoiceCapture {
  VoiceCapture(
    this._requestPermission, {
    RecorderFactory? recorderFactory,
    TempDirectoryProvider? temporaryDirectory,
    this.maxDuration = const Duration(minutes: 2),
    this.amplitudeInterval = const Duration(milliseconds: 120),
  }) : _recorderFactory = recorderFactory ?? AudioRecorder.new,
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory;

  final MicPermissionRequester _requestPermission;
  final RecorderFactory _recorderFactory;
  final TempDirectoryProvider _temporaryDirectory;

  /// Safety cap. Nothing should be able to leave the mic open indefinitely.
  final Duration maxDuration;

  /// Sampling period for the input level.
  final Duration amplitudeInterval;

  AudioRecorder? _recorder;
  String? _path;
  String _mimeType = 'audio/mp4';
  StreamSubscription<Amplitude>? _amplitude;
  Timer? _autoStop;
  bool _recording = false;
  bool _disposed = false;

  final _events = StreamController<VoiceCaptureEvent>.broadcast();
  final _levels = StreamController<double>.broadcast();

  /// Completed recordings and mid-session failures.
  Stream<VoiceCaptureEvent> get events => _events.stream;

  /// Input loudness in `0..1` while recording (0 when the platform reports
  /// nothing usable). `record` reports dBFS, where 0 is full scale.
  Stream<double> get levels => _levels.stream;

  bool get isRecording => _recording;

  /// Requests permission and begins writing to a temp file. Throws
  /// [VoiceCaptureException] when the microphone cannot be used.
  Future<void> start() async {
    if (_disposed) {
      throw const VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'The recorder has already been disposed.',
      );
    }
    if (_recording) return;

    await _assertPermission();
    final recorder = _ensureRecorder();
    await _assertInputDevice(recorder);
    final format = await _formatFor(recorder);

    final directory = await _temporaryDirectory();
    final path =
        '${directory.path}/nova_voice_${DateTime.now().millisecondsSinceEpoch}'
        '${format.extension}';

    try {
      await recorder.start(format.config, path: path);
    } catch (error) {
      throw _startFailure(error);
    }

    _recording = true;
    _path = path;
    _mimeType = format.mimeType;
    _listenForLevel(recorder);
    _autoStop = Timer(maxDuration, () => unawaited(_finish()));
  }

  /// Ends the session and emits [VoiceClipCaptured] (or [VoiceCaptureFailed])
  /// on [events]. Safe to call when not recording.
  Future<void> stop() => _finish();

  /// Ends the session and discards the file without emitting a clip.
  Future<void> cancel() async {
    _autoStop?.cancel();
    _autoStop = null;
    await _amplitude?.cancel();
    _amplitude = null;

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
      debugPrint('[VoiceCapture] cancel failed: $error');
    }
    _deleteQuietly(path);
  }

  /// Releases the recorder. Idempotent.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await cancel();
    await _events.close();
    await _levels.close();
    final recorder = _recorder;
    _recorder = null;
    try {
      await recorder?.dispose();
    } catch (error) {
      debugPrint('[VoiceCapture] dispose failed: $error');
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  Future<void> _finish() async {
    if (!_recording) return;
    _recording = false;
    _autoStop?.cancel();
    _autoStop = null;
    await _amplitude?.cancel();
    _amplitude = null;

    final recorder = _recorder;
    final startedPath = _path;
    _path = null;
    if (recorder == null) return;

    String? stoppedPath;
    try {
      stoppedPath = await recorder.stop();
    } catch (error) {
      _deleteQuietly(startedPath);
      _emit(
        VoiceCaptureFailed(
          VoiceCaptureException(
            VoiceCaptureFailure.recordingFailed,
            'Recording could not be stopped: $error',
            cause: error,
          ),
        ),
      );
      return;
    }

    final path = stoppedPath ?? startedPath;
    if (path == null) {
      _emit(VoiceCaptureFailed(_emptyFailure()));
      return;
    }

    try {
      final bytes = await File(path).readAsBytes();
      _deleteQuietly(path);
      if (bytes.isEmpty) {
        _emit(VoiceCaptureFailed(_emptyFailure()));
        return;
      }
      _emit(VoiceClipCaptured(VoiceClip(bytes: bytes, mimeType: _mimeType)));
    } catch (error) {
      _emit(
        VoiceCaptureFailed(
          VoiceCaptureException(
            VoiceCaptureFailure.recordingFailed,
            'The recording could not be read back: $error',
            cause: error,
          ),
        ),
      );
    }
  }

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
          'NOVA needs microphone access to hear you.',
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
    var encoder = AudioEncoder.aacLc;
    try {
      if (!await recorder.isEncoderSupported(AudioEncoder.aacLc)) {
        encoder = AudioEncoder.wav;
      }
    } catch (_) {
      // Treat an unimplemented capability probe as "use the default codec".
    }
    // 16 kHz mono is what the speech-to-text providers want; AAC/M4A keeps the
    // upload small enough for a single request.
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
          (amplitude) => _addLevel(amplitude.current),
          onError: (Object error) =>
              debugPrint('[VoiceCapture] amplitude error: $error'),
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
    'Nothing was recorded. Hold the phone closer and try again.',
  );

  void _emit(VoiceCaptureEvent event) {
    if (!_events.isClosed) _events.add(event);
  }

  void _deleteQuietly(String? path) {
    if (path == null) return;
    try {
      final file = File(path);
      if (file.existsSync()) file.deleteSync();
    } catch (error) {
      debugPrint('[VoiceCapture] could not delete $path: $error');
    }
  }
}

/// The app-wide capture service.
///
/// Microphone permission is requested through the repo's
/// [PermissionNotifier] rather than a second `permission_handler` call site, so
/// the permissions screen and Converse agree on the reported status.
final voiceCaptureProvider = Provider<VoiceCapture>((ref) {
  final capture = VoiceCapture(() async {
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
  ref.onDispose(capture.dispose);
  return capture;
});
