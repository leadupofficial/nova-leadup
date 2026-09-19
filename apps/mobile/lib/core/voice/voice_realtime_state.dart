import 'package:flutter/foundation.dart';

import 'voice_tool_approval.dart';

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

/// Which engine is voicing the current reply.
///
/// The cloud provider is the default, but it is a single point of failure: when
/// it fails, the reply is spoken by the platform's built-in synthesiser
/// instead. The UI has to be able to tell the two apart — silent degradation is
/// what made a provider outage look like NOVA had gone mute.
enum VoiceSpeechSource {
  /// Streaming MP3 from the server's cloud TTS provider.
  cloud,

  /// The platform's built-in synthesiser, used because cloud TTS failed.
  device,

  /// Device speech was needed but this device has no voice for the language.
  deviceUnavailable,
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
    this.speechSource = VoiceSpeechSource.cloud,
    this.deviceLanguageTag,
    this.speechNotice,
    this.toolNotice,
    this.toolNoticeStopped = false,
    this.pendingApproval,
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

  /// Which engine is voicing the current reply.
  final VoiceSpeechSource speechSource;

  /// The BCP-47 tag device speech is using, or null for the device default.
  final String? deviceLanguageTag;

  /// A one-line explanation shown when the reply is not coming from the cloud
  /// voice: either that the device voice is covering, or that it cannot.
  final String? speechNotice;

  /// What a write tool just did, e.g. `Reminder "Buy milk" set for Sun 20 Sept,
  /// 06:00 pm`. Shown as soon as it happens so a spoken "remind me" is
  /// acknowledged before the reply is finished being written.
  final String? toolNotice;

  /// True when [toolNotice] says a tool was *not* run because the approval was
  /// declined or never answered — as opposed to the tool failing. The two need
  /// different wording and different tone: one is the user's own decision being
  /// honoured, the other is a fault.
  final bool toolNoticeStopped;

  /// A side-effecting tool the server is holding until the user answers.
  ///
  /// The turn is paused while this is set: the tool does not run and the reply
  /// does not continue until [VoiceRealtimeController.decideApproval] sends an
  /// answer. Non-null is what tells the Converse screen to raise the Tool
  /// Confirmation sheet (§5.7).
  final VoiceToolApproval? pendingApproval;

  /// True while the turn is waiting on the user rather than on the network, so
  /// the UI can say "waiting for you" instead of claiming NOVA is thinking.
  bool get isAwaitingApproval => pendingApproval != null;

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
    VoiceSpeechSource? speechSource,
    String? deviceLanguageTag,
    String? speechNotice,
    String? toolNotice,
    bool? toolNoticeStopped,
    VoiceToolApproval? pendingApproval,
    String? errorMessage,
    String? errorCode,
    bool clearError = false,
    bool clearSpeechNotice = false,
    bool clearToolNotice = false,
    bool clearPendingApproval = false,
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
      speechSource: speechSource ?? this.speechSource,
      deviceLanguageTag: clearSpeechNotice
          ? null
          : (deviceLanguageTag ?? this.deviceLanguageTag),
      speechNotice: clearSpeechNotice
          ? null
          : (speechNotice ?? this.speechNotice),
      toolNotice: clearToolNotice ? null : (toolNotice ?? this.toolNotice),
      toolNoticeStopped: clearToolNotice
          ? false
          : (toolNoticeStopped ?? this.toolNoticeStopped),
      pendingApproval: clearPendingApproval
          ? null
          : (pendingApproval ?? this.pendingApproval),
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
      other.speechSource == speechSource &&
      other.deviceLanguageTag == deviceLanguageTag &&
      other.speechNotice == speechNotice &&
      other.toolNotice == toolNotice &&
      other.toolNoticeStopped == toolNoticeStopped &&
      other.pendingApproval == pendingApproval &&
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
    speechSource,
    deviceLanguageTag,
    speechNotice,
    toolNotice,
    toolNoticeStopped,
    pendingApproval,
    Object.hashAll(commits),
  );
}
