import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import '../../core/permissions/permission_provider.dart';
import '../../core/voice/wake_word_controller.dart';
import 'floating_overlay.dart' show humanizeWakeWord, wakePhrase;

/// Wake word — port of `overlay/wakeword.html`, wired to the real
/// [WakeWordController] (`core/voice/wake_word_controller.dart`).
///
/// Real members used: `wakeWordStateProvider` (`enabled`, `listening`, `busy`,
/// `availability`, `lastDetection`, `error`); `setEnabled(bool)` for the persisted
/// enable/disable and the native start/stop round-trip; `stop()` for "Pause";
/// `arm()` on entry, matching `HomePage`'s refresh path;
/// `WakeWordAvailability.models` for the phrase (read from the native plugin, not
/// hardcoded); `lastDetection` for the detected-state line; and
/// `permissionProvider.requestMicrophone()` / `openAppSettings()` when the failure
/// really is a permission failure.
///
/// What the controller does NOT expose: a sensitivity/threshold setting or a
/// custom-phrase setter: [WakeWordController]/[WakeWordPlatform] only offer
/// `availability/start/stop/isRunning/events` and `wakeword.html` shows no such
/// control, so none is rendered rather than faking a slider that writes nowhere.
///
/// Not ported: `.theme-toggle` (the preview's theme switch) — OpenDesign chrome.
/// The export's centered `.bg-aura` is rendered with the app's existing
/// [NovaAura], the canonical ambient background for this design system.
class WakeWordPage extends ConsumerStatefulWidget {
  const WakeWordPage({super.key});

  @override
  ConsumerState<WakeWordPage> createState() => _WakeWordPageState();
}

class _WakeWordPageState extends ConsumerState<WakeWordPage> {
  static const String _subtitle =
      'Say the wake word anytime, even from your pocket. Audio never leaves '
      'your device until the wake word is detected.';

