import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'admin_api.dart';
import 'admin_models.dart';
import 'admin_incidents_panel.dart';
import 'admin_panels.dart';
import 'admin_users_panel.dart';

/// `.kpi-grid` from `admin/admin.html` — the four KPI cards.
///
/// Three of the four are driven by real routes. `Quota used` is not: the API has
/// no quota, plan-limit or entitlement endpoint, so that card is rendered
/// disabled with the reason rather than with an invented percentage, and the
/// `Incidents` card deliberately ignores the dashboard's hardcoded
/// `status: 'healthy'` literal.

// ─── KPI grid ─────────────────────────────────────────────────────────────────

/// `.kpi-grid` — two columns, 10px gaps.
class AdminKpiGrid extends ConsumerWidget {
  const AdminKpiGrid({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dashboard = ref.watch(adminDashboardProvider);
    final users = ref.watch(adminUsersProvider);
    final usage = ref.watch(adminUsageSummaryProvider);

    return Column(
      children: [
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _activeUsersCard(context, users)),
              const SizedBox(width: 10),
              Expanded(child: _quotaCard(context)),
            ],
          ),
        ),
        const SizedBox(height: 10),
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _costCard(context, usage)),
              const SizedBox(width: 10),
              Expanded(child: _incidentsCard(context, ref, dashboard)),
            ],
          ),
        ),
      ],
    );
  }

  /// `GET /api/v1/admin/users` — a real count of accounts whose server-computed
  /// status is `active` (verified and not disabled), plus a real "this week"
  /// figure derived from `createdAt`.
  Widget _activeUsersCard(
    BuildContext context,
    AsyncValue<AdminList<AdminUser>> users,
  ) {
    final c = context.nova;
    final page = users.asData?.value;
    if (page == null) {
      return users.hasError
          ? _KpiCard(
              label: 'Active users',
              value: '—',
              delta: adminErrorMessage(users.error ?? 'Unknown error'),
              tone: c.danger,
              onTap: () => showAdminUsersSheet(context),
            )
          : const _KpiCard(label: 'Active users', value: '…');
    }

    final active = page.items.where((u) => u.isActive).length;
    final cutoff = DateTime.now().subtract(const Duration(days: 7));
    final recent = page.items
        .where((u) => u.createdAt?.isAfter(cutoff) ?? false)
        .length;
    // The route orders by `createdAt DESC`, so every account created inside the
    // window is a prefix of this page. When the page is full and all of it is
    // inside the window, the figure is a floor and says so.
    final atFloor = page.truncated && recent == page.items.length;
    return _KpiCard(
      label: 'Active users',
      value: page.truncated ? '$active+' : '$active',
      delta: atFloor ? '+$recent+ this week' : '+$recent this week',
      onTap: () => showAdminUsersSheet(context),
    );
  }

  /// Disabled: there is no quota, plan-limit or entitlement route anywhere in
  /// the API, so the export's "68% · Sonnet · 27k/40k" has no source.
  Widget _quotaCard(BuildContext context) => _KpiCard(
    label: 'Quota used',
    value: '—',
    delta: 'Not available in this build',
    disabled: true,
    onTap: () => showAdminUnavailableSheet(
      context,
      title: 'Quota used',
      reason:
          'The API exposes no quota, plan-limit or entitlement endpoint — no '
          'route reports a token ceiling for an organization or a model. The '
          'figure in the design cannot be sourced, so it is not shown.',
    ),
  );

  /// `GET /api/v1/admin/usage/:tenantId/summary` — a real 30-day total for the
  /// selected organization. The route has no month boundary and no
  /// previous-period comparison, so neither is claimed.
  Widget _costCard(BuildContext context, AsyncValue<AdminUsageSummary?> usage) {
    final c = context.nova;
    return switch (usage) {
      AsyncData(value: null) => _KpiCard(
        label: 'Cost this month',
        value: '—',
        delta: 'No workspace to attribute',
        disabled: true,
        onTap: () => showAdminUnavailableSheet(
          context,
          title: 'Cost this month',
          reason:
              'Usage is recorded per organization, and the API has no "my '
              'organization" route: the access token carries no tenant claim '
              'and /api/v1/auth/me does not return one. Once '
              'GET /api/v1/admin/organizations returns an organization this '
              'card reports its real 30-day usage.',
        ),
      ),
      AsyncData(value: final AdminUsageSummary value) => _KpiCard(
        label: 'Cost this month',
        value: _compact(value.totalCost),
        delta: 'API estimate · last 30 days',
        tone: c.muted,
        onTap: () => showAdminUnavailableSheet(
          context,
          title: 'Cost this month',
          reason:
              '${value.totalTokens} tokens over ${value.period} across '
              '${value.totalCalls} recorded calls. The API computes the figure '
              'as round(tokens x 0.00002) and names no currency, so no currency '
              'symbol is printed. There is no previous-period endpoint, so no '
              'comparison is shown.',
        ),
      ),
      AsyncError(:final error) => _KpiCard(
        label: 'Cost this month',
        value: '—',
        delta: adminErrorMessage(error),
        tone: c.danger,
      ),
      _ => const _KpiCard(label: 'Cost this month', value: '…'),
    };
  }

  /// `GET /api/v1/admin/dashboard` metrics — the real count of unresolved
  /// incidents. The dashboard's own `status: 'healthy'` field is a hardcoded
  /// literal and is deliberately not rendered; the honest readiness signal is
  /// `GET /health/ready`, shown in the incidents sheet.
  Widget _incidentsCard(
    BuildContext context,
    WidgetRef ref,
    AsyncValue<AdminDashboard> dashboard,
  ) {
    final c = context.nova;
    return switch (dashboard) {
      AsyncData(:final value) => _KpiCard(
        label: 'Incidents',
        value: '${value.openIncidents}',
        delta: value.openIncidents == 0
            ? 'No open incidents'
            : 'Needs attention',
        tone: value.openIncidents == 0 ? c.success : c.danger,
        onTap: () => showAdminIncidentsSheet(context),
      ),
      AsyncError(:final error) => _KpiCard(
        label: 'Incidents',
        value: '—',
        delta: adminErrorMessage(error),
        tone: c.danger,
        onTap: () => ref.invalidate(adminDashboardProvider),
      ),
      _ => const _KpiCard(label: 'Incidents', value: '…'),
    };
  }
}

/// `.kpi-card` — label, value, delta.
class _KpiCard extends StatelessWidget {
  const _KpiCard({
    required this.label,
    required this.value,
    this.delta,
    this.tone,
    this.onTap,
    this.disabled = false,
  });

  final String label;
  final String value;
  final String? delta;
  final Color? tone;
  final VoidCallback? onTap;
  final bool disabled;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final deltaColor = tone ?? c.success;
    return NovaCard(
      radius: 14,
      padding: const EdgeInsets.all(14),
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label.toUpperCase(), style: NovaTheme.overline(c)),
          const SizedBox(height: 6),
          Text(
            value,
            style: NovaTheme.statValue(c)
                .copyWith(color: disabled ? c.muted : c.fg),
          ),
          if (delta != null) ...[
            const SizedBox(height: NovaSpace.xxs),
            Text(
              delta!,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: deltaColor, fontSize: 11, height: 1.3),
            ),
          ],
        ],
      ),
    );
  }
}

/// `.kpi-value` formatting: `18432` becomes `18.4k`, as the export writes it.
String _compact(int value) {
  if (value >= 1000000) return '${(value / 1000000).toStringAsFixed(1)}M';
  if (value >= 1000) return '${(value / 1000).toStringAsFixed(1)}k';
  return '$value';
}
