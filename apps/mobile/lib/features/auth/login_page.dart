import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart' show routerProvider;
import '../../core/design/widgets/index.dart';
import '../onboarding/otp_page.dart';
import '../onboarding/splash_page.dart' show NovaGradientText;
import 'firebase_phone_auth.dart';
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
///    ("Enterprise SSO available for org domains") is removed for the same reason:
///    there is no SAML/OIDC endpoint and no org-domain routing, so claiming SSO
///    exists is a misrepresentation under App Review 2.3.1(a). An earlier version of
///    this comment said it was "kept, because it is informational only", which
///    contradicted both the removal and the guideline.
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

  final _phone = TextEditingController();

  String? _emailError;
  String? _passwordError;
  String? _phoneError;
  /// Email + password is the secondary path; phone OTP is what a new user sees.
  bool _showEmailForm = false;
  bool _phoneBusy = false;

  /// Firebase Phone Authentication. Firebase verifies the number and returns an ID
  /// token; the server trades that for a NOVA session.
  final _phoneAuth = FirebasePhoneAuth();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    _phone.dispose();
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
      topBar: _TopBar(
        enabled: !auth.isSubmitting,
        onBack: _back,
        // Reachable when the flow pushed here (e.g. from the OTP step or a deep
        // link); on the fresh-install entry screen there is nothing to go back to.
        showBack: ref.read(routerProvider).canPop(),
      ),
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
                  _showEmailForm
                      ? 'Sign in with your email and password to continue to NOVA.'
                      : 'Sign in with your phone number to continue to NOVA.',
                  style: Theme.of(context).textTheme.bodyLarge!.copyWith(
                    color: c.muted,
                  ),
                ),
                if (auth.error != null) ...[
                  const SizedBox(height: NovaSpace.md),
                  _AuthErrorBanner(message: auth.error!),
                ],
                const SizedBox(height: NovaSpace.xl),
                // Phone OTP is the product's primary and first authentication path.
                // Email + password stays available for existing accounts, but behind
                // an explicit switch so a new user is not offered two methods at once.
                if (_showEmailForm)
                  _emailPasswordForm(context, auth)
                else
                  _phoneSection(context),
                const SizedBox(height: NovaSpace.md),
                Center(
                  child: TextButton(
                    onPressed: () => setState(() {
                      _showEmailForm = !_showEmailForm;
                      _emailError = null;
                      _passwordError = null;
                      _phoneError = null;
                    }),
                    child: Text(
                      _showEmailForm
                          ? 'Use phone number instead'
                          : 'Use email and password instead',
                      style: Theme.of(context).textTheme.bodySmall!.copyWith(
                        color: c.accent,
                      ),
                    ),
                  ),
                ),
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
        : !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email)
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

  /// Country + phone, wired to Firebase Phone Authentication.
  ///
  /// This section used to be disabled outright — "Phone sign-in is not available on this
  /// server" — because the OTP routes the client knew about are mounted only in the
  /// standalone `@nova/auth` service and genuinely 404 against this API. Firebase is the
  /// real mechanism: it verifies the number and returns an ID token, which
  /// `POST /api/v1/auth/firebase/exchange` trades for a NOVA session.
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
        _LabelledField(
          label: 'Phone number',
          child: NovaTextField(
            hint: '+91 XXXXX XXXXX',
            keyboardType: TextInputType.phone,
            controller: _phone,
            enabled: !_phoneBusy,
            errorText: _phoneError,
          ),
        ),
        const SizedBox(height: NovaSpace.md),
        NovaPrimaryButton(
          label: 'Continue with OTP',
          busy: _phoneBusy,
          onPressed: _phoneBusy ? null : _startPhoneSignIn,
        ),
        const SizedBox(height: NovaSpace.sm),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.info_outline_rounded, size: 14, color: c.muted),
            const SizedBox(width: NovaSpace.xs),
            Expanded(
              child: Text(
                'We will text a six-digit code to confirm the number.',
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

  /// Sends the code, then hands the user to the six-digit screen.
  ///
  /// The code is requested *before* navigating, so a refusal — a bad number, an SMS
  /// quota, or a build whose signing certificate is not registered with the provider —
  /// is reported next to the field that caused it rather than on a screen the user
  /// reached for nothing.
  Future<void> _startPhoneSignIn() async {
    final digits = _phone.text.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.replaceAll('+', '').length < 8) {
      setState(() => _phoneError = 'Enter a phone number with its country code.');
      return;
    }
    // The field takes the national part; E.164 wants the country code exactly once.
    final e164 = digits.startsWith('+') ? digits : '+91$digits';

    setState(() {
      _phoneBusy = true;
      _phoneError = null;
    });

    try {
      await _phoneAuth.sendCode(e164);
      if (!mounted) return;
      setState(() => _phoneBusy = false);
      final router = ref.read(routerProvider);
      router.push(
        '/onboarding/otp',
        extra: OtpPageArgs(
          phone: e164,
          requestCode: _phoneAuth.sendCode,
          verifyCode: (String _, String code) async {
            final idToken = await _phoneAuth.signIn(code);
            final ok = await ref
                .read(authStateProvider.notifier)
                .loginWithFirebaseIdToken(idToken);
            if (!ok) {
              throw const PhoneAuthFailure(
                'Your number is verified, but the account could not be opened. '
                'Please try again.',
              );
            }
            return <String, dynamic>{'verified': true};
          },
          onVerified: (_) {
            if (mounted) router.go('/');
          },
        ),
      );
    } on PhoneAuthFailure catch (error) {
      if (!mounted) return;
      setState(() {
        _phoneBusy = false;
        _phoneError = error.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phoneBusy = false;
        _phoneError = 'Could not start phone verification. Please try again.';
      });
    }
  }

  // The export's `.sso-notice` ("Enterprise SSO available for org domains · ask your
  // admin") is deliberately **not rendered and not kept**. No SSO exists — there is no
  // SAML/OIDC endpoint and no org-domain routing — and the only sign-in path is email
  // + password against `/api/v1/auth/login`. Advertising a capability the app does not
  // have is a misrepresentation under App Review Guideline 2.3.1(a) and Play's
  // Deceptive Behavior policy, so the card was removed rather than reworded. Re-add it
  // only with the integration behind it.

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
/// The title slot is deliberately left empty on this screen. The heading
/// ("Welcome back") and the CTA are the two pieces of text the page is identified
/// by, so a `.top-bar h1` carrying either string would render it twice. The bar
/// keeps the export's geometry so the screen still reads as the same layout
/// language as [RegisterPage], whose title names the screen rather than either
/// string.
class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.enabled,
    required this.onBack,
    this.showBack = true,
  });

  final bool enabled;
  final VoidCallback onBack;

  /// Login is the entry screen of a fresh install, where there is nothing behind it.
  /// The tile keeps its slot so the heading below does not shift, but the dead arrow
  /// is not drawn.
  final bool showBack;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        if (showBack)
          NovaIconButton(
            icon: Icons.chevron_left_rounded,
            size: 36,
            color: context.nova.muted,
            tooltip: 'Back',
            onTap: enabled ? onBack : null,
          )
        else
          const SizedBox(width: NovaMotion.minTouchTarget),
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
