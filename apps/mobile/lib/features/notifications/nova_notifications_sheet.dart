import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../../core/theme/nova_theme.dart';

/// Opens NOVA's inbox.
///
/// The bell on Home showed a hardcoded `0` and navigated to Profile. `/notifications`
/// — list, unread count, mark-read, delete — has existed all along and the app
/// called none of it, so a nudge existed only as a system notification: dismiss
/// the shade and there was no way to find it again.
Future<void> showNovaNotificationsSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const _NotificationsSheet(),
  );
}

class _NotificationsSheet extends ConsumerStatefulWidget {
  const _NotificationsSheet();

  @override
  ConsumerState<_NotificationsSheet> createState() => _NotificationsSheetState();
}

class _NotificationsSheetState extends ConsumerState<_NotificationsSheet> {
  bool _busy = false;

  /// Marks read on the server, then refreshes both the list and the bell badge.
  Future<void> _markRead(NovaNotification notification) async {
    if (notification.read || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(novaApiProvider).markNotificationRead(notification.id);
    } on NovaApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error.message)),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      ref.invalidate(notificationsProvider);
      ref.invalidate(unreadNotificationCountProvider);
    }
  }

  Future<void> _dismiss(NovaNotification notification) async {
    setState(() => _busy = true);
    try {
      await ref.read(novaApiProvider).deleteNotification(notification.id);
    } on NovaApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error.message)),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      ref.invalidate(notificationsProvider);
      ref.invalidate(unreadNotificationCountProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final notifications = ref.watch(notificationsProvider);

    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.78,
      ),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: const BorderRadius.vertical(
          top: Radius.circular(NovaRadius.lg),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(NovaSpace.gutter),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Notifications', style: NovaTheme.sectionHeading(c)),
              const SizedBox(height: NovaSpace.xs),
              Text(
                'Reminders, follow-ups and briefings NOVA has raised.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
              const SizedBox(height: NovaSpace.md),
              Flexible(
                child: notifications.when(
                  loading: () => const Padding(
                    padding: EdgeInsets.symmetric(vertical: NovaSpace.xl),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (error, _) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: NovaSpace.lg),
                    child: Text(
                      error is NovaApiException
                          ? error.message
                          : 'Notifications could not be loaded.',
                      style: Theme.of(
                        context,
                      ).textTheme.bodyMedium!.copyWith(color: c.danger),
                    ),
                  ),
                  data: (items) => items.isEmpty
                      ? Padding(
                          padding: const EdgeInsets.symmetric(
                            vertical: NovaSpace.xl,
                          ),
                          child: Center(
                            child: Text(
                              'Nothing yet. Reminders and follow-ups will appear here.',
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.bodyMedium!
                                  .copyWith(color: c.muted),
                            ),
                          ),
                        )
                      : ListView.separated(
                          shrinkWrap: true,
                          itemCount: items.length,
                          separatorBuilder: (_, _) =>
                              const SizedBox(height: NovaSpace.sm),
                          itemBuilder: (context, index) => _NotificationRow(
                            notification: items[index],
                            onTap: () => _markRead(items[index]),
                            onDismiss: () => _dismiss(items[index]),
                          ),
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NotificationRow extends StatelessWidget {
  const _NotificationRow({
    required this.notification,
    required this.onTap,
    required this.onDismiss,
  });

  final NovaNotification notification;
  final VoidCallback onTap;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final unread = !notification.read;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(NovaSpace.sm),
        decoration: BoxDecoration(
          color: unread ? c.surfaceRaised : c.surface,
          borderRadius: BorderRadius.circular(NovaRadius.card),
          border: Border.all(color: unread ? c.accent : c.border),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Icon(
                unread
                    ? Icons.notifications_active_rounded
                    : Icons.notifications_none_rounded,
                size: 18,
                color: unread ? c.accent : c.muted,
              ),
            ),
            const SizedBox(width: NovaSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    notification.title,
                    style: Theme.of(context).textTheme.titleSmall!.copyWith(
                      color: c.fg,
                      fontWeight: unread ? NovaType.wSemiBold : NovaType.wMedium,
                    ),
                  ),
                  if (notification.body.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      notification.body,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall!.copyWith(color: c.muted),
                    ),
                  ],
                  if (notification.occurredAt != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      _ago(notification.occurredAt!),
                      style: Theme.of(
                        context,
                      ).textTheme.labelSmall!.copyWith(color: c.muted),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              icon: const Icon(Icons.close_rounded, size: 18),
              tooltip: 'Dismiss',
              color: c.muted,
              onPressed: onDismiss,
            ),
          ],
        ),
      ),
    );
  }

  /// Coarse by design: "just now" / "12m" / "3h" / "2d" reads better than a
  /// timestamp for something the user is skimming, and it needs no locale data.
  static String _ago(DateTime when) {
    final delta = DateTime.now().difference(when);
    if (delta.inMinutes < 1) return 'just now';
    if (delta.inHours < 1) return '${delta.inMinutes}m ago';
    if (delta.inDays < 1) return '${delta.inHours}h ago';
    return '${delta.inDays}d ago';
  }
}
