import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'admin_api.dart';
import 'admin_list_panels.dart';
import 'admin_users_panel.dart';
import 'admin_panels.dart';

/// The `Workspace` section of `admin/admin.html`: the section title and the
/// six-row menu card.
///
/// Two rows are real (`Users & Groups` -> `GET /api/v1/admin/users`,
/// `Audit logs` -> `GET /api/v1/admin/audit-logs`). The other four have no route
/// behind them anywhere in `services/api`, so they render disabled and explain
/// why instead of carrying the export's invented sub-lines ("6 active · 3
/// pending", "2,481 entries this month").

/// `.section-title`.
class AdminSectionTitle extends StatelessWidget {
  const AdminSectionTitle({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    // `.section-title` is 14px display-700 muted with .08em tracking, which is
    // larger than the `overline` style the other screens use.
    return Text(
      'WORKSPACE',
      style: NovaTheme.sectionHeading(c)
          .copyWith(color: c.muted, fontSize: 14, letterSpacing: 1.12),
    );
  }
}

// ─── Workspace menu ───────────────────────────────────────────────────────────

/// `.menu-card` — the six `Workspace` rows.
class AdminWorkspaceMenu extends ConsumerWidget {
  const AdminWorkspaceMenu({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final users = ref.watch(adminUsersProvider);
    final audit = ref.watch(adminAuditLogProvider);

    final usersPage = users.asData?.value;
    final String usersSub;
    if (usersPage == null) {
      usersSub = users.hasError ? 'Could not load — tap to retry' : 'Loading…';
    } else {
      final active = usersPage.items.where((u) => u.isActive).length;
      final members =
          '${usersPage.totalItems} '
          '${usersPage.totalItems == 1 ? 'member' : 'members'}';
      usersSub =
          '$members · ${usersPage.truncated ? '$active+' : '$active'} active';
    }

    final auditPage = audit.asData?.value;
    final String auditSub;
    if (auditPage == null) {
      auditSub = audit.hasError ? 'Could not load — tap to retry' : 'Loading…';
    } else {
      auditSub = '${auditPage.totalItems} entries recorded';
    }

    final rows = <Widget>[
      AdminMenuRow(
        emoji: '👥',
        label: 'Users & Groups',
        subtitle: usersSub,
        onTap: () => showAdminUsersSheet(context),
      ),
      const AdminMenuRow(
        emoji: '🔑',
        label: 'SSO / SAML / SCIM',
        subtitle: 'Not available in this build',
        enabled: false,
        reason:
            'The API has no SSO, SAML or SCIM route — the only match for those '
            'terms in services/api is a rate-limiter regex. Identity-provider '
            'configuration lives outside this API.',
      ),
      const AdminMenuRow(
        emoji: '🔌',
        label: 'Integrations & Approvals',
        subtitle: 'Not available in this build',
        enabled: false,
        reason:
            'There is no workspace-level integrations or approvals endpoint. '
            '/api/v1/tools/approvals is scoped to the signed-in user '
            '(toolApprovals.userId), so it is not a workspace approval queue '
            'and no "active · pending" counts exist to show.',
      ),
      const AdminMenuRow(
        emoji: '📋',
        label: 'Tool policy rules',
        subtitle: 'Not available in this build',
        enabled: false,
        reason:
            'No tool-policy route exists in the API, and there is no LL0-L4 '
            'policy table to read or write. Policy levels are enforced in '
            'application code, not stored as editable rules.',
      ),
      const AdminMenuRow(
        emoji: '🗂',
        label: 'Retention & legal hold',
        subtitle: 'Not available in this build',
        enabled: false,
        reason:
            'The API has no retention or legal-hold endpoints. A user can '
            'control what NOVA stores through /api/v1/settings/privacy, but '
            'there is no admin-side retention window or hold to configure.',
      ),
      AdminMenuRow(
        emoji: '📊',
        label: 'Audit logs',
        subtitle: auditSub,
        onTap: () => showAdminAuditSheet(context),
      ),
    ];

    return NovaCard(
      radius: 14,
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) Divider(height: 1, color: c.border),
            rows[i],
          ],
        ],
      ),
    );
  }
}

/// `.menu-item` — 32px emoji tile, label, sub-line, chevron.
///
/// A disabled row keeps the design's geometry but shows the honest reason in
/// place of the export's fabricated sub-line, and a lock instead of a chevron.
class AdminMenuRow extends StatelessWidget {
  const AdminMenuRow({
    super.key,
    required this.emoji,
    required this.label,
    required this.subtitle,
    this.onTap,
    this.enabled = true,
    this.reason,
  });

  final String emoji;
  final String label;
  final String subtitle;
  final VoidCallback? onTap;
  final bool enabled;
  final String? reason;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final onTapResolved = enabled
        ? onTap
        : (reason == null
              ? null
              : () => showAdminUnavailableSheet(
                  context,
                  title: label,
                  reason: reason!,
                ));

    return Semantics(
      button: true,
      enabled: enabled,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTapResolved,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            child: Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: c.surfaceRaised,
                    borderRadius: NovaRadius.rSm,
                    border: Border.all(color: c.border),
                  ),
                  child: Opacity(
                    opacity: enabled ? 1 : 0.45,
                    child: Text(emoji, style: const TextStyle(fontSize: 15)),
                  ),
                ),
                const SizedBox(width: NovaSpace.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        label,
                        style: NovaTheme.chip(c).copyWith(
                          fontSize: NovaType.bodySmall,
                          color: enabled ? c.fg : c.muted,
                          fontWeight: NovaType.wMedium,
                          fontVariations: [
                            FontVariation(
                              'wght',
                              NovaTheme.wght(NovaType.wMedium),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelMedium,
                      ),
                    ],
                  ),
                ),
                Icon(
                  enabled ? Icons.chevron_right : Icons.lock_outline_rounded,
                  size: 18,
                  color: c.muted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
