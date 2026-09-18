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

/// The single status pill for the Converse top bar.
///
/// Only the live microphone and handshake states pulse: a repeating animation
/// makes `pumpAndSettle` hang, and the pill itself honours the OS "reduce
/// motion" setting.
class NovaVoiceStatusPill extends StatelessWidget {
  const NovaVoiceStatusPill({super.key, required this.phase});

  final VoiceRealtimePhase phase;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final (label, tone) = switch (phase) {
      VoiceRealtimePhase.listening => ('Listening', c.danger),
      VoiceRealtimePhase.thinking => ('Thinking', c.accent),
      VoiceRealtimePhase.speaking => ('Speaking', c.success),
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
