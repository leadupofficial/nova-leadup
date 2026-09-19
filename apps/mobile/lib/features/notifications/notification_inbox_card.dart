import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';
import 'notification_controller.dart';
import 'notification_models.dart';

/// The filtered notifications held in memory, with the per-session read-aloud
/// action.
class NotificationInboxCard extends StatelessWidget {
  const NotificationInboxCard({
    super.key,
    required this.state,
    required this.controller,
    required this.readAloud,
  });

  final NotificationAssistantState state;
  final NotificationAssistantController controller;
  final Future<void> Function(UntrustedNotificationData data) readAloud;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    if (state.inbox.isEmpty) {
      return NovaCard(
        child: Text(
          state.isEnabled
              ? 'Nothing yet. Allowed, high-priority work notifications appear '
                    'here for this session only, and are gone when NOVA closes.'
              : 'Turn the assistant on to see summaries here.',
          style: Theme.of(
            context,
          ).textTheme.bodySmall!.copyWith(color: c.muted),
        ),
      );
    }

    return NovaCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var i = 0; i < state.inbox.length; i++) ...[
            if (i > 0) Divider(height: 1, color: c.border),
            _InboxRow(
              data: state.inbox[i],
              readAloudEnabled: state.readAloudEnabled && state.isEnabled,
              onReadAloud: () => readAloud(state.inbox[i]),
              onDismiss: () => controller.dismiss(state.inbox[i]),
            ),
          ],
          Divider(height: 1, color: c.border),
          Padding(
            padding: const EdgeInsets.all(NovaSpace.sm),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Held in memory only — never written to disk.',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall!.copyWith(color: c.muted),
                  ),
                ),
                NovaSecondaryButton(
                  label: 'Clear',
                  icon: Icons.delete_outline_rounded,
                  onPressed: controller.clearInbox,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _InboxRow extends StatelessWidget {
  const _InboxRow({
    required this.data,
    required this.readAloudEnabled,
    required this.onReadAloud,
    required this.onDismiss,
  });

  final UntrustedNotificationData data;
  final bool readAloudEnabled;
  final VoidCallback onReadAloud;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Padding(
      padding: const EdgeInsets.all(NovaSpace.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  data.appLabel,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              Text(
                _time(data.postedAt),
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(data.preview, style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: NovaSpace.xs),
          Wrap(
            spacing: NovaSpace.xs,
            runSpacing: NovaSpace.xs,
            children: [
              NovaChip(
                label: 'Read aloud',
                icon: Icons.volume_up_outlined,
                onTap: onReadAloud,
              ),
              NovaChip(
                label: 'Dismiss',
                icon: Icons.close_rounded,
                onTap: onDismiss,
              ),
              if (!readAloudEnabled)
                Text(
                  'read-aloud off',
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall!.copyWith(color: c.muted),
                ),
            ],
          ),
        ],
      ),
    );
  }

  static String _time(DateTime at) {
    final local = at.toLocal();
    final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
    final minute = local.minute.toString().padLeft(2, '0');
    return "$hour:$minute ${local.hour < 12 ? 'AM' : 'PM'}";
  }
}
