import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';
import 'nova_controls.dart';

/// The inline notice Converse shows for a recoverable failure (mic denied,
/// transcription failed, speech unavailable); never swallowed.
class NovaChatNotice extends StatelessWidget {
  const NovaChatNotice({
    super.key,
    required this.message,
    this.tone,
    this.icon = Icons.info_outline_rounded,
    this.onDismiss,
  });

  final String message;
  final Color? tone;
  final IconData icon;

  /// Shown as a dismiss affordance when set. A voice session error has to be
  /// clearable, otherwise the screen stays stuck in its error state.
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final color = tone ?? c.warning;

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: NovaSpace.gutter,
        vertical: NovaSpace.xs,
      ),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(NovaSpace.sm),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: NovaRadius.rControl,
          border: Border.all(color: color.withValues(alpha: 0.35)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: NovaSpace.xs),
            Expanded(
              child: Text(
                message,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.fg),
              ),
            ),
            if (onDismiss != null) ...[
              const SizedBox(width: NovaSpace.xs),
              Semantics(
                button: true,
                label: 'Dismiss',
                child: GestureDetector(
                  onTap: onDismiss,
                  child: Icon(Icons.close_rounded, size: 16, color: color),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
/// `.quick-actions` — horizontally scrolling suggestion chips.
class NovaQuickActions extends StatelessWidget {
  const NovaQuickActions({
    super.key,
    required this.enabled,
    required this.onPick,
  });

  final bool enabled;
  final ValueChanged<String> onPick;

  static const _actions = <(IconData, String, String)>[
    (Icons.check_circle_outline_rounded, 'Create task', 'Create a task: '),
    (Icons.alarm_add_rounded, 'Set reminder', 'Remind me to '),
    (Icons.search_rounded, 'Search memory', 'What do you remember about '),
    (Icons.translate_rounded, 'Translate', 'Translate this to Tamil: '),
  ];

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: NovaSpace.gutter),
        itemCount: _actions.length,
        separatorBuilder: (_, _) => const SizedBox(width: NovaSpace.xs),
        itemBuilder: (context, i) {
          final (icon, label, prefix) = _actions[i];
          return Center(
            child: Opacity(
              opacity: enabled ? 1 : 0.5,
              child: NovaChip(
                label: label,
                icon: icon,
                onTap: enabled ? () => onPick(prefix) : null,
              ),
            ),
          );
        },
      ),
    );
  }
}
