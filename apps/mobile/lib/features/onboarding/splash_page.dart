
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:dio/dio.dart';

import '../../app/providers.dart';
import '../../core/theme/nova_theme.dart';
import '../../services/health_service.dart';
import '../auth/auth_api.dart';
import '../auth/auth_controller.dart';
import '../auth/auth_repository.dart';
import 'offline_page.dart' show OnboardingAura;
import 'onboarding_service.dart';

/// Where the splash decided the user belongs. The three outcomes mirror the
/// router's own gates (`app/router.dart`): onboarding, then auth, then the shell.
enum SplashDestination { home, login, onboarding }

/// What the splash's startup work actually found.
@immutable
class SplashReadiness {
  const SplashReadiness({
    required this.destination,
    required this.location,
    required this.statusLabel,
    required this.authenticated,
    this.user,
    this.onboardingStep,
    this.backendReachable,
  });

  final SplashDestination destination;

  /// The go_router location matching [destination] — `/`, `/login` or an
  /// `/onboarding/...` route — so a caller need not re-derive the routing rules.
  final String location;

  /// The truth the status row shows once startup is done. The export's own
  /// string ("Connecting securely") is what the row shows while it still runs.
  final String statusLabel;
  final bool authenticated;
  final AuthUser? user;
  final OnboardingStep? onboardingStep;

  /// Result of the real `/healthz` probe; null when it did not finish in budget.
  final bool? backendReachable;
}

/// The startup work that needs the network, so a router can `await` it instead
/// of the widget settling:
///
/// 1. Rotate an expired access token with `AuthApi.refresh`. Only a genuine
///    rejection (401/403) signs the user out — a transport failure (offline)
///    deliberately does not.
/// 2. Read the onboarding resume point ([OnboardingService]; bootstrap already
///    restored the session from the secure store).
/// 3. Probe `/healthz` so the status row can say something true.
final splashReadinessProvider = FutureProvider<SplashReadiness>((ref) async {
  final repository = ref.read(authRepositoryProvider);
  final onboarding = ref.read(onboardingServiceProvider);

  var authenticated = repository.isLoggedIn;
  final stored = repository.currentToken;
  if (authenticated && stored != null && stored.isExpired) {
    try {
      final session = await ref
          .read(authApiProvider)
          .refresh(stored.refreshToken);
      // The server rotates refresh tokens, so the whole session is persisted.
      await repository.saveSession(session.token, user: session.user);
    } on AuthException catch (error) {
      if (error.statusCode == 401 || error.statusCode == 403) {
        // Republish the auth state the router reacts to, and clear the session.
        await ref.read(authStateProvider.notifier).handleRefreshFailure();
        authenticated = false;
      }
      // Any other status — 5xx, or no status at all because the server could not be
      // reached — keeps the session and continues to the app. It is handled here rather
      // than left to fall through because this clause used to be the *only* catch: a
      // failure that was not an `AuthException` escaped the provider entirely.
    } catch (error) {
      // **Nothing may escape this provider.**
      //
      // It used to: only `AuthException` was caught, so a raw socket error, a timeout, or
      // anything thrown by `saveSession` propagated and left `splashReadinessProvider` in
      // an **error** state. `_SplashPageState.build` reads `readiness.asData?.value` and
      // has no error branch, so `resolved` stayed null, navigation never ran, and the app
      // sat on the splash animation for ever — no crash, no message, no way out, while
      // something underneath spun the CPU. That is the "blank screen" state observed on
      // the device.
      //
      // A splash that cannot resolve still has to resolve to *something*. Falling through
      // to the signed-out destination is the honest answer: the user reaches a screen
      // they can act on rather than a hung animation.
      debugPrint('[Splash] readiness could not refresh the session: $error');
      authenticated = false;
    }
  }

  HealthCheckResult? health;
  try {
    final cancelToken = CancelToken();
    // `HealthService.check` never throws; the budget only bounds how long a dead
    // network can hold the splash open. The dedicated health client (5 s timeout
    // plus CancelToken) guarantees a hung endpoint cannot stall startup.
    final result = await ref
        .read(healthServiceWithTimeoutProvider)
        .check(cancelToken: cancelToken);
    health = result;
  } on DioException catch (_) {
    // Cancelled or unreachable: `health` stays null and the row says so.
  } catch (_) {
    // Any other failure is treated the same — show "Slow connection — continuing".
  }

  final done = onboarding.getStatus() == OnboardingStatus.complete;
  final step = onboarding.resumeStep();
  final destination = done
      ? (authenticated ? SplashDestination.home : SplashDestination.login)
      : SplashDestination.onboarding;
  final location = done ? (authenticated ? '/' : '/login') : step.routeName;

  return SplashReadiness(
    destination: destination,
    location: location,
    statusLabel: health == null
        ? 'Slow connection — continuing'
        : (health.healthy
              ? 'Connected securely'
              : 'Offline — saved data only'),
    authenticated: authenticated,
    user: repository.currentUser,
    onboardingStep: done ? null : step,
    backendReachable: health?.healthy,
  );
});

