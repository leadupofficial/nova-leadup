import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:record/record.dart';

import '../permissions/permission_provider.dart';
import 'voice_capture.dart';

/// A live microphone stream of 16 kHz mono `s16le` PCM.
///
/// This is the streaming sibling of [VoiceCapture]. [VoiceCapture] records to a
/// file and hands back a finished clip (the one-shot flow the mic button used
/// to drive); this yields `Uint8List` PCM frames as the microphone produces
/// them, which is what the realtime WebSocket needs. The file-based API is left
/// untouched so the existing tests and any screen still using it keep working.
abstract interface class VoiceStreamCapture {
  /// Raw little-endian signed 16-bit PCM, mono, at [RecordVoiceStreamCapture.sampleRate].
  Stream<Uint8List> get frames;

  /// Failures that happen after [start] succeeded (device unplugged, OS revoked
  /// the session), worded for the user.
  Stream<VoiceCaptureException> get errors;

  bool get isStreaming;

  /// Requests permission and begins streaming. Throws [VoiceCaptureException]
  /// with a typed [VoiceCaptureFailure] — never a generic error — when the
  /// microphone cannot be used.
  Future<void> start();

  /// Ends the session and releases the microphone. Safe to call when idle.
  Future<void> stop();

  /// [stop] plus releases the recorder entirely. Idempotent.
  Future<void> dispose();
}

/// The real implementation, backed by `record`'s `AudioRecorder.startStream`.
class RecordVoiceStreamCapture implements VoiceStreamCapture {
  RecordVoiceStreamCapture(
    this._requestPermission, {
    RecorderFactory? recorderFactory,
    this.sampleRate = 16000,
    this.numChannels = 1,
    this.streamBufferSize = 3200,
  }) : _recorderFactory = recorderFactory ?? AudioRecorder.new;

  final MicPermissionRequester _requestPermission;
  final RecorderFactory _recorderFactory;

  /// 16 kHz mono is what the server's streaming STT expects.
  final int sampleRate;
  final int numChannels;

  /// 3200 bytes is ~100 ms of 16 kHz mono `s16le`, small enough to feel live.
  final int? streamBufferSize;

  final StreamController<Uint8List> _frames =
      StreamController<Uint8List>.broadcast();
  final StreamController<VoiceCaptureException> _errors =
      StreamController<VoiceCaptureException>.broadcast();

  AudioRecorder? _recorder;
  StreamSubscription<Uint8List>? _subscription;
  bool _streaming = false;
  bool _disposed = false;

  @override
  Stream<Uint8List> get frames => _frames.stream;

  @override
  Stream<VoiceCaptureException> get errors => _errors.stream;

  @override
  bool get isStreaming => _streaming;

  @override
  Future<void> start() async {
    if (_disposed) {
      throw const VoiceCaptureException(
        VoiceCaptureFailure.recordingFailed,
        'The microphone stream has already been disposed.',
      );
    }
    if (_streaming) return;

    await _assertPermission();
    final recorder = _ensureRecorder();
    await _assertInputDevice(recorder);
    await _assertStreamingSupported(recorder);

    final Stream<Uint8List> source;
    try {
      source = await recorder.startStream(
        RecordConfig(
          // Raw PCM: the server wants samples, not a container.
          encoder: AudioEncoder.pcm16bits,
          sampleRate: sampleRate,
          numChannels: numChannels,
          streamBufferSize: streamBufferSize,
          // The mic hears NOVA's own speaker output; these are advisory and
          // ignored where the platform does not implement them.
          echoCancel: true,
          noiseSuppress: true,
        ),
      );
    } catch (error) {
      throw _startFailure(error);
    }

    _streaming = true;
    // `record` only forwards data while its broadcast stream has a listener, so
    // this subscription must exist for the whole session.
    _subscription = source.listen(
      (chunk) {
        if (!_frames.isClosed && chunk.isNotEmpty) _frames.add(chunk);
      },
      onError: (Object error) {
        _streaming = false;
        _emitError(_startFailure(error));
      },
      cancelOnError: false,
    );
  }

  @override
  Future<void> stop() async {
    if (!_streaming && _subscription == null) return;
    _streaming = false;

    await _subscription?.cancel();
    _subscription = null;

    final recorder = _recorder;
    if (recorder == null) return;
    try {
      // `stop` (not `cancel`) so the platform session is torn down the same way
      // the file-based recorder tears it down.
      await recorder.stop();
    } catch (error) {
      debugPrint('[VoiceStreamCapture] stop failed: $error');
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await stop();
    await _frames.close();
    await _errors.close();

    final recorder = _recorder;
    _recorder = null;
    try {
      await recorder?.dispose();
    } catch (error) {
      debugPrint('[VoiceStreamCapture] dispose failed: $error');
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  AudioRecorder _ensureRecorder() => _recorder ??= _recorderFactory();

  /// The same permission contract as [VoiceCapture]: a denial and a permanent
  /// denial are different failures with different remedies.
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

  Future<void> _assertStreamingSupported(AudioRecorder recorder) async {
    try {
      if (!await recorder.isEncoderSupported(AudioEncoder.pcm16bits)) {
        throw const VoiceCaptureException(
          VoiceCaptureFailure.recordingFailed,
          'This device cannot stream raw microphone audio, so live voice is '
          'unavailable. Type your message instead.',
        );
      }
    } on VoiceCaptureException {
      rethrow;
    } catch (_) {
      // An unimplemented capability probe must not block a working device.
    }
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
      'Live audio could not start: $error',
      cause: error,
    );
  }

  void _emitError(VoiceCaptureException error) {
    if (!_errors.isClosed) _errors.add(error);
  }
}

/// The app-wide streaming capture service.
///
/// Requests the microphone through the repo's [PermissionNotifier] rather than
/// a second `permission_handler` call site, so the permissions screen and
/// Converse agree on the reported status.
final voiceStreamCaptureProvider = Provider<VoiceStreamCapture>((ref) {
  final capture = RecordVoiceStreamCapture(() async {
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
