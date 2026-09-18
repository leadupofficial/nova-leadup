import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';
import 'nova_avatar.dart';

/// Who authored a transcript entry.
enum NovaMessageRole { user, nova, system }

/// `.msg` / `.msg-bubble` from the converse screen.
///
/// User bubbles are the accent gradient with a 4px bottom-right corner; NOVA
/// bubbles are `--surface-raised` with a border and a 4px bottom-left corner.
class NovaMessageBubble extends StatelessWidget {
  const NovaMessageBubble({
    super.key,
    required this.text,
    required this.role,
    this.pending = false,
    this.failed = false,
    this.onRetry,
  });

  final String text;
  final NovaMessageRole role;
  final bool pending;
  final bool failed;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final isUser = role == NovaMessageRole.user;

    final label = switch (role) {
      NovaMessageRole.user => 'You',
      NovaMessageRole.nova => 'Nova',
      NovaMessageRole.system => 'System',
    };

    final bubble = Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        gradient: isUser ? c.accentGradient : null,
        color: isUser ? null : c.surfaceRaised,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(NovaRadius.bubble),
          topRight: const Radius.circular(NovaRadius.bubble),
          bottomLeft: Radius.circular(isUser ? NovaRadius.bubble : 4),
          bottomRight: Radius.circular(isUser ? 4 : NovaRadius.bubble),
        ),
        border: isUser ? null : Border.all(color: c.border),
      ),
      child: pending
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.muted,
                  ),
                ),
                const SizedBox(width: 10),
                Text(
                  'Thinking…',
                  style: NovaTheme.bubble(c).copyWith(color: c.muted),
                ),
              ],
            )
          : Text(
              text,
              style: NovaTheme.bubble(c).copyWith(
                color: isUser ? c.onAccent : c.fg,
              ),
            ),
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.md),
      child: Column(
        crossAxisAlignment: isUser
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 4),
            child: Text(label.toUpperCase(), style: NovaTheme.msgLabel(c)),
          ),
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.85,
            ),
            child: bubble,
          ),
          if (failed) ...[
            const SizedBox(height: 6),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.error_outline, size: 13, color: c.danger),
                const SizedBox(width: 4),
                Text(
                  'Not delivered',
                  style: NovaTheme.msgLabel(c).copyWith(color: c.danger),
                ),
                if (onRetry != null) ...[
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: onRetry,
                    child: Text(
                      'Retry',
                      style: NovaTheme.msgLabel(c).copyWith(color: c.accent),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// `.input-bar` — pill text field plus the circular gradient mic button.
class NovaComposer extends StatelessWidget {
  const NovaComposer({
    super.key,
    required this.controller,
    this.onSend,
    this.onMic,
    this.micActive = false,
    this.enabled = true,
    this.hint = 'Type a message…',
  });

  final TextEditingController controller;
  final ValueChanged<String>? onSend;
  final VoidCallback? onMic;
  final bool micActive;
  final bool enabled;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final canSend = enabled && controller.text.trim().isNotEmpty;

    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 12,
        bottom: 12 + MediaQuery.viewInsetsOf(context).bottom * 0,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Container(
              constraints: const BoxConstraints(minHeight: 48),
              decoration: BoxDecoration(
                color: c.surface,
                borderRadius: NovaRadius.rPill,
                border: Border.all(color: c.border),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 4,
                      ),
                      child: TextField(
                        controller: controller,
                        enabled: enabled,
                        minLines: 1,
                        maxLines: 5,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (v) {
                          if (v.trim().isNotEmpty) onSend?.call(v.trim());
                        },
                        style: NovaTheme.input(c),
                        cursorColor: c.accent,
                        decoration: InputDecoration(
                          hintText: hint,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          filled: false,
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            vertical: 14,
                          ),
                        ),
                      ),
                    ),
                  ),
                  if (canSend)
                    Padding(
                      padding: const EdgeInsets.only(right: 6, bottom: 4),
                      child: _RoundAction(
                        icon: Icons.arrow_upward,
                        onTap: () => onSend?.call(controller.text.trim()),
                        gradient: c.accentGradient,
                        size: 38,
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 10),
          _RoundAction(
            icon: micActive ? Icons.stop_rounded : Icons.mic_none_rounded,
            onTap: onMic,
            gradient: micActive ? c.recordingGradient : c.accentGradient,
            size: 48,
            glow: true,
            semanticLabel: micActive ? 'Stop listening' : 'Start listening',
          ),
        ],
      ),
    );
  }
}

class _RoundAction extends StatelessWidget {
  const _RoundAction({
    required this.icon,
    required this.onTap,
    required this.gradient,
    required this.size,
    this.glow = false,
    this.semanticLabel,
  });

  final IconData icon;
  final VoidCallback? onTap;
  final Gradient gradient;
  final double size;
  final bool glow;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: gradient,
              boxShadow: glow ? NovaShadows.mic(c) : null,
            ),
            child: Icon(icon, color: c.onAccent, size: size * 0.44),
          ),
        ),
      ),
    );
  }
}

/// The avatar + state + recording indicator block at the top of Converse.
class NovaConverseHeader extends StatelessWidget {
  const NovaConverseHeader({
    super.key,
    required this.state,
    this.face = '😊',
  });

  final NovaAvatarState state;
  final String face;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return Column(
      children: [
        SizedBox(
          height: 280,
          child: Stack(
            alignment: Alignment.center,
            children: [
              NovaAvatarRing(size: 180, face: face, state: state),
              Positioned(
                bottom: 26,
                child: NovaAvatarStateBadge(state: state),
              ),
            ],
          ),
        ),
        if (state.isRecordingStyle)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                NovaWaveform(color: c.danger),
                const SizedBox(width: 10),
                Text(
                  state.label,
                  style: NovaTheme.chip(c).copyWith(color: c.danger),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
