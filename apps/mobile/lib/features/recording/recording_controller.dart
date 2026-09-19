import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/api/providers.dart';
import '../../core/voice/voice_capture.dart' show VoiceCaptureException;
import 'meeting_recorder.dart';

import 'recording_state.dart';

export 'recording_state.dart';

/// Drives one meeting-capture session: consent, the microphone, the elapsed
/// timer, the upload and the processing kick-off.
///
/// It holds no `BuildContext`, so the voice path can drive it from a data
/// controller; the caller decides when to navigate. The state survives
/// navigation (this is a plain [Notifier], not `autoDispose`) so a
/// voice-started session keeps running while the screen opens.
class RecordingController extends Notifier<RecordingState> {
  /// How many amplitude samples the waveform keeps.
  static const int maxLevelSamples = 48;

  Timer? _ticker;
  StreamSubscription<double>? _levelSub;
  MeetingAudioClip? _pendingClip;
  bool _disposed = false;

  @override
  RecordingState build() {
    ref.onDispose(() {
      _disposed = true;
      _ticker?.cancel();
      _levelSub?.cancel();
    });
    return const RecordingState();
  }

  /// Resets for a fresh session when the screen opens.
  ///
  /// An active session is never disturbed, so opening the screen from the voice
  /// path shows the running recording rather than resetting it. The consent
  /// acknowledgement is deliberately cleared: §9.5 wants a fresh, explicit
  /// acknowledgement for each meeting, not a remembered tick.
  void prepareNewSession() {
    if (state.isActive || state.isBusy) return;
    _ticker?.cancel();
    _ticker = null;
    _pendingClip = null;
    state = RecordingState(title: state.title, language: state.language);
  }

  void setTitle(String title) {
    final trimmed = title.trim();
    if (trimmed.isEmpty) return;
    state = state.copyWith(title: trimmed);
  }

  void setLanguage(String? language) => state = state.copyWith(language: language);

  void acknowledgeConsent(bool value) => state = state.copyWith(
    consentAcknowledged: value,
    clearError: value,
  );

  /// Creates the row, opens the microphone and starts the timer.
  ///
  /// Returns false and sets [RecordingState.error] when the consent reminder has
  /// not been acknowledged, when the row cannot be created, or when the
  /// microphone cannot be opened. Nothing is recorded until all three succeed.
  Future<bool> start({String? title, String? language}) async {
    if (state.isActive || state.isBusy) return false;
    if (!state.consentAcknowledged) {
      state = state.copyWith(
        phase: RecordingPhase.consent,
        error: 'Acknowledge the recording reminder before starting.',
      );
      return false;
    }

    final resolvedTitle = (title ?? state.title ?? 'Meeting').trim();
    final resolvedLanguage = language ?? state.language;
    state = state.copyWith(
      phase: RecordingPhase.starting,
      clearError: true,
      clearStatus: true,
      elapsedSeconds: 0,
      levels: const <double>[],
      recordingId: null,
      title: resolvedTitle,
      language: resolvedLanguage,
      storedInObjectStorage: null,
    );

    final api = ref.read(novaApiProvider);
    final NovaRecording row;
    try {
      // The consent record is written with the row, before any audio exists.
      row = await api.createRecording(
        title: resolvedTitle,
        language: resolvedLanguage,
        consentRecorded: true,
      );
    } on NovaApiException catch (e) {
      state = state.copyWith(
        phase: RecordingPhase.failed,
        error: 'The recording could not be created: ${e.message}',
      );
      return false;
    }

    try {
      await ref.read(meetingRecorderProvider).start();
    } on VoiceCaptureException catch (e) {
      // The row exists but nothing was captured; mark it failed rather than
      // leaving a "recording" row that never recorded.
      await _markFailed(api, row.id);
      state = state.copyWith(
        phase: RecordingPhase.failed,
        recordingId: row.id,
        error: e.message,
      );
      return false;
    }

    _bindLevels();
    _startTicker();
    state = state.copyWith(
      phase: RecordingPhase.recording,
      recordingId: row.id,
      statusMessage: 'Recording to the microphone.',
    );
    return true;
  }

