import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/design/widgets/index.dart';

/// Activity Centre — port of `activity/activity.html`.
///
/// The export's filter row is All / Pending / Approvals / Completed / Errors;
/// these are applied server-side via `GET /api/v1/activity?action=&outcome=`
/// rather than filtering a truncated client page, so the tab counts stay honest
/// for users with more history than one page holds.
enum _Filter {
  all('All'),
  pending('Pending'),
  approvals('Approvals'),
  completed('Completed'),
  errors('Errors');

  const _Filter(this.label);
  final String label;

  /// Maps onto the API's query parameters. `approvals` is an action filter
  /// because there is no dedicated approval outcome on audit rows.
  String? get outcome => switch (this) {
    _Filter.all => null,
    _Filter.approvals => null,
    _Filter.pending => 'pending',
    _Filter.completed => 'success',
    _Filter.errors => 'failure',
  };

  String? get action => this == _Filter.approvals ? 'approval' : null;
}

final activityFilterProvider = NotifierProvider<_ActivityFilter, _Filter>(
  _ActivityFilter.new,
);

class _ActivityFilter extends Notifier<_Filter> {
  @override
  _Filter build() => _Filter.all;
  void set(_Filter f) => state = f;
}

final filteredActivityProvider =
    FutureProvider.autoDispose<List<NovaActivityItem>>((ref) async {
      final filter = ref.watch(activityFilterProvider);
      final api = ref.watch(novaApiProvider);
      return api.listActivity(
        action: filter.action,
        outcome: filter.outcome,
        limit: 100,
      );
    });

class ActivityPage extends ConsumerWidget {
  const ActivityPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final filter = ref.watch(activityFilterProvider);
    final items = ref.watch(filteredActivityProvider);

    return NovaScaffold(
      topBar: Row(
        children: [
          Expanded(
            child: Text('Activity Centre', style: NovaTheme.heroName(c)),
          ),
          NovaIconButton(
            icon: Icons.refresh_rounded,
            tooltip: 'Refresh',
            onTap: () => ref.invalidate(filteredActivityProvider),
          ),
        ],
      ),
      refresh: () async => ref.invalidate(filteredActivityProvider),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // `.filters` — horizontally scrolling chips.
          SizedBox(
            height: 40,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: _Filter.values.length,
              separatorBuilder: (_, _) => const SizedBox(width: NovaSpace.xs),
              itemBuilder: (context, i) {
                final f = _Filter.values[i];
                return Center(
                  child: NovaChip(
                    label: f.label,
                    selected: filter == f,
                    onTap: () =>
                        ref.read(activityFilterProvider.notifier).set(f),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: NovaSpace.lg),
          items.when(
            loading: () => const NovaStateView(
              loading: true,
              title: 'Loading activity',
            ),
            error: (e, _) => NovaStateView(
              icon: Icons.cloud_off_rounded,
              tone: NovaStateTone.error,
              title: 'Could not load activity',
              message: e.toString().replaceFirst(
                RegExp(r'^NovaApiException\(\d*\): '),
                '',
              ),
              actionLabel: 'Retry',
              onAction: () => ref.invalidate(filteredActivityProvider),
            ),
            data: (list) => list.isEmpty
                ? NovaStateView(
                    icon: Icons.history_rounded,
                    title: filter == _Filter.all
                        ? 'Nothing here yet'
                        : 'No ${filter.label.toLowerCase()} activity',
                    message:
                        'Account and privacy events are recorded here.',
                  )
                : Column(
                    children: list
                        .map((item) => _ActivityTile(item: item))
                        .toList(growable: false),
                  ),
          ),
        ],
      ),
    );
  }
}

class _ActivityTile extends StatelessWidget {
  const _ActivityTile({required this.item});

  final NovaActivityItem item;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    final (icon, tone) = item.isError
        ? (Icons.error_outline_rounded, c.danger)
        : item.isPending || item.isApproval
        ? (Icons.pending_outlined, c.warning)
        : (Icons.check_circle_outline_rounded, c.success);

    final subtitle = [
      _relative(item.occurredAt),
      if (item.isPending || item.isApproval) 'awaiting your confirmation',
      if (item.isCompleted) 'completed successfully',
      if (item.isError) (item.details?['message'] ?? 'failed').toString(),
      if (item.sourceDevice != null) 'via ${item.sourceDevice}',
    ].whereType<String>().join(' · ');

    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.xs),
      child: NovaCard(
        padding: const EdgeInsets.all(NovaSpace.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: tone, size: 20),
            const SizedBox(width: NovaSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 2),
                  Text(subtitle, style: NovaTheme.msgLabel(c)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _relative(DateTime? t) {
  if (t == null) return 'just now';
  final d = DateTime.now().difference(t);
  if (d.inSeconds < 60) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} hour${d.inHours == 1 ? '' : 's'} ago';
  if (d.inDays < 7) return '${d.inDays} day${d.inDays == 1 ? '' : 's'} ago';
  return '${t.day}/${t.month}/${t.year}';
}
