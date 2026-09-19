import 'package:flutter/material.dart';

import '../design/widgets/index.dart';
import 'voice_realtime_state.dart';

/// `NovaAvatarState` for a realtime voice phase.
///
/// [VoiceRealtimePhase.connecting] borrows the thinking pose: the socket
/// handshake has no designed state of its own.
NovaAvatarState voiceAvatarState(VoiceRealtimePhase phase) => switch (phase) {
  VoiceRealtimePhase.listening => NovaAvatarState.listening,
  VoiceRealtimePhase.thinking => NovaAvatarState.thinking,
  VoiceRealtimePhase.speaking => NovaAvatarState.speaking,
  VoiceRealtimePhase.error => NovaAvatarState.error,
  VoiceRealtimePhase.connecting => NovaAvatarState.thinking,
  VoiceRealtimePhase.idle => NovaAvatarState.idle,
};

/// The label under the streaming reply, naming the engine that is voicing it.
///
/// A silent switch from the cloud voice to the device voice is exactly the
/// degradation this label exists to prevent.
String voiceReplyLabel(VoiceSpeechSource source) => switch (source) {
  VoiceSpeechSource.cloud => 'Nova · speaking',
  VoiceSpeechSource.device => 'Nova · on-device voice',
  VoiceSpeechSource.deviceUnavailable => 'Nova · no device voice',
};

/// The notice for a reply the cloud voice could not speak, or null when the
/// cloud handled it. [onDismiss] clears it without touching the turn.
({String message, Color tone, IconData icon, VoidCallback onDismiss})?
voiceSpeechNotice(
  VoiceRealtimeState voice,
  NovaColors colors,
  VoidCallback onDismiss,
) {
  final notice = voice.speechNotice;
  if (notice == null) return null;
  final unavailable = voice.speechSource == VoiceSpeechSource.deviceUnavailable;
  return (
    message: notice,
    tone: unavailable ? colors.danger : colors.warning,
    icon: unavailable
        ? Icons.volume_off_rounded
        : Icons.record_voice_over_rounded,
    onDismiss: onDismiss,
  );
}

/// What a write tool just did, if anything.
///
/// Shown the moment the tool returns rather than folded into the reply: the user
/// spoke an instruction ("remind me to…") and wants to know it landed, and the
/// spoken reply is still being written at that point.
({String message, Color tone, IconData icon, VoidCallback onDismiss})?
voiceToolNotice(
  VoiceRealtimeState voice,
  NovaColors colors,
  VoidCallback onDismiss,
) {
  final notice = voice.toolNotice;
  if (notice == null || notice.isEmpty) return null;
  // A tool the approval gate stopped is not a failure — the user declined it, or
  // nobody answered in time. Reporting that in the failure tone would say
  // something broke when in fact nothing ran, which was the whole point.
  if (voice.toolNoticeStopped) {
    return (
      message: notice,
      tone: colors.warning,
      icon: Icons.shield_outlined,
      onDismiss: onDismiss,
    );
  }
  final failed = notice.startsWith('Could not ');
  return (
    message: notice,
    tone: failed ? colors.danger : colors.success,
    icon: failed ? Icons.error_outline_rounded : Icons.check_circle_outline_rounded,
    onDismiss: onDismiss,
  );
}

/// The provisional bubble for the user's live transcript, if any.
Widget? voiceLiveTranscript(VoiceRealtimeState voice) {
  final partial = voice.partial.trim();
  if (partial.isEmpty) return null;
  return NovaMessageBubble(
    text: partial,
    role: NovaMessageRole.user,
    provisional: true,
    label: voice.micActive ? 'You · listening' : 'You · transcribing',
  );
}

/// The provisional bubble for the reply as it streams in, if any.
Widget? voiceLiveReply(VoiceRealtimeState voice) {
  final reply = voice.reply.trim();
  if (reply.isEmpty) return null;
  if (voice.phase != VoiceRealtimePhase.speaking &&
      voice.phase != VoiceRealtimePhase.thinking) {
    return null;
  }
  return NovaMessageBubble(
    text: reply,
    role: NovaMessageRole.nova,
    provisional: true,
    // Names the engine voicing the reply, so a fallback is never silent.
    label: voiceReplyLabel(voice.speechSource),
  );
}

/// The single status pill for the Converse top bar.
///
/// Only the live microphone and handshake states pulse: a repeating animation
/// makes `pumpAndSettle` hang, and the pill itself honours the OS "reduce
/// motion" setting.
class NovaVoiceStatusPill extends StatelessWidget {
  const NovaVoiceStatusPill({
    super.key,
    required this.phase,
    this.speechSource = VoiceSpeechSource.cloud,
  });

  final VoiceRealtimePhase phase;

  /// Which engine is voicing the reply. The pill says so explicitly: a silent
  /// switch from the cloud voice to the device voice is exactly the kind of
  /// degradation the user must be able to see.
  final VoiceSpeechSource speechSource;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    // An unavailable device voice outranks the phase: when the cloud provider
    // has failed and the device has no voice for the language, "Thinking" or
    // "Speaking" would claim audio that is not coming.
    if (speechSource == VoiceSpeechSource.deviceUnavailable &&
        phase != VoiceRealtimePhase.error &&
        phase != VoiceRealtimePhase.idle) {
      return NovaStatusPill(
        label: 'No device voice',
        tone: c.warning,
        animate: false,
        icon: Icons.volume_off_rounded,
      );
    }

    final (label, tone) = switch (phase) {
      VoiceRealtimePhase.listening => ('Listening', c.danger),
      VoiceRealtimePhase.thinking => ('Thinking', c.accent),
      VoiceRealtimePhase.speaking =>
        speechSource == VoiceSpeechSource.device
            ? ('Speaking · on-device', c.cyan)
            : ('Speaking', c.success),
      VoiceRealtimePhase.connecting => ('Connecting', c.warning),
      VoiceRealtimePhase.error => ('Error', c.danger),
      VoiceRealtimePhase.idle => ('Ready', c.success),
    };

    return NovaStatusPill(
      label: label,
      tone: tone,
      animate:
          phase == VoiceRealtimePhase.listening ||
          phase == VoiceRealtimePhase.connecting,
      icon: phase == VoiceRealtimePhase.speaking
          ? Icons.volume_up_rounded
          : null,
    );
  }
}