  /// Genuinely pauses the microphone and stops the timer.
  Future<void> pause() async {
    if (state.phase != RecordingPhase.recording) return;
    await ref.read(meetingRecorderProvider).pause();
    _ticker?.cancel();
    _ticker = null;
    state = state.copyWith(
      phase: RecordingPhase.paused,
      statusMessage: 'Paused. No audio is being captured.',
    );
  }

  /// Resumes the microphone and the timer.
  Future<void> resume() async {
    if (state.phase != RecordingPhase.paused) return;
    await ref.read(meetingRecorderProvider).resume();
    _startTicker();
    state = state.copyWith(
      phase: RecordingPhase.recording,
      statusMessage: null,
      clearStatus: true,
    );
  }

  /// Stops capture, then PATCHes the row, uploads the bytes and asks the server
  /// to process them.
  ///
  /// Returns the recording id only when the whole sequence succeeded, which is
  /// the signal for the screen to open the summary. On an upload failure it
  /// returns null, sets [RecordingState.error] and keeps the row and the bytes
  /// so [retryUpload] can try again — it never reports the audio as stored when
  /// the server refused it.
  Future<String?> stop() async {
    if (!state.isActive) return null;
    _ticker?.cancel();
    _ticker = null;

    final id = state.recordingId;
    final elapsed = state.elapsedSeconds;
    state = state.copyWith(
      phase: RecordingPhase.uploading,
      clearError: true,
      statusMessage: 'Finishing the recording…',
    );

    final MeetingAudioClip clip;
    try {
      clip = await ref.read(meetingRecorderProvider).stop();
    } on VoiceCaptureException catch (e) {
      state = state.copyWith(phase: RecordingPhase.failed, error: e.message);
      return null;
    }
    _pendingClip = clip;
    if (id == null) {
      state = state.copyWith(
        phase: RecordingPhase.failed,
        error: 'The recording row was never created, so the audio was not sent.',
      );
      return null;
    }
    return _uploadAndProcess(id, clip, elapsed);
  }

  /// Re-sends the bytes retained from a failed upload. Returns the id on
  /// success, null otherwise.
  Future<String?> retryUpload() async {
    final id = state.recordingId;
    final clip = _pendingClip;
    if (id == null || clip == null) return null;
    state = state.copyWith(phase: RecordingPhase.uploading, clearError: true);
    return _uploadAndProcess(id, clip, state.elapsedSeconds);
  }

  /// Abandons the session: stops and discards any capture, keeping the row that
  /// was already created (deleting it is the user's decision elsewhere).
  Future<void> discard() async {
    _ticker?.cancel();
    _ticker = null;
    await _levelSub?.cancel();
    _levelSub = null;
    await ref.read(meetingRecorderProvider).cancel();
    _pendingClip = null;
    state = RecordingState(title: state.title, language: state.language);
  }

  // ── Voice-driven entry points ─────────────────────────────────────────────

  /// Starts a session from a matched voice command.
  ///
  /// [consentAcknowledged] is true only when the caller put the consent wording
  /// in front of the user and they confirmed it (the device-control sheet does
  /// exactly that for an L3 action); without it the command is refused.
  Future<RecordingCommandResult> startFromVoice({
    required bool consentAcknowledged,
  }) async {
    if (state.isActive) {
      return const RecordingCommandResult(
        ok: false,
        message: 'A recording is already in progress.',
      );
    }
    if (!consentAcknowledged && !state.consentAcknowledged) {
      return const RecordingCommandResult(
        ok: false,
        message:
            'Recording needs the consent reminder acknowledged first. '
            'Open the recorder and tick "Everyone has been told".',
      );
    }
    if (consentAcknowledged) {
      state = state.copyWith(consentAcknowledged: true);
    }

    final ok = await start(title: state.title ?? 'Meeting');
    if (!ok) {
      return RecordingCommandResult(
        ok: false,
        message: state.error ?? 'The recording could not start.',
      );
    }
    return const RecordingCommandResult(
      ok: true,
      message:
          'Recording started. Everyone present must know they are being recorded.',
      route: '/tasks/record',
    );
  }

