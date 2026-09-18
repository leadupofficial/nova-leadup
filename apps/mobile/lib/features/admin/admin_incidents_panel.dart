import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'admin_api.dart';
import 'admin_models.dart';
import 'admin_panels.dart';

/// Opens the incidents panel.
Future<void> showAdminIncidentsSheet(BuildContext context) =>
    showAdminSheet(context, const _IncidentsSheet());

// ─── Incidents & readiness ────────────────────────────────────────────────────

/// `GET /api/v1/admin/incidents?resolved=false`,
/// `POST /api/v1/admin/incidents/:id/resolve` and `GET /health/ready`.
///
/// The readiness report is the only honest health signal in the API: the
/// `status: 'healthy'` field on `/admin/dashboard` is a hardcoded literal, so it
/// is never rendered.
class _IncidentsSheet extends ConsumerStatefulWidget {
  const _IncidentsSheet();

  @override
  ConsumerState<_IncidentsSheet> createState() => _IncidentsSheetState();
}

class _IncidentsSheetState extends ConsumerState<_IncidentsSheet> {
  String? _busyId;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final incidents = ref.watch(adminIncidentsProvider);
    final page = incidents.asData?.value;
    return AdminSheetFrame(
      title: 'Incidents',
      subtitle: page == null
          ? 'GET /api/v1/admin/incidents?resolved=false'
          : '${page.totalItems} unresolved · GET '
                '/api/v1/admin/incidents?resolved=false',
      child: Column(
        children: [
          const _ReadinessPanel(),
          if (_error != null)
            AdminSheetError(
              message: _error!,
              onDismiss: () => setState(() => _error = null),
            ),
          Expanded(
            child: adminSheetState(
              incidents,
              loading: 'Loading incidents',
              errorTitle: 'Could not load incidents',
              onRetry: () => ref.invalidate(adminIncidentsProvider),
              data: (open) {
                if (open.items.isEmpty) {
                  return const NovaStateView(
                    icon: Icons.verified_outlined,
                    tone: NovaStateTone.success,
                    title: 'No open incidents',
                    message:
                        'GET /api/v1/admin/incidents?resolved=false returned no '
                        'rows.',
                  );
                }
                return ListView(
                  padding: const EdgeInsets.fromLTRB(
                    NovaSpace.gutter,
                    NovaSpace.sm,
                    NovaSpace.gutter,
                    NovaSpace.lg,
                  ),
                  children: [
                    for (final incident in open.items)
                      Padding(
                        padding: const EdgeInsets.only(bottom: NovaSpace.xs),
                        child: _IncidentTile(
                          incident: incident,
                          busy: _busyId == incident.id,
                          onResolve: _busyId == null
                              ? () => _resolve(incident)
                              : null,
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _resolve(AdminIncident incident) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Resolve incident?'),
        content: Text(
          'POST /api/v1/admin/incidents/${incident.id}/resolve sets '
          'resolved = true with the current timestamp.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Resolve'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      _busyId = incident.id;
      _error = null;
    });
    try {
      await ref.read(adminMutationsProvider).resolveIncident(incident.id);
    } catch (e) {
      if (mounted) setState(() => _error = adminErrorMessage(e));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }
}

class _IncidentTile extends StatelessWidget {
  const _IncidentTile({
    required this.incident,
    required this.busy,
    required this.onResolve,
  });

  final AdminIncident incident;
  final bool busy;
  final VoidCallback? onResolve;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final tone = switch (incident.severity) {
      'critical' || 'error' => c.danger,
      'warning' => c.warning,
      _ => c.muted,
    };

    return NovaCard(
      padding: const EdgeInsets.all(NovaSpace.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.report_problem_outlined, size: 20, color: tone),
          const SizedBox(width: NovaSpace.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  incident.title,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 2),
                Text(
                  '${incident.severity} · ${adminRelativeTime(incident.occurredAt)}',
                  style: NovaTheme.msgLabel(c),
                ),
                if (incident.description != null) ...[
                  const SizedBox(height: NovaSpace.xxs),
                  Text(
                    incident.description!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: NovaSpace.xs),
          if (busy)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            NovaSecondaryButton(label: 'Resolve', onPressed: onResolve),
        ],
      ),
    );
  }
}

/// `GET /health/ready` — the API's real dependency report.
class _ReadinessPanel extends ConsumerWidget {
  const _ReadinessPanel();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final readiness = ref.watch(adminReadinessProvider);

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NovaSpace.gutter,
        NovaSpace.sm,
        NovaSpace.gutter,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          readiness.when(
            loading: () => Row(
              children: [
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: NovaSpace.xs),
                Text(
                  'Running /health/ready',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
            error: (e, _) => Row(
              children: [
                Expanded(
                  child: Text(
                    'Could not run /health/ready: ${adminErrorMessage(e)}',
                    style: Theme.of(context).textTheme.bodySmall!
                        .copyWith(color: c.danger),
                  ),
                ),
                NovaSecondaryButton(
                  label: 'Retry',
                  onPressed: () => ref.invalidate(adminReadinessProvider),
                ),
              ],
            ),
            data: (report) => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      report.isHealthy
                          ? Icons.check_circle_outline_rounded
                          : Icons.warning_amber_rounded,
                      size: 18,
                      color: report.isHealthy
                          ? c.success
                          : (report.isDegraded ? c.warning : c.danger),
                    ),
                    const SizedBox(width: NovaSpace.xs),
                    Expanded(
                      child: Text(
                        'API readiness: ${report.status} · ${report.up} up · '
                        '${report.down} down',
                        style: Theme.of(context).textTheme.bodySmall!.copyWith(
                          color: report.isHealthy
                              ? c.success
                              : (report.isDegraded ? c.warning : c.danger),
                        ),
                      ),
                    ),
                    NovaSecondaryButton(
                      label: 'Recheck',
                      onPressed: () => ref.invalidate(adminReadinessProvider),
                    ),
                  ],
                ),
                if (report.note != null)
                  Padding(
                    padding: const EdgeInsets.only(top: NovaSpace.xxs),
                    child: Text(
                      report.note!,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                if (report.checks.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: NovaSpace.xs),
                    child: Wrap(
                      spacing: NovaSpace.xs,
                      runSpacing: NovaSpace.xxs,
                      children: [
                        for (final check in report.checks)
                          NovaChip(
                            label:
                                '${check.name} ${check.status}'
                                '${check.latencyMs > 0 ? ' ${check.latencyMs}ms' : ''}',
                            icon: check.status == 'up' || check.status == 'pass'
                                ? Icons.check_rounded
                                : Icons.remove_rounded,
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.only(top: NovaSpace.xs),
            child: AdminSheetNote(
              '/admin/dashboard reports status: "healthy" and two passing '
              'checks as hardcoded literals, so those fields are ignored here. '
              'This panel is the API\'s own /health/ready dependency report.',
            ),
          ),
        ],
      ),
    );
  }
}
