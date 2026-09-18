import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'admin_api.dart';
import 'admin_panels.dart';

/// Opens the audit-log panel (`GET /api/v1/admin/audit-logs`).
Future<void> showAdminAuditSheet(BuildContext context) =>
    showAdminSheet(context, const _AuditSheet());

/// Opens the workspace picker (`GET /api/v1/admin/organizations`).
Future<void> showAdminWorkspaceSheet(BuildContext context) =>
    showAdminSheet(context, const _WorkspaceSheet());

// ─── Audit logs ───────────────────────────────────────────────────────────────

class _AuditSheet extends ConsumerWidget {
  const _AuditSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final audit = ref.watch(adminAuditLogProvider);
    final page = audit.asData?.value;
    return AdminSheetFrame(
      title: 'Audit logs',
      subtitle: page == null
          ? 'GET /api/v1/admin/audit-logs'
          : 'GET /api/v1/admin/audit-logs · newest ${page.items.length} of '
                '${page.totalItems}',
      child: adminSheetState(
        audit,
        loading: 'Loading audit logs',
        errorTitle: 'Could not load audit logs',
        onRetry: () => ref.invalidate(adminAuditLogProvider),
        data: (logs) {
          if (logs.items.isEmpty) {
            return const NovaStateView(
              icon: Icons.history_rounded,
              title: 'No audit entries',
              message: 'GET /api/v1/admin/audit-logs returned no rows for this page.',
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
              const AdminSheetNote(
                'Newest entries first. The route filters by action and '
                'organizationId and paginates, but takes no date range, so no '
                '"this month" total can be shown.',
              ),
              const SizedBox(height: NovaSpace.xxs),
              for (final entry in logs.items)
                Padding(
                  padding: const EdgeInsets.only(bottom: NovaSpace.xs),
                  child: NovaCard(
                    padding: const EdgeInsets.all(NovaSpace.sm),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          entry.action,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 2),
                        Text(
                          [
                            entry.actor,
                            if (entry.outcome != null) entry.outcome!,
                            if (entry.targetType != null) entry.targetType!,
                            adminRelativeTime(entry.occurredAt),
                          ].join(' · '),
                          style: NovaTheme.msgLabel(context.nova),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

// ─── Workspace picker ─────────────────────────────────────────────────────────

/// `GET /api/v1/admin/organizations`.
///
/// The API has no "my organization" route and the access token carries no tenant
/// claim, so the console lists what exists and lets the owner choose, instead of
/// guessing which one is theirs.
class _WorkspaceSheet extends ConsumerWidget {
  const _WorkspaceSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final orgs = ref.watch(adminOrganizationsProvider);
    final current = ref.watch(adminSelectedWorkspaceProvider);
    return AdminSheetFrame(
      title: 'Workspace',
      subtitle: 'GET /api/v1/admin/organizations',
      child: adminSheetState(
        orgs,
        loading: 'Loading organizations',
        errorTitle: 'Could not load organizations',
        onRetry: () => ref.invalidate(adminOrganizationsProvider),
        data: (orgPage) {
          if (orgPage.items.isEmpty) {
            return const NovaStateView(
              icon: Icons.apartment_rounded,
              title: 'No organizations',
              message:
                  'GET /api/v1/admin/organizations returned no rows, so there '
                  'is no usage to attribute.',
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
              const AdminSheetNote(
                'Usage is recorded per organization. This build defaults to the '
                'newest organization the API returns and lets you switch; it '
                'never assumes the signed-in account belongs to one.',
              ),
              const SizedBox(height: NovaSpace.xxs),
              for (final org in orgPage.items)
                NovaListRow(
                  title: org.name,
                  subtitle: [
                    if (org.plan.isNotEmpty) org.plan,
                    if (org.slug.isNotEmpty) org.slug,
                    org.members == 1 ? '1 member' : '${org.members} members',
                  ].join(' · '),
                  icon: Icons.apartment_rounded,
                  trailing: current?.id == org.id
                      ? Icon(
                          Icons.check_circle_rounded,
                          size: 18,
                          color: context.nova.accent,
                        )
                      : null,
                  onTap: () {
                    ref.read(adminWorkspaceProvider.notifier).select(org.id);
                    Navigator.of(context).maybePop();
                  },
                ),
            ],
          );
        },
      ),
    );
  }
}