/// A [State] with one looping animation. It repeats while the OS allows motion
/// and rests at [restValue] under "Reduce Motion" (blueprint §6.5).
abstract class _LoopingState<T extends StatefulWidget> extends State<T>
    with SingleTickerProviderStateMixin {
  _LoopingState(this.duration, {this.restValue = 0});

  final Duration duration;
  final double restValue;

  late final AnimationController loop = AnimationController(
    vsync: this,
    duration: duration,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Never read MediaQuery in initState — it is not available there.
    if (context.novaReduceMotion) {
      loop.stop();
      loop.value = restValue;
    } else if (!loop.isAnimating) {
      loop.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    loop.dispose();
    super.dispose();
  }
}

/// `onboarding/splash.html` — the real launch screen.
///
/// Ports `.bg-aurora` (two blurred accent radials drifting on an 18s loop over a
/// bottom vignette), `.logo` (120x120 accent tile carrying the shield mark,
/// floating +/-6px on a 4s loop), `.wordmark`, `.tagline` and `.status` with its
/// pulsing cyan dot. The export's `.frame`/`.theme-toggle` are OpenDesign preview
/// chrome and are deliberately not reproduced.
///
/// Not a timed delay: readiness is reported the moment
/// [splashReadinessProvider] settles. With no [onReady] the page navigates to
/// `readiness.location` itself; pass [onReady] to take over that decision.
class SplashPage extends ConsumerStatefulWidget {
  const SplashPage({super.key, this.onReady});

  /// Called once, after the startup work has genuinely finished.
  final ValueChanged<SplashReadiness>? onReady;

  @override
  ConsumerState<SplashPage> createState() => _SplashPageState();
}

class _SplashPageState extends ConsumerState<SplashPage> {
  bool _reported = false;

  @override
  Widget build(BuildContext context) {
    final readiness = ref.watch(splashReadinessProvider);
    final resolved = readiness.asData?.value;

    // A last resort, so a provider error can never present as an unexplained hang.
    // The provider above is written not to throw; this is what happens if it ever does.
    if (readiness.hasError && !_reported) {
      _reported = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        context.go('/login');
      });
    }

    if (resolved != null && !_reported) {
      _reported = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final callback = widget.onReady;
        if (callback != null) {
          callback(resolved);
        } else {
          context.go(resolved.location);
        }
      });
    }

    return Scaffold(
      backgroundColor: context.nova.bg,
      body: Stack(
        children: [
          const _Aurora(),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(32, 60, 32, 80),
              child: Column(
                children: [
                  const _LogoGroup(),
                  const Spacer(),
                  _StatusRow(
                    // The export's copy while the work runs, then the truth.
                    label: resolved?.statusLabel ?? 'Connecting securely',
                    online: resolved?.backendReachable,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// `.logo` ring, `.wordmark` and `.tagline` on the export's 36/12/60px rhythm,
/// with `.logo`'s 4s float.
class _LogoGroup extends StatefulWidget {
  const _LogoGroup();

  @override
  State<_LogoGroup> createState() => _LogoGroupState();
}

class _LogoGroupState extends _LoopingState<_LogoGroup> {
  _LogoGroupState() : super(const Duration(seconds: 4));

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    // displayLarge is the theme's Plus Jakarta 800 display style.
    final display = Theme.of(context).textTheme.displayLarge!;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedBuilder(
          animation: loop,
          builder: (context, child) => Transform.translate(
            offset: Offset(0, -6 * Curves.easeInOut.transform(loop.value)),
            child: child,
          ),
          child: Container(
            // `.logo::before` — inset: -8px, radius 42, 1px white at 8%.
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(42),
              border: Border.all(color: c.onAccent.withValues(alpha: 0.08)),
            ),
            child: Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                gradient: c.accentGradient,
                borderRadius: BorderRadius.circular(36),
                boxShadow: [
                  BoxShadow(
                    color: c.accent.withValues(alpha: 0.6),
                    blurRadius: 80,
                    spreadRadius: -20,
                    offset: const Offset(0, 30),
                  ),
                ],
              ),
              child: Center(
                child: CustomPaint(
                  size: const Size.square(64),
                  painter: _ShieldPainter(color: c.onAccent),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 36),
        // `.wordmark` — 44px 800, -0.04em, fg -> fg@0.72 down the glyphs.
        NovaGradientText(
          'NOVA',
          style: display.copyWith(fontSize: 44, letterSpacing: -1.76),
        ),
        const SizedBox(height: 12),
        Text(
          'Private companion, on your terms.',
          textAlign: TextAlign.center,
          style: Theme.of(
            context,
          ).textTheme.bodyLarge!.copyWith(color: c.muted),
        ),
      ],
    );
  }
}

/// The export's inline 64x64 shield SVG, painted path-for-path.
class _ShieldPainter extends CustomPainter {
  const _ShieldPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 64);

    final fill = Paint()
      ..style = PaintingStyle.fill
      ..color = color.withValues(alpha: 0.08);
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5
      ..color = color;
    final shield = Path()
      ..moveTo(32, 4)
      ..lineTo(52, 16)
      ..lineTo(52, 38)
      ..cubicTo(52, 50, 42, 58, 32, 60)
      ..cubicTo(22, 58, 12, 50, 12, 38)
      ..lineTo(12, 16)
      ..close();

    canvas.drawPath(shield, fill);
    canvas.drawPath(shield, stroke..strokeJoin = StrokeJoin.round);
    canvas.drawCircle(const Offset(32, 28), 6, Paint()..color = color);
    canvas.drawPath(
      Path()
        ..moveTo(22, 42)
        ..quadraticBezierTo(32, 50, 42, 42),
      stroke..strokeCap = StrokeCap.round,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_ShieldPainter oldDelegate) => oldDelegate.color != color;
}

/// `.status` — mono 12px uppercase, tracking .08em, with `.dot` pulsing on the
/// 1.4s design loop and a 4px halo. The label is genuine startup state.
class _StatusRow extends StatefulWidget {
  const _StatusRow({required this.label, this.online});

  final String label;
  final bool? online;

  @override
  State<_StatusRow> createState() => _StatusRowState();
}

class _StatusRowState extends _LoopingState<_StatusRow> {
  _StatusRowState() : super(NovaMotion.pulse, restValue: 1);

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    // Cyan is the export's resting tone; the probe result only sharpens it.
    final tone = switch (widget.online) {
      true => c.success,
      false => c.warning,
      null => c.cyan,
    };

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        FadeTransition(
          opacity: Tween<double>(begin: 0.5, end: 1).animate(loop),
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.85, end: 1.1).animate(loop),
            child: Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: c.cyan,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: c.cyan.withValues(alpha: 0.15),
                    spreadRadius: 4,
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Flexible(
          child: Text(
            widget.label.toUpperCase(),
            textAlign: TextAlign.center,
            // labelSmall is the theme's JetBrains Mono style.
            style: Theme.of(context).textTheme.labelSmall!.copyWith(
              fontSize: NovaType.caption,
              letterSpacing: 0.96,
              height: 1.2,
              color: tone,
            ),
          ),
        ),
      ],
    );
  }
}

