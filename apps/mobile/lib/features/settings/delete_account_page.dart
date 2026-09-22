import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart' show novaApiProvider;
import '../../core/design/widgets/index.dart';
import '../auth/auth_controller.dart';

/// In-app account deletion.
///
/// This screen exists because both stores make it a publishing gate:
///
///  * **App Review Guideline 5.1.1(v)** — an app that supports account creation must
///    let the user initiate deletion of the account *from inside the app*. Disabling
///    or deactivating the account is explicitly not sufficient.
///  * **Google Play, Account deletion requirement** — an in-app path *and* a
///    publicly reachable web request URL. This is the in-app half; the web half is the
///    `/delete-account` page in the console, and both are declared in the Console.
///
/// It performs a real, immediate, hard delete through `DELETE /api/v1/account`. There
/// is no soft-delete and no "scheduled" state, because a deletion the user cannot
/// observe is indistinguishable from one that never happened. The server requires the
/// typed word `DELETE` and, when the account has a password, that password.
class DeleteAccountPage extends ConsumerStatefulWidget {
  const DeleteAccountPage({super.key});

  @override
  ConsumerState<DeleteAccountPage> createState() => _DeleteAccountPageState();
}

class _DeleteAccountPageState extends ConsumerState<DeleteAccountPage> {
  final _password = TextEditingController();
  final _confirm = TextEditingController();

  NovaDeletionPreview? _preview;
  String? _previewError;
  bool _loadingPreview = true;
  bool _deleting = false;
  String? _error;

  /// The account's password, when it has one. The server returns
  /// `PASSWORD_REQUIRED` if confirmation is missing, but we can ask before the
  /// round trip by remembering what sign-in used.
  /// Whether a password is required to confirm.
  ///
  /// Starts `true` — the safe assumption, since sending a password the server ignores
  /// is harmless while omitting one it needs is a failed deletion. The preview corrects
  /// it: `users.password_hash` is nullable, so an account created through a phone or
  /// OAuth path has no password and must not be blocked on a field it never set.
  bool _needsPassword = true;

  @override
  void initState() {
    super.initState();
    _loadPreview();
    // Both fields gate the button, so both need to rebuild it. Only `_confirm` had a
    // listener at first, which meant typing the password *after* the confirmation word
    // left the button disabled with no visible reason — the field looked filled in and
    // the action looked broken. Every confirmation phrase in the app is upper-case;
    // either case is accepted, but the exact word is required.
    _confirm.addListener(_onConfirmationChanged);
    _password.addListener(_onConfirmationChanged);
  }

  void _onConfirmationChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _confirm.removeListener(_onConfirmationChanged);
    _password.removeListener(_onConfirmationChanged);
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _loadPreview() async {
    try {
      final preview = await ref.read(novaApiProvider).deletionPreview();
      if (!mounted) return;
      setState(() {
        _preview = preview;
        _needsPassword = preview.requiresPassword;
        _loadingPreview = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        // A failed preview must not block deletion — the endpoint is a courtesy, and
        // refusing to delete because a *count* could not be read would be worse than
        // deleting without it.
        _previewError = _friendly(error);
        _loadingPreview = false;
      });
    }
  }

  bool get _canDelete {
    if (_deleting) return false;
    if (_confirm.text.trim().toUpperCase() != 'DELETE') return false;
    if (_needsPassword && _password.text.isEmpty) return false;
    return true;
  }

