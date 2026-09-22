import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Genuine connectivity from `NetworkInfoService`.
///
/// The platform stream does not replay its current value, so the provider seeds
/// itself with a real `isConnected` check before following changes — otherwise
/// the first frame would have to guess.
final connectivityProvider = StreamProvider<bool>((ref) async* {
  final info = ref.watch(networkInfoServiceProvider);
  yield await info.isConnected;
  yield* info.onConnectivityChanged;
});

/// `.bg-aura` / `.bg-aurora`: the two blurred accent radials the onboarding
/// screens paint behind their content (40px blur), each at its own position.
/// It lives here because this task allowed exactly three new files and
/// `core/design/widgets` already ships the dashboard's top-anchored [NovaAura].
class OnboardingAura extends StatefulWidget {
  const OnboardingAura({
    super.key,
    required this.primary,
    required this.secondary,
    this.drift = false,
  });

  /// `(x, y, alpha)` of the accent radial, as fractions of the screen.
  final (double, double, double) primary;

  /// `(x, y, alpha)` of the accent-secondary radial.
  final (double, double, double) secondary;

  /// The splash's `drift` keyframes: an 18s loop of `translate(3%,-3%)` and a
  /// 2deg rotation, suppressed under "Reduce Motion".
  final bool drift;

  @override
  State<OnboardingAura> createState() => _OnboardingAuraState();
}