  /// Stops the running session from a matched voice command.
  Future<RecordingCommandResult> stopFromVoice() async {
    if (!state.isActive) {
      return const RecordingCommandResult(
        ok: false,
        message: 'No recording is in progress.',
      );
    }
    final id = await stop();
    if (id == null) {
      return RecordingCommandResult(
        ok: false,
        message: state.error ?? 'The recording could not be finished.',
      );
    }
    return RecordingCommandResult(
      ok: true,
      message: 'Recording stopped and sent to the server.',
      route: '/recordings/$id',
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  Future<String?> _uploadAndProcess(
    String id,
    MeetingAudioClip clip,
    int elapsed,
  ) async {
    final api = ref.read(novaApiProvider);
    final language = state.language;

    // The duration is saved first: even if the upload never completes, the row
    // keeps an honest length rather than showing 00:00.
    try {
      await api.updateRecording(
        id,
        durationSeconds: elapsed,
        status: 'completed',
      );
    } on NovaApiException catch (e) {
      state = state.copyWith(
        error: 'The duration could not be saved: ${e.message}',
      );
    }

    state = state.copyWith(
      phase: RecordingPhase.uploading,
      statusMessage: 'Uploading the audio (${clip.byteLength} bytes)…',
    );
    final NovaRecordingUpload upload;
    try {
      upload = await api.uploadRecordingAudio(
        id,
        clip.bytes,
        clip.mimeType,
        language: language,
        durationSeconds: elapsed,
      );
    } on NovaApiException catch (e) {
      // The bytes are NOT on the server. Say exactly that, keep the row, and
      // hold the clip so the user can retry.
      state = state.copyWith(
        phase: RecordingPhase.failed,
        error: _uploadFailureMessage(e, clip.byteLength),
      );
      return null;
    }
    _pendingClip = null;

    state = state.copyWith(
      phase: RecordingPhase.processing,
      storedInObjectStorage: upload.storage.objectStorage,
      statusMessage: upload.storage.objectStorage
          ? 'Audio stored. Transcribing and summarising…'
          : 'Audio saved by the server. Transcribing and summarising…',
    );

    try {
      await api.processRecording(id, language: language);
    } on NovaApiException catch (e) {
      state = state.copyWith(
        phase: RecordingPhase.failed,
        error:
            'The audio was saved, but the server could not start '
            'transcription: ${e.message}',
      );
      return null;
    }

    ref.invalidate(recordingsProvider);
    ref.invalidate(recordingDetailProvider(id));
    return id;
  }

  String _uploadFailureMessage(NovaApiException e, int byteLength) {
    if (e.statusCode == 413) {
      return 'This recording is too large for the server '
          '($byteLength bytes). It was not uploaded.';
    }
    if (e.statusCode == 503) {
      return 'The server could not store the audio (503): ${e.message}. '
          'The recording row is saved, but the audio is not on the server yet.';
    }
    final status = e.statusCode == null ? '' : ' (${e.statusCode})';
    return 'The audio was not uploaded$status: ${e.message}. '
        'The recording row is saved and the audio can be retried.';
  }

  Future<void> _markFailed(NovaApi api, String id) async {
    try {
      await api.updateRecording(id, status: 'failed');
    } catch (error) {
      debugPrint('[RecordingController] could not mark $id failed: $error');
    }
  }

  void _bindLevels() {
    _levelSub?.cancel();
    _levelSub = ref.read(meetingRecorderProvider).levels.listen((level) {
      if (_disposed) return;
      final next = <double>[...state.levels, level];
      if (next.length > maxLevelSamples) {
        next.removeRange(0, next.length - maxLevelSamples);
      }
      state = state.copyWith(levels: next);
    });
  }

  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_disposed) return;
      if (state.phase != RecordingPhase.recording) return;
      state = state.copyWith(elapsedSeconds: state.elapsedSeconds + 1);
    });
  }
}

final recordingControllerProvider =
    NotifierProvider<RecordingController, RecordingState>(
      RecordingController.new,
    );