  @override
  void initState() {
    super.initState();
    // The Android foreground service can be killed under memory pressure and
    // `arm()` is the documented place to bring it back. No MediaQuery here.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(wakeWordStateProvider.notifier).arm(); });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final wake = ref.watch(wakeWordStateProvider);
    final supported = wake.availability?.available ?? false;
    final phrase = wakePhrase(wake);
    final detection = wake.lastDetection;

    return Scaffold(
      backgroundColor: c.bg,
      body: Stack(
        children: [
          const NovaAura(),
          SafeArea(
            top: false,
            child: Padding(
              // `.screen { padding: 60px 24px }`, minus room for `.notif`.
              padding: const EdgeInsets.fromLTRB(
                NovaSpace.gutter, 60, NovaSpace.gutter, 130),
              child: Center(
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _WakeOrb(
                        listening: wake.listening, enabled: wake.enabled),
                      const SizedBox(height: 40),
                      Text(
                        _label(wake, supported).toUpperCase(),
                        textAlign: TextAlign.center,
                        style: _display(c, 13, NovaType.wSemiBold)
                            .copyWith(color: c.muted, letterSpacing: 1.3),
                      ),
                      const SizedBox(height: NovaSpace.xs),
                      // `.phrase` — `linear-gradient(180deg, --fg, oklch(.70 .01
                      // 260))` clipped to the text. That grey has no token; it
                      // sits between `--fg` and `--muted`, so it is interpolated.
                      ShaderMask(
                        shaderCallback: (bounds) => LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [c.fg, Color.lerp(c.fg, c.muted, 0.65)!],
                        ).createShader(bounds),
                        child: Text(
                          '"$phrase"', textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.displayLarge!
                              .copyWith(color: c.onAccent),
                        ),
                      ),
                      const SizedBox(height: NovaSpace.xs),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 280),
                        child: Text(
                          _subtitle, textAlign: TextAlign.center, style: _body(c, 13, c.muted)),
                      ),
                      if (detection != null) ...[
                        const SizedBox(height: NovaSpace.md),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 300),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                Icons.check_circle_rounded,
                                size: 14, color: c.success),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  'Last heard '
                                  '"${humanizeWakeWord(detection.name)}" · '
                                  '${(detection.score * 100).round()}% · '
                                  '${_timeOfDay(detection.at)}',
                                  textAlign: TextAlign.center,
                                  style: _body(c, NovaType.caption, c.success),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                      if (wake.error != null ||
                          (wake.availability != null && !supported)) ...[
                        const SizedBox(height: NovaSpace.lg),
                        _statusCard(c, wake, supported),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            left: NovaSpace.gutter, right: NovaSpace.gutter,
            bottom: NovaSpace.gutter,
            child: _notif(
              c, wake, supported,
              _notifTitle(wake, supported, phrase),
              _notifDetail(wake, supported),
            ),
          ),
        ],
      ),
    );
  }

  static String _label(WakeWordState wake, bool supported) {
    if (wake.availability != null && !supported) return 'Wake word unavailable';
    if (wake.listening) return 'Listening for';
    if (wake.busy) return 'Starting…';
    if (wake.enabled) return 'Wake word paused';
    return 'Wake word is off';
  }

  static String _notifTitle(WakeWordState wake, bool supported, String phrase) {
    if (wake.availability != null && !supported) return 'Wake word is unavailable on this build';
    if (wake.listening) return 'NOVA is ready for "$phrase"';
    if (wake.enabled) return 'NOVA is paused';
    return 'NOVA is not listening for "$phrase"';
  }

  static String _notifDetail(WakeWordState wake, bool supported) {
    if (wake.availability != null && !supported) return 'Detection cannot start on this device';
    if (wake.listening) return 'Microphone listening is active locally';
    if (wake.enabled) return 'Wake word detection is not running';
    return 'Turn it on to hear the wake word';
  }

  static String _timeOfDay(DateTime at) {
    final local = at.toLocal();
    final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
    final minute = local.minute.toString().padLeft(2, '0');
    return "$hour:$minute ${local.hour < 12 ? 'AM' : 'PM'}";
  }

  /// The real `WakeWordState.error`, or an availability that says detection
  /// cannot run — with the actions that can actually change the outcome.
  Widget _statusCard(NovaColors c, WakeWordState wake, bool supported) {
    final error = wake.error;
    final availability = wake.availability;
    final permission =
        availability?.reason == 'permission_denied' ||
        (error?.toLowerCase().contains('microphone') ?? false);
    /// The native refusal for a missing POST_NOTIFICATIONS names it explicitly.
    final needsNotification =
        error?.toLowerCase().contains('notification') ?? false;
    final tone = error != null ? c.danger : c.warning;
    final message = error ?? availability?.userMessage ?? 'Unavailable.';
    final detail = error != null ? null : availability?.detail ?? availability?.reason;
    final controller = ref.read(wakeWordStateProvider.notifier);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: tone.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                error != null
                    ? Icons.error_outline_rounded
                    : Icons.info_outline_rounded,
                size: 16, color: tone),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(message, style: _body(c, NovaType.caption, c.fg)),
              ),
            ],
          ),
          if (detail != null)
            Text(detail, style: _body(c, NovaType.label, c.muted)),
          const SizedBox(height: NovaSpace.sm),
          Wrap(
            spacing: NovaSpace.xs,
            runSpacing: NovaSpace.xs,
            children: [
              // The native layer needs BOTH permissions and reports which one is
              // missing, so offer the action that matches the failure rather than
              // always asking for the microphone — which left a notification-denied
              // user tapping a button that could not help them.
              if (permission)
                NovaSecondaryButton(
                  label: 'Grant microphone access',
                  icon: Icons.mic_none_rounded,
                  onPressed: () => ref.read(permissionProvider.notifier).requestMicrophone(),
                ),
              if (needsNotification)
                NovaSecondaryButton(
                  label: 'Allow notifications',
                  icon: Icons.notifications_none_rounded,
                  onPressed: () =>
                      ref.read(permissionProvider.notifier).requestNotification(),
                ),
              NovaSecondaryButton(
                label: permission ? 'Open settings' : 'Try again',
                icon: permission
                    ? Icons.settings_outlined
                    : Icons.refresh_rounded,
                onPressed: permission
                    ? () => ref.read(permissionProvider.notifier).openAppSettings()
                    : () => controller.setEnabled(true),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// `.notif` — glass card at `bottom: 24px` with the real Pause/Turn off state.
  Widget _notif(
    NovaColors c,
    WakeWordState wake,
    bool supported,
    String title,
    String detail,
  ) {
    final controller = ref.read(wakeWordStateProvider.notifier);

    return ClipRRect(
      borderRadius: NovaRadius.rCard,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: c.surface.withValues(alpha: 0.85),
            borderRadius: NovaRadius.rCard,
            border: Border.all(color: c.glassBorder),
          ),
          child: Row(
            children: [
              Container(
                width: 36, height: 36, alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle, gradient: c.accentGradient),
                child: const Text('🎙', style: TextStyle(fontSize: 16)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min, children: [
                    Text(title, style: _display(c, 13, NovaType.wSemiBold)),
                    const SizedBox(height: 2),
                    Text(detail, style: _body(c, NovaType.label, c.muted)),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              if (wake.busy)
                SizedBox(
                  width: 18, height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2, color: c.accent),
                )
              else
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _notifButton(
                      c,
                      wake.listening
                          ? 'Pause'
                          : (wake.enabled ? 'Resume' : 'Turn on'),
                      wake.listening
                          ? controller.stop
                          : (supported ? () => controller.setEnabled(true) : null),
                    ),
                    if (wake.enabled) ...[
                      const SizedBox(width: 6),
                      _notifButton(
                        c, 'Turn off', () => controller.setEnabled(false)),
                    ],
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// `.notif-btn` — 8px radius, `--surface-raised`; 44px hit target (brand rule 5).
  Widget _notifButton(NovaColors c, String label, VoidCallback? onTap) {
    return SizedBox(
      height: NovaMotion.minTouchTarget,
      child: Center(
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: Opacity(
            opacity: onTap == null ? 0.45 : 1,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: c.surfaceRaised,
                borderRadius: NovaRadius.rSm,
                border: Border.all(color: c.border),
              ),
              child: Text(label, style: _body(c, NovaType.label, c.muted)),
            ),
          ),
        ),
      ),
    );
  }
}

/// `.rings` + `.orb` — three 2.4s ripple rings behind a 140px breathing orb.
class _WakeOrb extends StatefulWidget {
  const _WakeOrb({required this.listening, required this.enabled});

  /// Ripples only while the native service genuinely reports listening.
  final bool listening;

  /// Breathes whenever the wake word is armed.
  final bool enabled;

  @override
  State<_WakeOrb> createState() => _WakeOrbState();
}

class _WakeOrbState extends State<_WakeOrb> with TickerProviderStateMixin {
  /// `@keyframes ripple` is 2.4s and `@keyframes breathe` is 3s; neither duration
  /// has a `NovaMotion` token, so the export's values are kept verbatim.
  late final AnimationController _ripple = AnimationController(
    vsync: this, duration: const Duration(milliseconds: 2400));
  late final AnimationController _breathe = AnimationController(
    vsync: this, duration: const Duration(seconds: 3));

  /// MediaQuery is read here, never in `initState`.
  void _syncMotion() {
    final reduce = context.novaReduceMotion;
    final breathe = !reduce && (widget.enabled || widget.listening);
    final ripple = !reduce && widget.listening;
    if (breathe && !_breathe.isAnimating) _breathe.repeat(reverse: true);
    if (!breathe) { _breathe.stop(); _breathe.value = 0.5; }
    if (ripple && !_ripple.isAnimating) _ripple.repeat();
    if (!ripple) { _ripple.stop(); _ripple.value = 0; }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncMotion();
  }

  @override
  void didUpdateWidget(covariant _WakeOrb old) {
    super.didUpdateWidget(old);
    if (old.listening != widget.listening || old.enabled != widget.enabled) _syncMotion();
  }

  @override
  void dispose() {
    _ripple.dispose();
    _breathe.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return SizedBox(
      width: 240,
      height: 240,
      child: Stack(
        alignment: Alignment.center,
        // `.ring` scales to 1.2 of its 240px box, so ripples escape the bounds.
        clipBehavior: Clip.none,
        children: [
          if (widget.listening)
            AnimatedBuilder(
              animation: _ripple,
              builder: (context, _) => Stack(
                clipBehavior: Clip.none,
                children: List.generate(3, (i) {
                  // `.ring:nth-child(n)` delays: 0 / .8s / 1.6s of the 2.4s loop.
                  final t = (_ripple.value - i / 3) % 1.0;
                  return Positioned.fill(
                    child: Opacity(
                      opacity: 1 - t,
                      child: Transform.scale(
                        scale: 0.5 + 0.7 * t,
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: c.glassBorder))),
                      ),
                    ),
                  );
                }),
              ),
            )
          else
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: c.glassBorder)))),

          AnimatedBuilder(
            animation: _breathe,
            builder: (context, child) => Transform.scale(
              scale: 0.95 + 0.1 * Curves.easeInOut.transform(_breathe.value),
              child: child,
            ),
            child: Container(
              width: 140, height: 140, alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: c.accentGradient,
                boxShadow: [
                  BoxShadow(
                    color: c.accent.withValues(alpha: 0.6), blurRadius: 80,
                    spreadRadius: -20, offset: const Offset(0, 40),
                  ),
                ],
              ),
              // `inset 0 1px 0 oklch(1 0 0 / 0.3)` top highlight.
              foregroundDecoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    c.onAccent.withValues(alpha: 0.3),
                    c.onAccent.withValues(alpha: 0)],
                  stops: const [0, 0.55],
                ),
              ),
              child: const Text('🎙', style: TextStyle(fontSize: 60)),
            ),
          ),
        ],
      ),
    );
  }
}

// The export pins exact families/weights, so these build them from the bundled
// NovaFonts/NovaType tokens rather than falling back to framework defaults.
TextStyle _display(NovaColors c, double size, FontWeight weight) => TextStyle(
  fontFamily: NovaFonts.display,
  fontSize: size, fontWeight: weight, color: c.fg,
  height: 1.2, letterSpacing: -0.01,
  fontVariations: [FontVariation('wght', NovaTheme.wght(weight))],
);

TextStyle _body(NovaColors c, double size, Color color) => TextStyle(
  fontFamily: NovaFonts.body,
  fontSize: size, color: color, height: 1.5,
  fontVariations: [FontVariation('wght', NovaTheme.wght(NovaType.wRegular))],
);
