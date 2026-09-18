import 'package:flutter/foundation.dart';

/// The realtime voice state machine.
///
/// `idle → listening → thinking → speaking → idle`, plus [error]. [connecting]
/// is surfaced honestly rather than folded into [idle]: the socket handshake can
/// take a moment and the user should see that the tap registered.
enum VoiceRealtimePhase {
  idle,
  connecting,
  listening,
  thinking,
  speaking,
  error,
}

/// A finished turn that belongs in the visible transcript.
@immutable
class VoiceTurnCommit {
  const VoiceTurnCommit({required this.text, required this.user});

  final String text;

  /// True for the user's `final` transcript, false for NOVA's `done` reply.
  final bool user;

  @override
  bool operator ==(Object other) =>
      other is VoiceTurnCommit && other.text == text && other.user == user;

  @override
  int get hashCode => Object.hash(text, user);
}

/// Everything the Converse screen needs to render the live turn.
@immutable
class VoiceRealtimeState {
  const VoiceRealtimeState({
    this.phase = VoiceRealtimePhase.idle,
    this.partial = '',
    this.reply = '',
    this.errorMessage,
    this.errorCode,
    this.sentenceIndex = 0,
    this.micActive = false,
    this.audible = false,
    this.connected = false,
    this.commits = const <VoiceTurnCommit>[],
  });

  final VoiceRealtimePhase phase;

  /// Provisional transcript of what the user is saying right now.
  final String partial;

  /// Reply text accumulated from `token` events, before `done` commits it.
  final String reply;

  final String? errorMessage;
  final String? errorCode;

  /// Index of the most recent `sentence` handed to TTS.
  final int sentenceIndex;

  /// True while the microphone is open and frames are being sent.
  final bool micActive;

  /// True while NOVA's audio is actually coming out of the speaker.
  final bool audible;

  final bool connected;

  /// Finished turns, appended in order. The screen watches the length and
  /// drains whatever it has not rendered yet.
  final List<VoiceTurnCommit> commits;

  /// True for the phases in which a turn is in flight and Stop makes sense.
  bool get isTurnActive =>
      phase == VoiceRealtimePhase.listening ||
      phase == VoiceRealtimePhase.thinking ||
      phase == VoiceRealtimePhase.speaking;

  bool get hasError => phase == VoiceRealtimePhase.error;

  VoiceRealtimeState copyWith({
    VoiceRealtimePhase? phase,
    String? partial,
    String? reply,
    int? sentenceIndex,
    bool? micActive,
    bool? audible,
    bool? connected,
    List<VoiceTurnCommit>? commits,
    String? errorMessage,
    String? errorCode,
    bool clearError = false,
  }) {
    return VoiceRealtimeState(
      phase: phase ?? this.phase,
      partial: partial ?? this.partial,
      reply: reply ?? this.reply,
      sentenceIndex: sentenceIndex ?? this.sentenceIndex,
      micActive: micActive ?? this.micActive,
      audible: audible ?? this.audible,
      connected: connected ?? this.connected,
      commits: commits ?? this.commits,
      errorMessage: clearError ? null : (errorMessage ?? this.errorMessage),
      errorCode: clearError ? null : (errorCode ?? this.errorCode),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is VoiceRealtimeState &&
      other.phase == phase &&
      other.partial == partial &&
      other.reply == reply &&
      other.errorMessage == errorMessage &&
      other.errorCode == errorCode &&
      other.sentenceIndex == sentenceIndex &&
      other.micActive == micActive &&
      other.audible == audible &&
      other.connected == connected &&
      listEquals(other.commits, commits);

  @override
  int get hashCode => Object.hash(
    phase,
    partial,
    reply,
    errorMessage,
    errorCode,
    sentenceIndex,
    micActive,
    audible,
    connected,
    Object.hashAll(commits),
  );
}
