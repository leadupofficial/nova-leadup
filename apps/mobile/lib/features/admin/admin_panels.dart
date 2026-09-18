import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'admin_api.dart';

/// Sheet chrome shared by the admin console's panels.
///
/// Every panel renders one API surface and nothing else: no placeholder rows and
/// no invented counts. A designed panel with no route behind it is opened
/// through [showAdminUnavailableSheet], which states why it cannot exist rather
/// than showing an empty table that reads as "no data".

Future<void> showAdminUnavailableSheet(
  BuildContext context, {
  required String title,
  required String reason,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    builder: (sheetContext) {
      final c = sheetContext.nova;
      return Padding(
        padding: const EdgeInsets.all(NovaSpace.gutter),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.lock_outline_rounded, size: 18, color: c.muted),
                const SizedBox(width: NovaSpace.xs),
                Expanded(
                  child: Text(title, style: NovaTheme.sectionHeading(c)),
                ),
              ],
            ),
            const SizedBox(height: NovaSpace.sm),
            Text(
              'Not available in this build',
              style: NovaTheme.statusPill(c).copyWith(color: c.warning),
            ),
            const SizedBox(height: NovaSpace.sm),
            Text(reason, style: Theme.of(sheetContext).textTheme.bodyMedium),
            const SizedBox(height: NovaSpace.lg),
          ],
        ),
      );
    },
  );
}

/// Presents one of the admin panels on the standard sheet.
Future<void> showAdminSheet(BuildContext context, Widget child) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => child,
  );
}

// ─── Shared sheet chrome ──────────────────────────────────────────────────────

class AdminSheetFrame extends StatelessWidget {
  const AdminSheetFrame({
    super.key,
    required this.title,
    this.subtitle,
    required this.child,
  });

  final String title;
  final String? subtitle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return FractionallySizedBox(
      heightFactor: 0.86,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              NovaSpace.gutter,
              NovaSpace.lg,
              NovaSpace.gutter,
              NovaSpace.sm,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title, style: NovaTheme.sectionHeading(c)),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ],
                  ),
                ),
                NovaIconButton(
                  icon: Icons.close_rounded,
                  size: 36,
                  tooltip: 'Close',
                  onTap: () => Navigator.of(context).maybePop(),
                ),
              ],
            ),
          ),
          Divider(height: 1, color: c.border),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// A caveat about what the panel does and does not contain. Rendered instead of
/// silently trimming the data.
class AdminSheetNote extends StatelessWidget {
  const AdminSheetNote(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: NovaSpace.sm),
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: c.surfaceRaised,
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.border),
      ),
      child: Text(text, style: Theme.of(context).textTheme.bodySmall),
    );
  }
}

class AdminSheetError extends StatelessWidget {
  const AdminSheetError({
    super.key,
    required this.message,
    required this.onDismiss,
  });

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      margin: const EdgeInsets.fromLTRB(
        NovaSpace.gutter,
        NovaSpace.sm,
        NovaSpace.gutter,
        0,
      ),
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: c.danger.withValues(alpha: 0.12),
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.danger.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline_rounded, size: 18, color: c.danger),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Text(
              message,
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: c.danger),
            ),
          ),
          GestureDetector(
            onTap: onDismiss,
            child: Text(
              'Dismiss',
              style: NovaTheme.chip(c).copyWith(color: c.danger),
            ),
          ),
        ],
      ),
    );
  }
}

/// Shared loading / error / empty handling so no panel can render an empty list
/// for a failed request.
Widget adminSheetState<T>(
  AsyncValue<T> async, {
  required String loading,
  required String errorTitle,
  required VoidCallback onRetry,
  required Widget Function(T value) data,
}) {
  return async.when(
    loading: () => NovaStateView(loading: true, title: loading),
    error: (e, _) => NovaStateView(
      icon: Icons.cloud_off_rounded,
      tone: NovaStateTone.error,
      title: errorTitle,
      message: adminErrorMessage(e),
      actionLabel: 'Retry',
      onAction: onRetry,
    ),
    data: data,
  );
}

/// Compact relative timestamp used by the audit and incident rows. Returns
/// `time unknown` for a row with no parseable date rather than inventing one.
String adminRelativeTime(DateTime? time) {
  if (time == null) return 'time unknown';
  final diff = DateTime.now().difference(time);
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
  if (diff.inHours < 24) {
    return '${diff.inHours} hour${diff.inHours == 1 ? '' : 's'} ago';
  }
  if (diff.inDays < 7) {
    return '${diff.inDays} day${diff.inDays == 1 ? '' : 's'} ago';
  }
  return '${time.day}/${time.month}/${time.year}';
}
