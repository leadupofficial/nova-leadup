import 'package:flutter/foundation.dart';

/// The state types for the recorder screen (§5.11).
///
/// Split from `recording_controller.dart` so each file stays small; the
/// controller re-exports them, so `recording_controller.dart` remains the one
/// import a caller needs.

/// Where the recorder screen is in the §5.11 flow.
///
/// `consent` is the initial state: recording is OFF until the reminder is
/// acknowledged and Start is pressed.
enum RecordingPhase {
  consent,
  starting,
  recording,
  paused,
  uploading,
  processing,
  failed,
}

/// Everything the recorder screen renders.
@immutable
class RecordingState {
  const RecordingState({
    this.phase = RecordingPhase.consent,
    this.elapsedSeconds = 0,
    this.levels = const <double>[],
    this.error,
    this.consentAcknowledged = false,
    this.recordingId,
    this.title,
    this.language,
    this.statusMessage,
    this.storedInObjectStorage,
  });

  final RecordingPhase phase;
  final int elapsedSeconds;

  /// Recent amplitude samples in `0..1`, oldest first.
  final List<double> levels;

  /// The honest, user-facing failure message. Never cleared by a timer.
  final String? error;
  final bool consentAcknowledged;
  final String? recordingId;
  final String? title;
  final String? language;

  /// What the upload/processing step is doing right now.
  final String? statusMessage;

  /// Set once the upload succeeded: whether the server put the bytes in object
  /// storage. Null means no upload has completed.
  final bool? storedInObjectStorage;

  bool get isActive =>
      phase == RecordingPhase.recording || phase == RecordingPhase.paused;

  bool get isBusy =>
      phase == RecordingPhase.starting ||
      phase == RecordingPhase.uploading ||
      phase == RecordingPhase.processing;

  bool get canStart =>
      !isActive && !isBusy && consentAcknowledged;

  String get elapsedLabel {
    final m = (elapsedSeconds ~/ 60).toString().padLeft(2, '0');
    final s = (elapsedSeconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  RecordingState copyWith({
    RecordingPhase? phase,
    int? elapsedSeconds,
    List<double>? levels,
    String? error,
    bool? consentAcknowledged,
    String? recordingId,
    String? title,
    String? language,
    String? statusMessage,
    bool? storedInObjectStorage,
    bool clearError = false,
    bool clearStatus = false,
  }) {
    return RecordingState(
      phase: phase ?? this.phase,
      elapsedSeconds: elapsedSeconds ?? this.elapsedSeconds,
      levels: levels ?? this.levels,
      error: clearError ? null : (error ?? this.error),
      consentAcknowledged: consentAcknowledged ?? this.consentAcknowledged,
      recordingId: recordingId ?? this.recordingId,
      title: title ?? this.title,
      language: language ?? this.language,
      statusMessage: clearStatus ? null : (statusMessage ?? this.statusMessage),
      storedInObjectStorage:
          storedInObjectStorage ?? this.storedInObjectStorage,
    );
  }
}

/// The result of a voice-matched recording command, worded for the user.
@immutable
class RecordingCommandResult {
  const RecordingCommandResult({
    required this.ok,
    required this.message,
    this.route,
  });

  final bool ok;
  final String message;

  /// Where the caller should navigate when the command genuinely ran.
  final String? route;
}
