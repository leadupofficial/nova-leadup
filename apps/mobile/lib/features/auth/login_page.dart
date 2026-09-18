import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart' show routerProvider;
import '../../core/design/widgets/index.dart';
import '../onboarding/splash_page.dart' show NovaGradientText;
import 'auth_controller.dart';

/// `onboarding/auth.html` — the sign-in screen, on the OpenDesign tokens.
///
/// It shares the export's layout language with [RegisterPage]: `.bg-aura`, the
/// `.top-bar` back button + title, the gradient `.heading`, uppercase `.label`
/// fields, the gradient `.btn-primary` and a `.footer`.
///
/// Two places the export cannot be honoured literally, for the reason the whole
/// auth flow is email-first:
///
/// 1. `auth.html` is phone-first and its only action is "Continue with OTP".
///    `services/api` mounts `/api/v1/auth` with login/register/refresh/logout
///    only — there is no OTP route and `ApiConfig` carries no OTP path — so the
///    design's OTP button is rendered **disabled** with the reason stated, and
///    email + password stays the primary, fully working form.
/// 2. The design's `.social-row` (Google / Apple) has no implementation behind
///    it, so it is not drawn at all rather than drawn dead. The `.sso-notice`
///    is kept, because it is informational only.
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _emailFocus = FocusNode();
  final _passwordFocus = FocusNode();

  String? _emailError;
  String? _passwordError;

  /// Shown under the disabled OTP action; no OTP route exists on this API.
  static const _phoneUnavailable =
      'Phone sign-in is not available on this server.';

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_validate()) return;

    final succeeded = await ref.read(authStateProvider.notifier).login(
          email: _email.text.trim(),
          password: _password.text,
        );

    if (!mounted) return;
    if (succeeded) context.go('/');
  }

  /// The `.back-btn` in the export's `.top-bar`. Login is the router's terminal
  /// auth destination, so this only leaves when there is genuinely something to
  /// pop back to; otherwise it stays put and clears any stored auth error, which
  /// is the only thing a back gesture could meaningfully rewind here.
  void _back() {
    ref.read(authStateProvider.notifier).clearError();
    final router = ref.read(routerProvider);
    if (router.canPop()) router.pop();
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
                  'Welcome back',
                  textAlign: TextAlign.start,
                  style: Theme.of(context).textTheme.displayLarge!.copyWith(
                    fontSize: 36,
                    letterSpacing: -1.08,
                    height: 1.1,
                  ),
                ),
                const SizedBox(height: NovaSpace.sm),
                Text(
                  'Sign in with your email and password to continue to NOVA.',
                  style: Theme.of(context).textTheme.bodyLarge!.copyWith(
                    color: c.muted,
                  ),
                ),
                if (auth.error != null) ...[
                  const SizedBox(height: NovaSpace.md),
                  _AuthErrorBanner(message: auth.error!),
                ],
                const SizedBox(height: NovaSpace.xl),
                _emailPasswordForm(context, auth),
                const SizedBox(height: NovaSpace.lg),
                _phoneSection(context),
                const SizedBox(height: NovaSpace.lg),
                _ssoNotice(context),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The real, working path: the email + password form from the previous
  /// implementation, restyled onto [NovaTextField] and the token spacing scale.
  Widget _emailPasswordForm(BuildContext context, AuthState auth) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _LabelledField(
          label: 'Email',
          child: NovaTextField(
            controller: _email,
            focusNode: _emailFocus,
            hint: 'you@example.com',
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            errorText: _emailError,
            enabled: !auth.isSubmitting,
            onChanged: _clearEmailError,
            onSubmitted: (_) => _passwordFocus.requestFocus(),
          ),
        ),
        const SizedBox(height: NovaSpace.md),
        _LabelledField(
          label: 'Password',
          child: NovaTextField(
            controller: _password,
            focusNode: _passwordFocus,
            hint: 'Your password',
            obscure: true,
            textInputAction: TextInputAction.done,
            errorText: _passwordError,
            enabled: !auth.isSubmitting,
            onChanged: _clearPasswordError,
            onSubmitted: (_) => _submit(),
          ),
        ),
        const SizedBox(height: NovaSpace.lg),
        NovaPrimaryButton(
          label: 'Sign in',
          busy: auth.isSubmitting,
          onPressed: auth.isSubmitting ? null : _submit,
        ),
        const SizedBox(height: NovaSpace.md),
        Center(
          child: Wrap(
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                "Don't have an account?",
                style: Theme.of(context).textTheme.bodySmall!.copyWith(
                  color: context.nova.muted,
                ),
              ),
              const SizedBox(width: NovaSpace.xs),
              GestureDetector(
                onTap: auth.isSubmitting ? null : _goToRegister,
                child: Text(
                  'Create an account',
                  style: Theme.of(context).textTheme.bodySmall!.copyWith(
                    color: context.nova.accent,
                    fontWeight: NovaType.wMedium,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// The validators are the previous implementation's, unchanged: a required
  /// email of the right shape and a non-empty password. They are run on submit
  /// and written into the token-styled [NovaTextField]s.
  bool _validate() {
    final email = _email.text.trim();
    final password = _password.text;

    final emailError = email.isEmpty
        ? 'Enter your email address.'
        : (!email.contains('@') || !email.contains('.'))
        ? 'Enter a valid email address.'
        : null;
    final passwordError = password.isEmpty ? 'Enter your password.' : null;

    setState(() {
      _emailError = emailError;
      _passwordError = passwordError;
    });

    return emailError == null && passwordError == null;
  }

  void _goToRegister() {
    ref.read(authStateProvider.notifier).clearError();
    context.go('/register');
  }

  /// The export's country + phone fields and its `.btn-primary` "Continue with
  /// OTP", all disabled: no OTP endpoint exists on the API this client targets.
  Widget _phoneSection(BuildContext context) {
    final c = context.nova;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _LabelledField(
          label: 'Country',
          child: NovaTextField(hint: 'India (+91)', enabled: false),
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
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// `.sso-notice` — informational only, so it renders as the design's dashed
  /// card without pretending to be a button.
  Widget _ssoNotice(BuildContext context) {
    final c = context.nova;
    return Container(
      padding: const EdgeInsets.all(NovaSpace.sm),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.border),
      ),
      child: Text(
        'Enterprise SSO available for org domains · ask your admin',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall!.copyWith(color: c.muted),
      ),
    );
  }

  void _clearEmailError(String _) {
    if (_emailError != null) setState(() => _emailError = null);
    _clearAuthError();
  }

  void _clearPasswordError(String _) {
    if (_passwordError != null) setState(() => _passwordError = null);
    _clearAuthError();
  }

  void _clearAuthError() => ref.read(authStateProvider.notifier).clearError();
}

/// The export's `.top-bar`: back button, title slot, 36px spacer.
///
/// [NovaIconButton] keeps the design's 36x36 glass tile and expands the touch
/// target to the 44px brand-spec minimum.
///
/// The title slot is deliberately left empty on this screen. `widget_test.dart`
/// asserts that both "Welcome back" and "Sign in" appear exactly once, and those
/// are the `.heading` and the CTA; a `.top-bar h1` carrying either string would
/// be found twice. The bar keeps the export's geometry so the screen still reads
/// as the same layout language as [RegisterPage], whose title names the screen
/// rather than either string.
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
        const Spacer(),
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
          child: Text(
            label,
            style: NovaTheme.cta(c).copyWith(color: c.onAccent),
          ),
        ),
      ),
    );
  }
}

/// Inline danger banner for `AuthState.error`, so a rejected sign-in is visible
/// rather than only in the log.
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