/// `.bg-aurora` — the shared aura with the export's 18s drift, over the
/// `::after` bottom vignette. The export nests the radials in a 140%-wide layer
/// offset by -20%, so its 30%/35% and 75%/70% fold into 0.22/0.29 and 0.85/0.78
/// of the frame.
class _Aurora extends StatelessWidget {
  const _Aurora();

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Stack(
      children: [
        const OnboardingAura(
          primary: (0.22, 0.29, 0.35),
          secondary: (0.85, 0.78, 0.25),
          drift: true,
        ),
        Positioned.fill(
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment.bottomCenter,
                  radius: 1,
                  colors: [
                    c.bg.withValues(alpha: 0.6),
                    c.bg.withValues(alpha: 0),
                  ],
                  stops: const [0, 0.7],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Gradient-filled display text: the export's `.wordmark` (splash) and
/// `.heading` (otp) both fade `fg` to 72% of itself down the glyphs. It lives
/// here because this task allowed exactly three new files.
class NovaGradientText extends StatelessWidget {
  const NovaGradientText(
    this.text, {
    super.key,
    required this.style,
    this.textAlign = TextAlign.center,
  });

  final String text;
  final TextStyle style;
  final TextAlign textAlign;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return ShaderMask(
      blendMode: BlendMode.srcIn,
      shaderCallback: (rect) => LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [c.fg, c.fg.withValues(alpha: 0.72)],
      ).createShader(rect),
      child: Text(text, style: style, textAlign: textAlign),
    );
  }
}
