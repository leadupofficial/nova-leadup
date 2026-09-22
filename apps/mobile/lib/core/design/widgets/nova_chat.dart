import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';
import 'nova_avatar.dart';
import 'nova_avatar_waveform.dart';
import 'nova_markdown.dart';
import 'nova_surfaces.dart';

/// Who authored a transcript entry.
enum NovaMessageRole { user, nova, system }

/// `.msg` / `.msg-bubble` from the converse screen.
///
/// User bubbles are the accent gradient with a 4px bottom-right corner; NOVA
/// bubbles are `--surface-raised` with a border and a 4px bottom-left corner.
///
/// [provisional] marks text that has not been committed yet — the live partial
/// transcript from the realtime voice socket. It is drawn as a quiet outline
/// bubble rather than a filled one so "still being heard" is visually distinct
/// from a finished turn without introducing a new colour.
class NovaMessageBubble extends StatelessWidget {
  const NovaMessageBubble({
    super.key,
    required this.text,
    required this.role,
    this.pending = false,
    this.failed = false,
    this.provisional = false,
    this.label,
    this.onRetry,
    this.onReport,
  });

  final String text;
  final NovaMessageRole role;
  final bool pending;
  final bool failed;

  /// Text that is still arriving (a live transcript or a streaming reply).
  final bool provisional;

  /// Overrides the role label, e.g. `You · listening`.
  final String? label;

  final VoidCallback? onRetry;

  /// Files a report about this reply. Rendered only on committed assistant messages,
  /// and only when set.
  ///
  /// Google Play's AI-Generated Content policy requires apps that generate content
  /// with AI to provide in-app reporting of offensive output without making the user
  /// leave the app. This is that control.
  final VoidCallback? onReport;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final isUser = role == NovaMessageRole.user;

    final baseLabel = switch (role) {
      NovaMessageRole.user => 'You',
      NovaMessageRole.nova => 'Nova',
      NovaMessageRole.system => 'System',
    };
    final displayLabel = label ?? (provisional ? '$baseLabel · live' : baseLabel);

    // A provisional bubble is unfilled with an accent outline; a committed one
    // keeps the filled treatment the export specifies.
    final Color? fill = provisional
        ? (isUser ? c.accent.withValues(alpha: 0.12) : c.surfaceRaised)
        : (isUser ? null : c.surfaceRaised);

    final bubble = Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        gradient: (!provisional && isUser) ? c.accentGradient : null,
        color: fill,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(NovaRadius.bubble),
          topRight: const Radius.circular(NovaRadius.bubble),
          bottomLeft: Radius.circular(isUser ? NovaRadius.bubble : 4),
          bottomRight: Radius.circular(isUser ? 4 : NovaRadius.bubble),
        ),
        border: Border.all(
          color: provisional
              ? c.accent.withValues(alpha: 0.55)
              : (isUser ? Colors.transparent : c.border),
        ),
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
          : NovaMarkdown(
              // The assistant answers in markdown; rendering it raw left
              // literal '**' markers all over the transcript.
              text: text,
              tight: true,
              style: NovaTheme.bubble(c).copyWith(
                color: (isUser && !provisional) ? c.onAccent : c.fg,
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
            child: Text(
              displayLabel.toUpperCase(),
              style: NovaTheme.msgLabel(
                c,
              ).copyWith(color: provisional ? c.accent : null),
            ),
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
          // Reporting an assistant reply. Kept off provisional and failed bubbles:
          // there is no finished answer to report in either case.
          if (onReport != null && !isUser && !provisional && !pending && !failed) ...[
            const SizedBox(height: 4),
            Semantics(
              button: true,
              label: 'Report this reply',
              child: GestureDetector(
                onTap: onReport,
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.flag_outlined, size: 13, color: c.muted),
                      const SizedBox(width: 4),
                      Text(
                        'Report',
                        style: NovaTheme.msgLabel(c).copyWith(color: c.muted),
                      ),
                    ],
                  ),
                ),
              ),
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
    this.emotion = 'neutral',
    this.animationDensity = NovaAvatarDensity.medium,
  });

  final NovaAvatarState state;
  final String face;

  /// `NovaAvatarPrefs.emotion`, passed through to the rig.
  final String emotion;

  /// `NovaAvatarPrefs.animationDensity`, passed through to the rig.
  final NovaAvatarDensity animationDensity;

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
              NovaAvatarRing(
                size: 180,
                face: face,
                state: state,
                emotion: emotion,
                animationDensity: animationDensity,
              ),
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

/// `.top-bar` from the converse screen: back, the live status, the
/// "speak replies" toggle, and history. [status] is passed in because the
/// Converse screen owns the voice state machine.
class NovaConversationTopBar extends StatelessWidget {
  const NovaConversationTopBar({
    super.key,
    required this.status,
    this.speakReplies = false,
    this.onBack,
    this.onHistory,
    this.onToggleSpeak,
  });

  final Widget status;

  /// Whether NOVA reads replies aloud. Defaults to off — never surprise a user
  /// with audio.
  final bool speakReplies;

  final VoidCallback? onBack;
  final VoidCallback? onHistory;
  final VoidCallback? onToggleSpeak;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return Padding(
      padding: const EdgeInsets.only(
        top: 44,
        bottom: 8,
        left: NovaSpace.gutter,
        right: NovaSpace.gutter,
      ),
      child: Row(
        children: [
          NovaIconButton(
            icon: Icons.arrow_back_rounded,
            size: 36,
            tooltip: 'Back',
            onTap: onBack,
          ),
          Expanded(
            child: Center(
              child: FittedBox(fit: BoxFit.scaleDown, child: status),
            ),
          ),
          NovaIconButton(
            icon: speakReplies
                ? Icons.volume_up_rounded
                : Icons.volume_off_rounded,
            size: 36,
            tooltip: speakReplies ? 'Speak replies: on' : 'Speak replies: off',
            color: speakReplies ? c.accent : c.fg,
            onTap: onToggleSpeak,
          ),
          const SizedBox(width: NovaSpace.xxs),
          NovaIconButton(
            icon: Icons.history_rounded,
            size: 36,
            tooltip: 'Conversation history',
            onTap: onHistory,
          ),
        ],
      ),
    );
  }
}
