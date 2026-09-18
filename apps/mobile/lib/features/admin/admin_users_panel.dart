import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'admin_api.dart';
import 'admin_models.dart';
import 'admin_panels.dart';

/// Opens the users panel.
Future<void> showAdminUsersSheet(BuildContext context) =>
    showAdminSheet(context, const _UsersSheet());

// ─── Users ────────────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/users` plus one of the two real mutations this console
/// performs: `PATCH /api/v1/admin/users/:id { disabled }`.
class _UsersSheet extends ConsumerStatefulWidget {
  const _UsersSheet();

  @override
  ConsumerState<_UsersSheet> createState() => _UsersSheetState();
}

class _UsersSheetState extends ConsumerState<_UsersSheet> {
  String? _busyId;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final users = ref.watch(adminUsersProvider);
    final page = users.asData?.value;
    return AdminSheetFrame(
      title: 'Users & Groups',
      subtitle: page == null
          ? 'GET /api/v1/admin/users'
          : 'GET /api/v1/admin/users · ${page.items.length} of '
                '${page.totalItems} accounts',
      child: Column(
        children: [
          if (_error != null)
            AdminSheetError(
              message: _error!,
              onDismiss: () => setState(() => _error = null),
            ),
          Expanded(
            child: adminSheetState(
              users,
              loading: 'Loading accounts',
              errorTitle: 'Could not load accounts',
              onRetry: () => ref.invalidate(adminUsersProvider),
              data: (usersPage) {
                if (usersPage.items.isEmpty) {
                  return const NovaStateView(
                    icon: Icons.group_outlined,
                    title: 'No accounts yet',
                    message:
                        'GET /api/v1/admin/users returned no rows. There are no '
                        'groups in this API — the endpoint lists accounts only.',
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
                      'Every row is returned with role "member": GET '
                      '/admin/users selects the SQL literal \'member\' for the '
                      'role column (admin.ts:155) and does not read '
                      'role_bindings, so no role breakdown is shown.',
                    ),
                    if (usersPage.truncated)
                      AdminSheetNote(
                        'Showing the first ${usersPage.items.length} of '
                        '${usersPage.totalItems} accounts. The route clamps '
                        'pageSize to 100 and this build requests one page.',
                      ),
                    const SizedBox(height: NovaSpace.xxs),
                    for (final user in usersPage.items)
                      NovaListRow(
                        title: user.label,
                        subtitle: '${user.email} · ${user.status}',
                        icon: user.disabled
                            ? Icons.block_rounded
                            : Icons.person_outline_rounded,
                        iconTone: user.disabled
                            ? context.nova.danger
                            : context.nova.accent,
                        trailing: _busyId == user.id
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : NovaSecondaryButton(
                                label: user.disabled ? 'Unblock' : 'Block',
                                tone: user.disabled
                                    ? null
                                    : context.nova.danger,
                                onPressed: _busyId == null
                                    ? () => _toggle(user)
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

  Future<void> _toggle(AdminUser user) async {
    final disabling = !user.disabled;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          disabling ? 'Block ${user.label}?' : 'Unblock ${user.label}?',
        ),
        content: Text(
          disabling
              ? 'PATCH /api/v1/admin/users/${user.id} with disabled: true. '
                    'The account is refused at sign-in until it is unblocked.'
              : 'PATCH /api/v1/admin/users/${user.id} with disabled: false.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(disabling ? 'Block' : 'Unblock'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      _busyId = user.id;
      _error = null;
    });
    try {
      await ref
          .read(adminMutationsProvider)
          .setUserDisabled(user.id, disabled: disabling);
    } catch (e) {
      if (mounted) setState(() => _error = adminErrorMessage(e));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }
}
