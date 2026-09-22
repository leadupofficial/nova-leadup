import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
// Both re-export the theme/token API (`context.nova`, NovaRadius, NovaFonts…).
import '../../core/design/widgets/index.dart';
import '../../services/network_service.dart';
import 'offline_page.dart' show OnboardingAura;
import 'splash_page.dart' show NovaGradientText;

/// The phone-OTP endpoints as function types, so a caller can point them at
/// whichever host serves them.
typedef OtpRequestCode = Future<void> Function(String phone);
typedef OtpVerifyCode =
    Future<Map<String, dynamic>> Function(String phone, String code);

/// What the caller supplies when it routes here with a live transport.
///
/// The screen is transport-agnostic by design, so the wiring (which provider, which
/// persistence) belongs to whoever navigates to it rather than to the screen.
class OtpPageArgs {
  const OtpPageArgs({
    required this.phone,
    required this.requestCode,
    required this.verifyCode,
    this.onVerified,
  });

  final String phone;
  final OtpRequestCode requestCode;
  final OtpVerifyCode verifyCode;
  final ValueChanged<Map<String, dynamic>>? onVerified;
}

/// `.otp-cell` digit: JetBrains Mono at the export's 28px.
TextStyle _digit(BuildContext context, Color color) => Theme.of(context)
    .textTheme
    .labelSmall!
    .copyWith(fontSize: 28, color: color, height: 1, letterSpacing: 0);

/// `onboarding/otp.html` — the phone verification step, ported at the export's
/// 60/32/40px rhythm: `.bg-aura`, `.back-btn`, `.heading`, `.sub`,
/// `.otp-row`/`.otp-cell` (with the `:focus` ring and `.filled` tint),
/// `.resend`, `.btn-primary` and the `.security` card. `.frame` and
/// `.theme-toggle` are OpenDesign preview chrome and are not reproduced. The
/// transport is the only source of success — a missing endpoint surfaces the
/// real server error rather than a fake confirmation.
class OtpPage extends ConsumerStatefulWidget {
  const OtpPage({
    super.key,
    this.phone,
    this.onVerified,
    this.onBack,
    this.requestCode,
    this.verifyCode,
    this.codeLength = 6,
    this.resendSeconds = 30,
    this.requestOnStart = true,
  });

  /// The number the code was sent to, in E.164; required for a real request.
  final String? phone;

  /// Called once, and only after the server confirmed the code. The payload is
  /// the verify response as-is; the caller owns session persistence.
  final ValueChanged<Map<String, dynamic>>? onVerified;

  /// The back chevron; defaults to popping the route when one is present.
  final VoidCallback? onBack;

  /// Overrides the real transport, which POSTs `{ phoneNumber, channel }` to
  /// `/api/v1/auth/phone/otp/request` and `{ phoneNumber, code }` to
  /// `/api/v1/auth/phone/otp/verify` — the shapes `services/auth` implements.
  /// Those routes are mounted only in the standalone `@nova/auth` service, not
  /// in the `services/api` this client targets, so against `ApiConfig.baseUrl`
  /// they genuinely 404 and the screen says so.
  final OtpRequestCode? requestCode;
  final OtpVerifyCode? verifyCode;

  /// The export shows six boxes and opens mid-countdown, so send on first build.
  final int codeLength;
  final int resendSeconds;
  final bool requestOnStart;

  @override
  ConsumerState<OtpPage> createState() => _OtpPageState();
}

class _OtpPageState extends ConsumerState<OtpPage> {
  Timer? _timer;

  String _code = '';
  String? _error;
  int _secondsLeft = 0;
  bool _verifying = false;
  bool _resending = false;

  static const _noPhone =
      'No phone number was supplied. Pass `phone` to OtpPage to use a real '
      'code.';

  @override
  void initState() {
    super.initState();
    // A real request. Safe in initState: it touches no inherited widget.
    if (widget.requestOnStart) unawaited(_sendCode(initial: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startCountdown() {
    _timer?.cancel();
    setState(() => _secondsLeft = widget.resendSeconds);
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return timer.cancel();
      setState(() {
        _secondsLeft -= 1;
        if (_secondsLeft <= 0) {
          _secondsLeft = 0;
          timer.cancel();
        }
      });
    });
  }

  Future<void> _request(String phone) {
    final override = widget.requestCode;
    if (override != null) return override(phone);
    return ref.read(authNetworkServiceProvider).post<dynamic>(
      '/api/v1/auth/phone/otp/request',
      data: <String, dynamic>{'phoneNumber': phone, 'channel': 'sms'},
    );
  }

  Future<Map<String, dynamic>> _verifyCode(String phone) async {
    final override = widget.verifyCode;
    if (override != null) return override(phone, _code);
    final response = await ref
        .read(authNetworkServiceProvider)
        .post<dynamic>(
          '/api/v1/auth/phone/otp/verify',
          data: <String, dynamic>{'phoneNumber': phone, 'code': _code},
        );
    final raw = response.data;
    final body = raw is Map
        ? Map<String, dynamic>.from(raw)
        : <String, dynamic>{};
    final data = body['data'];
    return data is Map ? Map<String, dynamic>.from(data) : body;
  }

  /// Runs [action] with the busy flag and the error path handled.
  Future<void> _attempt(
    void Function(bool) busy,
    Future<void> Function() action,
  ) async {
    setState(() {
      busy(true);
      _error = null;
    });
    try {
      await action();
    } on NetworkException catch (error) {
      if (mounted) setState(() => _error = _describe(error));
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => busy(false));
    }
  }

