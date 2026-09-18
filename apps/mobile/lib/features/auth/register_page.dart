import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design/widgets/index.dart';
import '../onboarding/splash_page.dart' show NovaGradientText;
import 'auth_controller.dart';

/// The "Create account" half of `onboarding/auth.html`, on the OpenDesign
/// tokens and deliberately built from the same blocks as [LoginPage] so the two
/// screens read as one flow: `.bg-aura`, the `.top-bar` back button + title, the
/// gradient `.heading`, uppercase `.label` fields, the gradient `.btn-primary`
/// and a `.footer`.
///
/// The export is phone-first with "Continue with OTP"; the API this client
/// targets mounts no OTP route, so phone sign-in is shown disabled with that
/// stated rather than faked. Email + password is the real, working path — it
/// posts to `/api/v1/auth/register` (which takes `name`, `email`, `password`)
/// and is the only action that submits.
class RegisterPage extends ConsumerStatefulWidget {
  const RegisterPage({super.key});

  @override
  ConsumerState<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends ConsumerState<RegisterPage> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();

  String? _nameError;
  String? _emailError;
  String? _passwordError;
  String? _confirmError;
  bool _showPassword = false;

  /// `auth.html`: "Phone sign-in is not available on this server."
  static const _phoneUnavailable =
      'Phone sign-in is not available on this server.';

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_validate()) return;

    final succeeded = await ref.read(authStateProvider.notifier).register(
          email: _email.text.trim(),
          password: _password.text,
          name: _name.text.trim().isEmpty ? null : _name.text.trim(),
        );

    if (!mounted) return;
    if (succeeded) context.go('/');
  }

  /// `.back-btn`. Returns to sign-in, clearing any error the previous attempt
  /// left behind so the login screen opens clean.
  void _back() {
    ref.read(authStateProvider.notifier).clearError();
    context.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final auth = ref.watch(authStateProvider);

    return NovaScaffold(
      gutter: 0,
      topBar: _TopBar(enabled: !auth.isSubmitting, onBack: _back),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              NovaSpace.gutter,
              NovaSpace.xs,
              NovaSpace.gutter,
              NovaSpace.xl,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // `.heading` — display 800, 36px, fg fading down the glyphs.
                NovaGradientText(
                  'Create your account',
                  textAlign: TextAlign.start,
                  style: Theme.of(context).textTheme.displayLarge!.copyWith(
                    fontSize: 36,
                    letterSpacing: -1.08,
                    height: 1.1,
                  ),
                ),
                const SizedBox(height: NovaSpace.sm),
                Text(
                  'Your data stays tied to this account. Sign up with an email '
                  'and password to get started.',
                  style: Theme.of(context).textTheme.bodyLarge!.copyWith(
                    color: c.muted,
                  ),
                ),
                if (auth.error != null) ...[
                  const SizedBox(height: NovaSpace.md),
                  _AuthErrorBanner(message: auth.error!),
                ],
                const SizedBox(height: NovaSpace.xl),
                _form(context, auth),
                const SizedBox(height: NovaSpace.lg),
                _phoneSection(context),
                const SizedBox(height: NovaSpace.lg),
                _footer(context),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The real, working path, restyled onto [NovaTextField]. The validators are
  /// the previous implementation's, unchanged: email shape, the API's
  /// `RegisterSchema` 8-character minimum (see `services/api`), and a
  /// confirmation match.
  Widget _form(BuildContext context, AuthState auth) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _LabelledField(
          label: 'Name (optional)',
          child: NovaTextField(
            controller: _name,
            hint: 'What should NOVA call you?',
            textInputAction: TextInputAction.next,
            textCapitalization: TextCapitalization.words,
            errorText: _nameError,
            enabled: !auth.isSubmitting,
            onChanged: (_) => _clear(() => _nameError = null),
          ),
        ),
        const SizedBox(height: NovaSpace.md),
        _LabelledField(
          label: 'Email',
          child: NovaTextField(
            controller: _email,
            hint: 'you@example.com',
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            errorText: _emailError,
            enabled: !auth.isSubmitting,
            onChanged: (_) => _clear(() => _emailError = null),
          ),
        ),
        const SizedBox(height: NovaSpace.md),
        _LabelledField(
          label: 'Password',
          child: NovaTextField(
            controller: _password,
            hint: 'Choose a password',
            obscure: !_showPassword,
            textInputAction: TextInputAction.next,
            helperText: 'At least 8 characters',
            errorText: _passwordError,
            enabled: !auth.isSubmitting,
            onChanged: (_) => _clear(() => _passwordError = null),
            suffix: _RevealToggle(
              showing: _showPassword,
              onTap: () => setState(() => _showPassword = !_showPassword),
            ),
          ),
        ),
        const SizedBox(height: NovaSpace.md),
        _LabelledField(
          label: 'Confirm password',
          child: NovaTextField(
            controller: _confirm,
            hint: 'Repeat your password',
            obscure: !_showPassword,
            textInputAction: TextInputAction.done,
            errorText: _confirmError,
            enabled: !auth.isSubmitting,
            onChanged: (_) => _clear(() => _confirmError = null),
            onSubmitted: (_) => _submit(),
          ),
        ),
        const SizedBox(height: NovaSpace.lg),
        NovaPrimaryButton(
          label: 'Create account',
          busy: auth.isSubmitting,
          onPressed: auth.isSubmitting ? null : _submit,
        ),
      ],
    );
  }

  /// The previous implementation's validators, unchanged: a required email of
  /// the right shape, the API's `RegisterSchema` 8-character minimum, and a
  /// confirmation match. They run on submit and are written into the
  /// token-styled [NovaTextField]s.
  bool _validate() {
    final email = _email.text.trim();
    final password = _password.text;

    final emailError = email.isEmpty
        ? 'Enter your email address.'
        : (!email.contains('@') || !email.contains('.'))
        ? 'Enter a valid email address.'
        : null;
    final passwordError = password.isEmpty
        ? 'Choose a password.'
        : (password.length < 8 ? 'Use at least 8 characters.' : null);
    final confirmError = _confirm.text == password
        ? null
        : 'Passwords do not match.';

    setState(() {
      _nameError = null;
      _emailError = emailError;
      _passwordError = passwordError;
      _confirmError = confirmError;
    });

    return emailError == null && passwordError == null && confirmError == null;
  }

  /// The export's phone block, disabled for the same honest reason as login:
  /// the API has no OTP endpoint.
  Widget _phoneSection(BuildContext context) {
    final c = context.nova;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Divider(color: c.border)),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: NovaSpace.sm),
              child: Text(
                'or sign up with',
                style: NovaTheme.overline(c),
              ),
            ),
            Expanded(child: Divider(color: c.border)),
          ],
        ),
        const SizedBox(height: NovaSpace.md),
        const _LabelledField(
          label: 'Phone number',
          child: NovaTextField(
            hint: '+91 XXXXX XXXXX',
            keyboardType: TextInputType.phone,
            enabled: false,
          ),
        ),
        const SizedBox(height: NovaSpace.md),
        const _DisabledGradientButton(
          label: 'Continue with OTP',
          reason: _phoneUnavailable,
        ),
        const SizedBox(height: NovaSpace.sm),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.info_outline_rounded, size: 14, color: c.muted),
            const SizedBox(width: NovaSpace.xs),
            Expanded(
              child: Text(
                _phoneUnavailable,
                style: Theme.of(context).textTheme.bodySmall!.copyWith(
                  color: c.muted,
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// `.footer` — the export's sign-in line, pointed at the real route.
  Widget _footer(BuildContext context) {
    final c = context.nova;
    return Center(
      child: Wrap(
        alignment: WrapAlignment.center,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(
            'Already have an account?',
            style: Theme.of(context).textTheme.bodySmall!.copyWith(
              color: c.muted,
            ),
          ),
          const SizedBox(width: NovaSpace.xs),
          GestureDetector(
            onTap: _back,
            child: Text(
              'Back to sign in',
              style: Theme.of(context).textTheme.bodySmall!.copyWith(
                color: c.accent,
                fontWeight: NovaType.wMedium,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Clears one field's message and any stale server error, in one rebuild.
  void _clear(VoidCallback clear) {
    setState(clear);
    ref.read(authStateProvider.notifier).clearError();
  }
}

/// The export's `.top-bar`, shared shape with [LoginPage].
class _TopBar extends StatelessWidget {
  const _TopBar({required this.enabled, required this.onBack});

  final bool enabled;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        NovaIconButton(
          icon: Icons.chevron_left_rounded,
          size: 36,
          color: context.nova.muted,
          tooltip: 'Back',
          onTap: enabled ? onBack : null,
        ),
        Expanded(
          child: Text(
            'Create account',
            textAlign: TextAlign.center,
            style: NovaTheme.sectionHeading(context.nova),
          ),
        ),
        const SizedBox(width: NovaMotion.minTouchTarget),
      ],
    );
  }
}

/// Uppercase `.label` above a field, matching `auth.html`'s `.field` block.
class _LabelledField extends StatelessWidget {
  const _LabelledField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label.toUpperCase(), style: NovaTheme.overline(context.nova)),
        const SizedBox(height: NovaSpace.xs),
        child,
      ],
    );
  }
}

/// Password reveal control: keeps the 44px touch target and stays a labelled
/// switch, rather than the unlabelled eye icon the export omits entirely.
class _RevealToggle extends StatelessWidget {
  const _RevealToggle({required this.showing, required this.onTap});

  final bool showing;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Semantics(
      button: true,
      label: showing ? 'Hide password' : 'Show password',
      child: Center(
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: SizedBox(
            width: NovaMotion.minTouchTarget,
            height: NovaMotion.minTouchTarget,
            child: Center(
              child: Icon(
                showing
                    ? Icons.visibility_off_outlined
                    : Icons.visibility_outlined,
                size: 18,
                color: c.muted,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The export's `.btn-primary` in its unavailable state: the gradient is kept
/// so the screen still reads as the design, at reduced opacity and with no glow
/// and no tap handler — never a fake action.
class _DisabledGradientButton extends StatelessWidget {
  const _DisabledGradientButton({required this.label, required this.reason});

  final String label;
  final String reason;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Semantics(
      button: true,
      enabled: false,
      label: label,
      hint: reason,
      child: Opacity(
        opacity: 0.5,
        child: Container(
          padding: const EdgeInsets.all(NovaSpace.md),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            gradient: c.accentGradient,
            borderRadius: BorderRadius.circular(NovaRadius.bubble),
          ),
          child: Text(label, style: NovaTheme.cta(c).copyWith(color: c.onAccent)),
        ),
      ),
    );
  }
}

/// Inline danger banner for `AuthState.error`.
class _AuthErrorBanner extends StatelessWidget {
  const _AuthErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: c.danger.withValues(alpha: 0.12),
        borderRadius: NovaRadius.rCard,
        border: Border.all(color: c.danger.withValues(alpha: 0.4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline_rounded, color: c.danger, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.danger),
            ),
          ),
        ],
      ),
    );
  }
}
