import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'admin_api.dart';
import 'admin_kpis.dart';
import 'admin_list_panels.dart';
import 'admin_menu.dart';

/// Admin Console — port of `admin/admin.html`.
///
/// **Real vs. unavailable.** `services/api/src/routes/admin.ts` is mounted at
/// `/api/v1/admin` (`server.ts:70`) and is live, so this screen is wired to it
/// rather than being a static port: the workspace card, the user/incident/audit
/// counts and the 30-day usage figures are all fetched, and blocking an account
/// or resolving an incident are real PATCH/POST writes. The panels the API has
/// no route for — SSO/SAML/SCIM, workspace integrations, tool-policy rules and
/// retention/legal hold — are rendered disabled, with the reason shown on tap.
/// No number, account or audit row on this screen is invented, and the
/// dashboard's hardcoded `status: 'healthy'` literal is never rendered.
///
/// **Access.** The screen is gated on [adminRoleProvider], which reads the
/// `role` claim out of the session's access token. That is a decode, not a
/// verification, and it grants nothing — `requireAdmin` on the server is the
/// authority and answers 403 to everyone else.
class AdminPage extends ConsumerWidget {
  const AdminPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final role = ref.watch(adminRoleProvider);
    final allowed = isAdminRole(role);

    return NovaScaffold(
      topBar: const _AdminTopBar(),
      refresh: allowed ? () async => _refreshAll(ref) : null,
      child: allowed ? const _AdminBody() : _OwnerGate(role: role),
    );
  }

  static void _refreshAll(WidgetRef ref) {
    ref.invalidate(adminDashboardProvider);
    ref.invalidate(adminUsersProvider);
    ref.invalidate(adminOrganizationsProvider);
    ref.invalidate(adminAuditLogProvider);
    ref.invalidate(adminIncidentsProvider);
    ref.invalidate(adminUsageSummaryProvider);
    ref.invalidate(adminReadinessProvider);
  }
}

/// `.top-bar` — back button, `h1`, and the `V2 · Beta` pill.
class _AdminTopBar extends StatelessWidget {
  const _AdminTopBar();

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Row(
      children: [
        NovaIconButton(
          icon: Icons.chevron_left_rounded,
          size: 36,
          tooltip: 'Back',
          onTap: () => Navigator.of(context).maybePop(),
        ),
        // The export uses `justify-content: space-between` across three items,
        // which distributes the free space evenly — two Spacers reproduce it.
        const Spacer(),
        Flexible(
          child: Text(
            'Admin Console',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            // The export sets 19px; brand-spec.md's authoritative H3 is 17px,
            // which is what `sectionHeading` carries.
            style: NovaTheme.sectionHeading(c),
          ),
        ),
        const Spacer(),
        const _BetaPill(),
      ],
    );
  }
}

/// `.tab-pill`.
class _BetaPill extends StatelessWidget {
  const _BetaPill();

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: c.accent.withValues(alpha: 0.15),
        borderRadius: NovaRadius.rPill,
        border: Border.all(color: c.accent.withValues(alpha: 0.3)),
      ),
      child: Text(
        'V2 · Beta',
        style: NovaTheme.statusPill(c).copyWith(color: c.accent),
      ),
    );
  }
}

// ─── Body ─────────────────────────────────────────────────────────────────────

class _AdminBody extends StatelessWidget {
  const _AdminBody();

  @override
  Widget build(BuildContext context) {
    // `.content { padding: 8px 24px 0 }`; the 24px gutter comes from
    // [NovaScaffold]. The export's margins collapse, so the 16px below the KPI
    // grid and the section title's 20px top margin resolve to 20px.
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(height: NovaSpace.xs),
        _WorkspaceCard(),
        SizedBox(height: NovaSpace.md),
        AdminKpiGrid(),
        SizedBox(height: 20),
        AdminSectionTitle(),
        SizedBox(height: NovaSpace.sm),
        AdminWorkspaceMenu(),
      ],
    );
  }
}

/// `.cover-card`.
class _WorkspaceCard extends ConsumerWidget {
  const _WorkspaceCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final orgs = ref.watch(adminOrganizationsProvider);
    final selectedId = ref.watch(adminWorkspaceProvider);
    final page = orgs.asData?.value;
    final org = (page == null || page.items.isEmpty)
        ? null
        : page.items.firstWhere(
            (o) => o.id == selectedId,
            orElse: () => page.items.first,
          );
    final switchable = (page?.items.length ?? 0) > 1;

    final String name;
    final List<String> meta;
    VoidCallback? onTap;

    if (orgs.hasError && page == null) {
      name = 'Workspace unavailable';
      meta = [adminErrorMessage(orgs.error ?? 'Unknown error')];
      onTap = () => ref.invalidate(adminOrganizationsProvider);
    } else if (org == null && page != null) {
      name = 'No workspace';
      meta = const ['The API returned no organizations'];
    } else if (org == null) {
      name = 'Loading workspace…';
      meta = const <String>[];
    } else {
      name = switchable ? '${page?.totalItems ?? 0} workspaces' : org.name;
      meta = [
        if (org.plan.isNotEmpty) org.plan,
        org.members == 1 ? '1 member' : '${org.members} members',
      ];
      onTap = switchable ? () => showAdminWorkspaceSheet(context) : null;
    }

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: NovaRadius.rBubble,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                c.accent.withValues(alpha: 0.18),
                c.accentSecondary.withValues(alpha: 0.12),
              ],
            ),
            borderRadius: NovaRadius.rBubble,
            border: Border.all(color: c.accent.withValues(alpha: 0.2)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(name, style: NovaTheme.statValue(c)),
              const SizedBox(height: NovaSpace.xxs),
              Row(
                children: [
                  for (var i = 0; i < meta.length; i++) ...[
                    if (i > 0)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: NovaSpace.xs,
                        ),
                        child: Text(
                          '·',
                          style: NovaTheme.dateLine(c)
                              .copyWith(color: c.accent),
                        ),
                      ),
                    Flexible(
                      child: Text(
                        meta[i],
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: NovaTheme.dateLine(c),
                      ),
                    ),
                  ],
                  if (meta.isEmpty) const _InlineSpinner(),
                ],
              ),
              if (switchable)
                Padding(
                  padding: const EdgeInsets.only(top: NovaSpace.xs),
                  child: Text(
                    'Tap to switch workspace',
                    style: NovaTheme.msgLabel(c),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InlineSpinner extends StatelessWidget {
  const _InlineSpinner();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 12,
      height: 12,
      child: CircularProgressIndicator(
        strokeWidth: 2,
        color: context.nova.muted,
      ),
    );
  }
}

// ─── Owner gate ───────────────────────────────────────────────────────────────

/// Refusal state for a session that is not owner/admin.
///
/// No admin request is made from this branch: the admin data providers are only
/// watched by the signed-in body, so a non-owner never issues one.
class _OwnerGate extends StatelessWidget {
  const _OwnerGate({required this.role});

  final String? role;

  @override
  Widget build(BuildContext context) {
    return NovaStateView(
      icon: Icons.lock_outline_rounded,
      tone: NovaStateTone.neutral,
      title: 'Owner access required',
      message: role == null
          ? 'This session has no role claim in its access token, so the '
                'console cannot establish admin access. The admin API answers '
                '403 to anything that is not owner or admin.'
          : 'The admin console is limited to the owner and admin roles. This '
                'session is signed in as "$role", and every /api/v1/admin route '
                'would answer 403.',
    );
  }
}