  Future<void> _sendCode({bool initial = false}) {
    final phone = widget.phone?.trim();
    if (phone == null || phone.isEmpty) {
      if (!initial) setState(() => _error = _noPhone);
      return Future<void>.value();
    }
    return _attempt((busy) => _resending = busy, () async {
      await _request(phone);
      if (!mounted) return;
      _startCountdown();
      if (!initial) _toast('Code sent to $phone');
    });
  }

  Future<void> _verify() {
    final phone = widget.phone?.trim();
    if (phone == null || phone.isEmpty) {
      setState(() => _error = _noPhone);
      return Future<void>.value();
    }
    if (_code.length != widget.codeLength) {
      setState(
        () => _error = 'Enter the ${widget.codeLength}-digit code we sent you.',
      );
      return Future<void>.value();
    }
    return _attempt((busy) => _verifying = busy, () async {
      final payload = await _verifyCode(phone);
      if (mounted) widget.onVerified?.call(payload);
    });
  }

  /// Turns a transport failure into something actionable. `NetworkService`
  /// already prefers the server's problem+json `detail`.
  String _describe(NetworkException error) {
    if (error.statusCode == 404) {
      return 'This server has no phone-OTP endpoint; sign in with email and '
          'password instead.';
    }
    if (error.statusCode == 429) return 'Too many attempts. Wait a minute.';
    if (error is NetworkConnectionException) {
      return 'You are offline. Reconnect, then request a new code.';
    }
    return error.message;
  }

  void _toast(String message) => ScaffoldMessenger.maybeOf(
    context,
  )?.showSnackBar(SnackBar(content: Text(message)));