class _OnboardingAuraState extends State<OnboardingAura>
    with SingleTickerProviderStateMixin {
  late final AnimationController? _drift = widget.drift
      ? AnimationController(vsync: this, duration: const Duration(seconds: 18))
      : null;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Never read MediaQuery in initState — it is not available there.
    final drift = _drift;
    if (drift == null) return;
    if (context.novaReduceMotion) {
      drift.stop();
    } else if (!drift.isAnimating) {
      drift.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _drift?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Positioned.fill(
      child: IgnorePointer(
        child: ClipRect(
          child: LayoutBuilder(
            builder: (context, box) => AnimatedBuilder(
              animation: _drift ?? const AlwaysStoppedAnimation<double>(0),
              builder: (context, child) {
                // drift: translate(3%,-3%) rotate(2deg) at the midpoint.
                final t = Curves.easeInOut.transform(_drift?.value ?? 0);
                return Transform.rotate(
                  angle: t * math.pi / 90,
                  child: FractionalTranslation(
                    translation: Offset(0.03 * t, -0.03 * t),
                    child: child,
                  ),
                );
              },
              child: Stack(
                children: [
                  _blob(box.maxWidth, box.maxHeight, widget.primary, c.accent),
                  _blob(
                    box.maxWidth,
                    box.maxHeight,
                    widget.secondary,
                    c.accentSecondary,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _blob(double w, double h, (double, double, double) at, Color color) {
    const size = 420.0;
    return Positioned(
      left: w * at.$1 - size / 2,
      top: h * at.$2 - size / 2,
      child: ImageFiltered(
        imageFilter: ImageFilter.blur(sigmaX: 40, sigmaY: 40),
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: RadialGradient(
              colors: [
                color.withValues(alpha: at.$3),
                color.withValues(alpha: 0),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// `onboarding/offline.html` — the no-connection state.
///
/// Ports `.logo`, `.status-icon`, `.heading`, `.sub`, `.stats`,
/// `.warning-banner` and `.btn-secondary` at the export's 60/32px rhythm and
/// 320px content width, with the export's exact copy. `.frame`/`.theme-toggle`
/// are OpenDesign preview chrome and are not reproduced.
///
/// Two places the export cannot be honoured literally:
///
/// 1. `.stats` prints "3 saved / 5 cached / 4 local". The app has no local store
///    for tasks, reminders or memories — `drift` is a declared dependency but no
///    database is ever opened — so those counts cannot be produced. The card
///    reports the truth instead: live counts from the real overview endpoint when
///    the network allows a fetch, and "Not cached" when it does not.
/// 2. The export designs only the disconnected state. When connectivity returns
///    this says so rather than continuing to claim there is none, and
///    [onReconnect] lets a caller resume. The page never navigates on its own.
class OfflinePage extends ConsumerStatefulWidget {
  const OfflinePage({super.key, this.onReconnect});

  /// Called once when connectivity appears while this screen is mounted.
  final VoidCallback? onReconnect;

  @override
  ConsumerState<OfflinePage> createState() => _OfflinePageState();
}

class _OfflinePageState extends ConsumerState<OfflinePage> {
  bool _retrying = false;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final text = Theme.of(context).textTheme;
    // Null only before the seed resolves; the design's state is the safe thing
    // to show for that single frame.
    final online = ref.watch(connectivityProvider).value ?? false;

    ref.listen<AsyncValue<bool>>(connectivityProvider, (previous, next) {
      if (!(next.value ?? false)) return;
      if (previous?.value ?? false) return;
      final callback = widget.onReconnect;
      if (callback == null) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) callback();
      });
    });

    return Scaffold(
      backgroundColor: c.bg,
      body: Stack(
        children: [
          // `.bg-aura` — accent at 30%/35% (alpha .25), accent-secondary at
          // 75%/70% (alpha .15).
          const OnboardingAura(
            primary: (0.30, 0.35, 0.25),
            secondary: (0.75, 0.70, 0.15),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(32, 60, 32, 60),
              child: Center(
                child: SingleChildScrollView(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 320),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Center(child: _Logo()),
                        const SizedBox(height: 28),
                        Center(child: _StatusIcon(online: online)),
                        const SizedBox(height: 24),
                        Text(
                          online ? 'Back online' : 'No connection',
                          textAlign: TextAlign.center,
                          style: text.displayLarge?.copyWith(
                            letterSpacing: -0.96,
                          ),
                        ),
                        const SizedBox(height: 12),
                        // `.sub` — 15px muted, 1.6 line-height, 300px cap.
                        Center(
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 300),
                            child: Text(
                              online
                                  ? 'Live AI is available again.'
                                  // "Your saved reminders still work" read as a
                                  // contradiction beside the "Reminders — Not
                                  // cached" row below it. Both are true of
                                  // different things: an armed alarm is scheduled
                                  // on the device and fires offline (verified with
                                  // the radio off), while the *list* is not cached
                                  // for browsing. Say which.
                                  : 'Reminders you have already set still fire. '
                                        'Live AI is unavailable — reconnect to '
                                        'restore conversation.',
                              textAlign: TextAlign.center,
                              style: text.bodyLarge!.copyWith(
                                color: c.muted,
                                height: 1.6,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 36),
                        _Stats(online: online),
                        const SizedBox(height: 28),
                        _WarningBanner(online: online),
                        const SizedBox(height: 20),
                        _RetryButton(
                          busy: _retrying,
                          onPressed: _retrying ? null : _retry,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// A real retry: re-runs the connectivity check, then refreshes the counts.
  Future<void> _retry() async {
    setState(() => _retrying = true);
    try {
      // Invalidate drops the cached seed, so `.future` resolves from a fresh
      // `checkConnectivity()` call rather than a stale value.
      ref.invalidate(connectivityProvider);
      await ref.read(connectivityProvider.future);
      ref.invalidate(homeOverviewProvider);
    } catch (_) {
      // The provider reports the outcome; a throw here is the platform channel
      // refusing to answer.
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }
}

/// `.logo` — 96x96 surface tile at 60% opacity. The export gives `.logo` no
/// font-family, so it inherits the body stack.
class _Logo extends StatelessWidget {
  const _Logo();

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Opacity(
      opacity: 0.6,
      child: Container(
        width: 96,
        height: 96,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: NovaRadius.rAvatarContainer,
          border: Border.all(color: c.border),
        ),
        child: Text(
          'N',
          style: Theme.of(
            context,
          ).textTheme.bodyLarge!.copyWith(fontSize: 44, height: 1),
        ),
      ),
    );
  }
}

/// `.status-icon` — 72px circle: warning while disconnected, success when the
/// device is really back on a network.
class _StatusIcon extends StatelessWidget {
  const _StatusIcon({required this.online});

  final bool online;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final tone = online ? c.success : c.warning;

    return Container(
      width: 72,
      height: 72,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: tone.withValues(alpha: 0.1),
        border: Border.all(color: tone.withValues(alpha: 0.2)),
      ),
      child: online
          ? Icon(Icons.check_rounded, size: 34, color: tone)
          : const Text('⚠', style: TextStyle(fontSize: 36)),
    );
  }
}

/// `.stats` — real values only; see [OfflinePage].
class _Stats extends ConsumerWidget {
  const _Stats({required this.online});

  final bool online;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!online) return const _StatsCard();
    final overview = ref.watch(homeOverviewProvider).value;
    return _StatsCard(
      reminders: overview?.reminders,
      tasks: overview?.openTasks,
      memories: overview?.memories,
    );
  }
}

class _StatsCard extends StatelessWidget {
  const _StatsCard({this.reminders, this.tasks, this.memories});

  final int? reminders;
  final int? tasks;
  final int? memories;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      padding: const EdgeInsets.all(NovaSpace.md),
      decoration: BoxDecoration(
        color: c.surface,
        // `.stats` radius is 18px, which is the bubble token.
        borderRadius: NovaRadius.rBubble,
        border: Border.all(color: c.border),
      ),
      child: Column(
        children: [
          _row(context, 'Reminders', reminders, 'saved'),
          _row(context, 'Tasks', tasks, 'open'),
          _row(context, 'Memories', memories, 'saved'),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, String label, int? value, String unit) {
    final c = context.nova;
    final text = Theme.of(context).textTheme;
    final style = text.bodySmall!.copyWith(fontSize: 13, height: 1.4);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: style),
          Text(
            value == null ? 'Not cached' : '$value $unit',
            style: value == null
                ? style
                : text.titleMedium!.copyWith(
                    fontSize: 13,
                    height: 1.4,
                    color: c.success,
                  ),
          ),
        ],
      ),
    );
  }
}

/// The advisory line under the status card.
///
/// This used to be a `const` widget with no inputs, so it rendered
/// *"Rate-limited or maintenance mode. Retry later or contact support."* on
/// **every** visit to this page — including the one it exists for, a plain loss
/// of connectivity. Measured on the OnePlus 9R after a reboot with the API
/// unreachable: the header said *"No connection"* and *"Live AI is unavailable —
/// reconnect to restore conversation"* while the banner underneath told the user
/// to contact support about a rate limit. Two contradictory diagnoses on one
/// screen, and the wrong one sends a user with no wifi to the wrong action.
///
/// The page knows exactly one thing — whether it is online — so the banner now
/// says only what that supports. The rate-limit wording is kept for the case it
/// was written for: reachable but refusing.
class _WarningBanner extends StatelessWidget {
  const _WarningBanner({required this.online});

  /// Whether the device currently has a usable connection to NOVA.
  final bool online;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 320),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: c.warning.withValues(alpha: 0.08),
            borderRadius: NovaRadius.rControl,
            border: Border.all(color: c.warning.withValues(alpha: 0.15)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.error_outline_rounded, size: 14, color: c.warning),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  online
                      ? 'Rate-limited or maintenance mode. Retry later or '
                            'contact support.'
                      : 'You appear to be offline. NOVA will reconnect when '
                            'the network is back — nothing you saved is lost.',
                  style: Theme.of(context).textTheme.bodySmall!.copyWith(
                    height: 1.4,
                    color: c.warning,
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

/// `.btn-secondary` — full-width block action. [NovaSecondaryButton] is the
/// export's pill-shaped `.chip`, which this is not.
class _RetryButton extends StatelessWidget {
  const _RetryButton({required this.busy, required this.onPressed});

  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final enabled = onPressed != null && !busy;

    return Semantics(
      button: true,
      enabled: enabled,
      label: 'Try again',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: enabled ? onPressed : null,
          // `.btn-secondary` uses 14px, which no radius token carries.
          borderRadius: BorderRadius.circular(14),
          child: AnimatedOpacity(
            opacity: enabled ? 1 : 0.6,
            duration: NovaMotion.uiMin,
            child: Container(
              padding: const EdgeInsets.all(14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: c.surfaceRaised,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: c.border),
              ),
              child: busy
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: c.fg,
                      ),
                    )
                  : Text(
                      'Try again',
                      style: NovaTheme.cta(
                        c,
                      ).copyWith(fontSize: NovaType.bodySmall),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