  Future<void> _delete() async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    setState(() {
      _deleting = true;
      _error = null;
    });
    try {
      await ref.read(novaApiProvider).deleteAccount(password: _password.text);
      await ref.read(authStateProvider.notifier).logout();
      if (!mounted) return;
      messenger?.showSnackBar(
        const SnackBar(content: Text('Your account and its data have been deleted.')),
      );
      context.go('/login');
    } catch (error) {
      if (!mounted) return;
      final message = _friendly(error);
      final display = message.contains('PASSWORD_REQUIRED')
          ? 'Enter your password to confirm.'
          : message;
      setState(() {
        _deleting = false;
        _error = display;
      });
      messenger?.showSnackBar(
        SnackBar(content: Text(display)),
      );
    }
  }

  Future<void> _confirmAndDelete() async {
    // `context.nova` is read synchronously, before the first await. The second
    // `showDialog` is reached only after one, and is guarded by `mounted` below rather
    // than by a lint suppression, so a disposed widget cannot be handed a dialog.
    final c = context.nova;
    final agreed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete your account?'),
        content: const Text(
          'This cannot be undone. Your conversations, tasks, reminders, memories and '
          'recordings are removed immediately, and any recordings still in storage are '
          'deleted with them. Backups roll off within 30 days.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Keep my account'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
    if (agreed != true) return;
    // The first dialog awaited above; the user may have navigated away while it was
    // open, and the second dialog needs a live `context`.
    if (!mounted) return;

    // Step 2: typed-confirmation gate — the destructive call only fires when the
    //          user literally types DELETE, preventing accidental taps.
    final controller = TextEditingController();
    var typedMatch = false;
    final danger = c.danger;
    final onAccent = c.onAccent;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (typeDialogContext) => StatefulBuilder(
        builder: (typeDialogContext, setDialogState) {
          void onTextChanged(String value) {
            final match = value.trim().toUpperCase() == 'DELETE';
            if (match != typedMatch) {
              setDialogState(() => typedMatch = match);
            }
          }

          return AlertDialog(
            title: const Text('Type DELETE to confirm'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'This action is irreversible. All of your data will be permanently removed.',
                ),
                const SizedBox(height: 16),
                NovaTextField(
                  controller: controller,
                  hint: 'DELETE',
                  textCapitalization: TextCapitalization.characters,
                  onChanged: onTextChanged,
                  autofocus: true,
                  errorText: typedMatch
                      ? null
                      : 'Type DELETE to enable the button below',
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(typeDialogContext).pop(false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                onPressed: typedMatch
                    ? () => Navigator.of(typeDialogContext).pop(true)
                    : null,
                style: ElevatedButton.styleFrom(
                  backgroundColor: danger,
                  foregroundColor: onAccent,
                ),
                child: const Text('Delete everything'),
              ),
            ],
          );
        },
      ),
    );

    controller.dispose();
    if (confirmed == true) await _delete();
  }

  String _friendly(Object e) {
    final s = e.toString();
    if (s.contains('401')) return 'Your session expired. Please sign in again.';
    if (s.contains('Cannot reach')) return 'Cannot reach the NOVA server.';
    return s.replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaScaffold(
      topBar: Row(
        children: [
          if (Navigator.of(context).canPop())
            NovaIconButton(
              icon: Icons.chevron_left_rounded,
              size: 36,
              radius: NovaRadius.control,
              tooltip: 'Back',
              onTap: () => Navigator.of(context).pop(),
            )
          else
            const SizedBox(width: NovaMotion.minTouchTarget),
          Expanded(
            child: Center(
              child: Text(
                'Delete account',
                style: NovaTheme.sectionHeading(c).copyWith(fontSize: 19),
              ),
            ),
          ),
          const SizedBox(width: NovaMotion.minTouchTarget),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          NovaCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('What gets deleted',
                    style: NovaTheme.sectionHeading(c).copyWith(fontSize: 15)),
                const SizedBox(height: NovaSpace.sm),
                if (_loadingPreview)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: NovaSpace.sm),
                    child: Center(
                      child: SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  )
                else ...[
                  _Line(
                    _preview == null
                        ? 'Your account and everything in it.'
                        : 'Your account for ${_preview!.email}, and everything in it.',
                  ),
                  const _Line('Tasks, reminders, memories and conversations.'),
                  _Line(
                    _preview == null
                        ? 'Your recordings and their transcripts.'
                        : 'Your ${_preview!.recordings} recording'
                            '${_preview!.recordings == 1 ? '' : 's'} and their '
                            'transcripts, including the audio files in storage.',
                  ),
                  _Line(
                    _preview == null
                        ? 'Your consent records.'
                        : 'Your ${_preview!.consentRecords} consent record'
                            '${_preview!.consentRecords == 1 ? '' : 's'}.',
                  ),
                  if (_preview != null)
                    _Line('Retention: ${_preview!.retentionPeriod}'),
                  if (_previewError != null)
                    _Line(
                      'Could not read the exact counts ($_previewError). Deletion still '
                      'removes everything listed above.',
                    ),
                ],
              ],
            ),
          ),
          const SizedBox(height: NovaSpace.md),
          Text('Confirm', style: NovaTheme.sectionHeading(c).copyWith(fontSize: 15)),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'Type DELETE to confirm. If your account has a password, enter it too.',
            style: TextStyle(color: c.muted, fontSize: NovaType.bodySmall, height: 1.45),
          ),
          const SizedBox(height: NovaSpace.sm),
          NovaTextField(
            controller: _confirm,
            hint: 'DELETE',
            enabled: !_deleting,
          ),
          const SizedBox(height: NovaSpace.sm),
          NovaTextField(
            controller: _password,
            hint: 'Password',
            obscure: true,
            enabled: !_deleting && _needsPassword,
          ),
          if (_error != null) ...[
            const SizedBox(height: NovaSpace.sm),
            Text(
              _error!,
              style: TextStyle(color: c.danger, fontSize: NovaType.bodySmall),
            ),
          ],
          const SizedBox(height: NovaSpace.lg),
          NovaPrimaryButton(
            label: 'Delete my account',
            gradient: LinearGradient(colors: [c.danger, c.danger]),
            busy: _deleting,
            onPressed: _canDelete ? _confirmAndDelete : null,
          ),
          const SizedBox(height: NovaSpace.md),
          Text(
            'Prefer email? Write to privacy@leadup.tech from the address you signed up '
            'with and we will delete the account for you. Requests are completed within '
            '30 days.',
            style: TextStyle(color: c.muted, fontSize: NovaType.bodySmall, height: 1.45),
          ),
          const SizedBox(height: NovaSpace.xl),
        ],
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 6, right: 8),
            child: Container(
              width: 4,
              height: 4,
              decoration: BoxDecoration(color: c.danger, shape: BoxShape.circle),
            ),
          ),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: c.fg,
                fontSize: NovaType.bodySmall,
                height: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