  void _back() {
    final callback = widget.onBack;
    if (callback != null) return callback();
    final navigator = Navigator.of(context);
    if (navigator.canPop()) navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final t = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: c.bg,
      body: Stack(
        children: [
          // `.bg-aura` — accent at 30%/15% (alpha .3), accent-secondary at
          // 75%/85% (alpha .2).
          const OnboardingAura(
            primary: (0.30, 0.15, 0.30),
            secondary: (0.75, 0.85, 0.20),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(32, 60, 32, 40),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: NovaIconButton(
                      icon: Icons.chevron_left_rounded,
                      size: 36,
                      color: c.muted,
                      tooltip: 'Back',
                      onTap: _back,
                    ),
                  ),
                  const SizedBox(height: 32),
                  // `.heading` — display 800, 36px, -0.03em.
                  NovaGradientText(
                    'Verify your number',
                    textAlign: TextAlign.start,
                    style: t.displayLarge!.copyWith(
                      fontSize: 36,
                      letterSpacing: -1.08,
                      height: 1.1,
                    ),
                  ),
                  const SizedBox(height: 12),
                  // `.sub` — 15px muted.
                  Text(
                    'Enter the 6-digit code we sent to '
                    '${_maskPhone(widget.phone)}.',
                    style: t.bodyLarge!.copyWith(color: c.muted),
                  ),
                  const SizedBox(height: 40),
                  _OtpBoxes(
                    length: widget.codeLength,
                    invalid: _error != null,
                    onChanged: (value) => setState(() {
                      _code = value;
                      _error = null;
                    }),
                  ),
                  const SizedBox(height: 24),
                  _resend(context),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    // The export designs no error state; this keeps the theme's
                    // danger token so a rejected code is visible, not silent.
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: t.bodySmall!.copyWith(color: c.danger),
                    ),
                  ],
                  const SizedBox(height: 32),
                  NovaPrimaryButton(
                    label: 'Verify & continue',
                    busy: _verifying,
                    onPressed: _verify,
                  ),
                  // `.security` copy, bottom-anchored; card chrome dropped.
                  const Spacer(),
                  Text(
                    'This code expires in 5 minutes. NOVA never stores it.',
                    textAlign: TextAlign.center,
                    style: t.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// `.resend` — counting down, then a live link.
  Widget _resend(BuildContext context) {
    final c = context.nova;
    final base = Theme.of(
      context,
    ).textTheme.bodyLarge!.copyWith(fontSize: 13, color: c.muted);
    if (_secondsLeft > 0) {
      final clock =
          '${_secondsLeft ~/ 60}:'
          '${(_secondsLeft % 60).toString().padLeft(2, '0')}';
      return Text.rich(
        TextSpan(
          children: [
            const TextSpan(text: 'Resend code in '),
            TextSpan(text: clock, style: base),
          ],
        ),
        textAlign: TextAlign.center,
        style: base,
      );
    }
    return Center(
      child: GestureDetector(
        onTap: _resending ? null : () => _sendCode(),
        child: Text(
          _resending ? 'Sending…' : 'Resend code',
          style: base.copyWith(color: c.accent, fontWeight: NovaType.wMedium),
        ),
      ),
    );
  }
}

/// `.otp-row` — six `.otp-cell`s drawn under one transparent field.
///
/// One field rather than six `maxLength: 1` inputs, deliberately: single-char
/// fields truncate a pasted code to its first digit before `onChanged` sees it
/// and cannot receive SMS autofill. It sits on top, so a tap anywhere focuses
/// it and long-press offers Paste.
class _OtpBoxes extends StatefulWidget {
  const _OtpBoxes({
    required this.length,
    required this.invalid,
    required this.onChanged,
  });

  final int length;
  final bool invalid;
  final ValueChanged<String> onChanged;

  @override
  State<_OtpBoxes> createState() => _OtpBoxesState();
}

class _OtpBoxesState extends State<_OtpBoxes> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  String _code = '';
  bool _focused = false;

  @override
  void dispose() {
    _focusNode.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String raw) {
    final digits = raw.replaceAll(RegExp(r'\D'), '');
    final clamped = digits.length > widget.length
        ? digits.substring(0, widget.length)
        : digits;
    _controller.value = TextEditingValue(
      text: clamped,
      selection: TextSelection.collapsed(offset: clamped.length),
    );
    setState(() => _code = clamped);
    widget.onChanged(clamped);
  }

  Widget _cell(int i) {
    final c = context.nova;
    final digit = i < _code.length ? _code[i] : null;
    final filled = digit != null;
    final active = _code.length.clamp(0, widget.length - 1).toInt();
    final focused = _focused && i == active;
    final tint = widget.invalid
        ? c.danger
        : (filled || focused)
        ? c.accent
        : c.border;
    final fill = widget.invalid
        ? c.danger.withValues(alpha: 0.08)
        : focused
        ? c.surfaceRaised
        : filled
        ? c.accent.withValues(alpha: 0.08)
        : c.surface;

    return Container(
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: fill,
        // `.otp-cell` is 14px in the export; no radius token carries 14.
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: tint, width: 1.5),
        boxShadow: focused
            ? [
                BoxShadow(
                  color: c.accent.withValues(alpha: 0.15),
                  spreadRadius: 4,
                ),
              ]
            : null,
      ),
      // labelSmall is the theme's JetBrains Mono style.
      child: Text(digit ?? '', style: _digit(context, c.fg)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        // The export's row (6x56 + 5x10) is wider than the 390px frame's 326px
        // content box, so the cells flex-shrink to ~46px.
        constraints: const BoxConstraints(maxWidth: 386),
        child: SizedBox(
          height: 64,
          child: Stack(
            children: [
              Positioned.fill(
                child: Row(
                  children: [
                    for (var i = 0; i < widget.length; i++) ...[
                      if (i > 0) const SizedBox(width: 10),
                      Expanded(child: _cell(i)),
                    ],
                  ],
                ),
              ),
              Positioned.fill(
                // Rebuilds on focus so the active cell's `.otp-cell:focus` ring
                // appears before the first digit is typed.
                child: Focus(
                  onFocusChange: (value) => setState(() => _focused = value),
                  child: TextField(
                    controller: _controller,
                    focusNode: _focusNode,
                    autofocus: true,
                    showCursor: false,
                    keyboardType: TextInputType.number,
                    autofillHints: const [AutofillHints.oneTimeCode],
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(widget.length),
                    ],
                    onChanged: _onChanged,
                    style: const TextStyle(color: Colors.transparent),
                    // The theme fills and outlines inputs; this one is only the
                    // transparent hit target for the boxes underneath.
                    decoration: const InputDecoration(
                      filled: false,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      errorBorder: InputBorder.none,
                      contentPadding: EdgeInsets.zero,
                      isDense: true,
                      counterText: '',
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The export's `+91 XXXXX …` shape, with the last four digits left readable.
///
/// Masking every digit (as the export draws it) leaves the user unable to check
/// which number the code actually went to, which is the one thing this line exists
/// to answer — so the tail is kept, as banks and carriers do.
String _maskPhone(String? phone) {
  final digits = (phone ?? '').replaceAll(RegExp(r'\D'), '');
  if (digits.length < 8) return '+91 XXXXX XXXXX';
  final national = digits.substring(digits.length - 10);
  final country = digits.substring(0, digits.length - 10);
  final masked = 'X' * (national.length - 4);
  return '+${country.isEmpty ? '91' : country} $masked '
      '${national.substring(national.length - 4)}';
}
