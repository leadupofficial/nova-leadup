import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../../core/voice/voice_provider.dart';
import '../../core/voice/wake_word_controller.dart';

/// Floating NOVA orb + status panel — port of `overlay/floating.html`.
///
/// Geometry from the export: the 80px gradient `overlay-bubble` at
/// `top:60 right:24` with a cyan live dot and a 4s float loop; the
/// `overlay-panel` glass sheet at `left/right/bottom:24` (85% surface, 40px
/// backdrop blur, 24px radius, 18px padding). It returns a [Positioned.fill], so
/// it must be a **direct** child of a [Stack]:
/// `Stack(children: [MyScreen(), FloatingOverlay()])`.
///
/// The export's `.notice` at `bottom:8` is deliberately **not** here any more.
/// Painting it from this overlay put it in the shell's stack, above the body,
/// where it covered the Home screen's overview cards. It is a layout element now
/// ([SummonHint], mounted by the shell below the screen's `Expanded` slot), so
/// it reserves its own space instead of landing on content.
///
/// Real wiring: the copy comes from [voiceProvider] (`VoiceState`) and
/// [wakeWordStateProvider] (`WakeWordState`) — the same state the Home/Converse
/// avatars read — and the cyan dot (brand-spec rule 2: cyan is for live states
/// only) is lit only while a voice state is genuinely live. Tapping the orb runs
/// [_startVoice]: it writes that shared state and opens `/converse`, the same
/// real destination as Home's "Tap to talk" CTA. No second microphone path is
/// invented — on-device capture is not implemented in this app (there is no
/// recorder dependency), so the action enters the session that does exist.
///
/// Not ported (DESIGN-HANDOFF.md: no OpenDesign chrome in product UI):
/// `.simulated-app` (the mocked WhatsApp backdrop) and `.theme-toggle`.
class FloatingOverlay extends ConsumerStatefulWidget {
  const FloatingOverlay({
    super.key,
    this.initiallyExpanded = false,
    this.onAskNova,
    this.onTranslate,
    this.onReminder,
    this.onTask,
    this.onDraftReply,
  });

  final bool initiallyExpanded;

  /// Replaces the default primary action ([_startVoice]).
  final VoidCallback? onAskNova;

  /// The four `.action-chip`s. A null callback renders the chip disabled rather
  /// than pretending to act.
  final VoidCallback? onTranslate;
  final VoidCallback? onReminder;
  final VoidCallback? onTask;
  final VoidCallback? onDraftReply;

  @override
  ConsumerState<FloatingOverlay> createState() => _FloatingOverlayState();
}

class _FloatingOverlayState extends ConsumerState<FloatingOverlay>
    with TickerProviderStateMixin {
  /// `@keyframes float` is 4s, which is the [NovaMotion.breatheRing] token.
  late final AnimationController _float = AnimationController(
    vsync: this,
    duration: NovaMotion.breatheRing,
  );

  /// `@keyframes pulse` — 1.4s on `.bubble .dot`.
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: NovaMotion.pulse,
  );

  late bool _expanded = widget.initiallyExpanded;

  /// The `live` value the two loops were last synced for, so the controllers are
  /// started and parked only when it actually changes.
  bool _motionLive = false;
  bool? _motionRunning;

  /// Starts or parks the float/pulse loops.
  ///
  /// Both are `repeat()` loops, and a running [AnimationController] asks the
  /// engine for a frame every vsync for as long as it runs. This orb is mounted
  /// by the shell, so leaving them running made *every* tab render at 60 fps
  /// forever — measured on the OnePlus 9R at ~100 % of one core on Tasks, Memory
  /// and Me, none of which is doing anything. They now run only while something
  /// is genuinely live; [live] deliberately does *not* include the passive
  /// "wake word is armed" state, which is a background capability the UI reports
  /// with static chrome (the lit dot and the status copy), not with motion.
  void _syncMotion() {
    final running = _motionLive && !context.novaReduceMotion;
    if (_motionRunning == running) return;
    _motionRunning = running;
    if (running) {
      if (!_float.isAnimating) _float.repeat(reverse: true);
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
      return;
    }
    // `stop()` alone: writing `value` would notify listeners mid-build.
    _float.stop();
    _pulse.stop();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncMotion();
  }

  @override
  void dispose() {
    _float.dispose();
    _pulse.dispose();
    super.dispose();
  }

  /// The real voice path that already exists: the shared voice/avatar state plus
  /// the Converse screen (mirrors `HomePage`'s "Tap to talk").
  Future<void> _startVoice() async {
    await ref.read(voiceProvider.notifier).setState(VoiceState.listening);
    await ref.read(avatarStateProvider.notifier).setState(AvatarState.listening);
    if (!mounted) return;
    final override = widget.onAskNova;
    if (override != null) {
      override();
      return;
    }
    // Null when hosted outside a GoRouter (e.g. a widget test).
    GoRouter.maybeOf(context)?.go('/converse');
  }

  void _summon() {
    setState(() => _expanded = true);
    unawaited(_startVoice());
  }

  /// The current route path, or `''` when hosted outside a GoRouter (widget tests).
  String _currentPath(BuildContext context) =>
      GoRouter.maybeOf(context)?.routerDelegate.currentConfiguration.uri.path ??
      '';

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final voice = ref.watch(voiceProvider);
    final wake = ref.watch(wakeWordStateProvider);
    final avatar = ref.watch(avatarStateProvider);
    final prompt = _promptFor(voice, wake);
    final live = _live(voice, wake);
    final face = _faceState(voice, wake, avatar);

    // The loops follow what is actually live, not merely armed. Doing this here
    // (rather than in `didChangeDependencies`) is what lets them react to a voice
    // turn starting or ending; it only touches controllers, never `setState`.
    _motionLive = live;
    _syncMotion();

    return Positioned.fill(
      child: Stack(
        children: [
          // Home already carries the hero avatar with "Tap to talk" and the wake-word
          // hint, and it owns the only top bar in the app. Drawing the 80px summon orb
          // there too put it straight through the notification bell and the settings
          // icon — two avatars, one of them on top of the controls. Home keeps the
          // prominent one; every other screen keeps the orb.
          if (_currentPath(context) != '/')
            Positioned(
              top: 60,
              right: NovaSpace.gutter,
              child: _orb(c, live, face),
            ),
          Positioned(
            left: NovaSpace.gutter,
            right: NovaSpace.gutter,
            bottom: NovaSpace.gutter,
            child: IgnorePointer(
              ignoring: !_expanded,
              child: AnimatedSlide(
                offset: Offset(0, _expanded ? 0 : 0.12),
                duration: NovaMotion.uiMax,
                curve: Curves.easeOut,
                child: AnimatedOpacity(
                  opacity: _expanded ? 1 : 0,
                  duration: NovaMotion.ui,
                  child: _panel(c, prompt),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// The panel copy, driven by the real voice state.
  static ({String headline, String detail}) _promptFor(
    AsyncValue<VoiceState> voice,
    WakeWordState wake,
  ) {
    final state = voice.asData?.value;
    final base = switch (state) {
      VoiceState.listening => ('🎙 Listening…', 'What would you like to do?'),
      VoiceState.processing => ('🧠 Thinking…', 'Working on your request…'),
      VoiceState.speaking => ('🔊 Speaking', 'Tap to interrupt'),
      VoiceState.error => ('⚠️ Something went wrong', 'Tap "Ask NOVA" to retry.'),
      VoiceState.inactive => ('😴 Not listening', 'Tap "Ask NOVA" to start.'),
      VoiceState.ready => ('😊 Ready', 'What would you like to do?'),
      null => voice is AsyncError
          ? ('⚠️ Voice service unavailable', 'Tap "Ask NOVA" to try anyway.')
          : ('⏳ Getting ready…', 'Connecting to the voice service…'),
    };

    final passive =
        state == null || state == VoiceState.ready || state == VoiceState.inactive;
    if (wake.listening && passive) {
      // `phrase` is null only before availability has been probed or when the
      // build has no wake word installed; neither case may be filled in with a
      // phrase the app cannot hear.
      final phrase = wake.phrase;
      return (
        headline: phrase == null ? '🎙 Listening' : '🎙 Listening for "$phrase"',
        detail: 'Say the wake word, or tap "Ask NOVA".',
      );
    }
    return (headline: base.$1, detail: base.$2);
  }

  /// True while a voice turn is genuinely in flight.
  ///
  /// The passive wake word is *not* included. "Armed" is a background capability
  /// that stays true for days; treating it as live is what kept `_float`,
  /// `_pulse` and the orb's rig rendering at 60 fps on every screen for no
  /// reason. The lit dot still reports the wake word (see [_orb]).
  static bool _live(AsyncValue<VoiceState> voice, WakeWordState wake) {
    final state = voice.asData?.value;
    return state == VoiceState.listening ||
        state == VoiceState.processing ||
        state == VoiceState.speaking;
  }

  /// The rig's state for the orb: the voice state is the live one on this
  /// surface, with the wake word lifting an idle voice state to "listening".
  /// Falls back to the shared avatar state when the voice service is unknown.
  NovaAvatarFaceState _faceState(
    AsyncValue<VoiceState> voice,
    WakeWordState wake,
    AsyncValue<AvatarState> avatar,
  ) {
    final voiceState = voice.asData?.value;
    final base = voiceState != null
        ? faceStateForVoice(voiceState)
        : switch (avatar) {
            AsyncData(:final value) => faceStateForAvatar(value),
            AsyncError() => NovaAvatarFaceState.warning,
            _ => NovaAvatarFaceState.idle,
          };
    return faceStateForWake(base, wake.listening);
  }

  /// `NovaAvatarPrefs`, or the defaults while the request is in flight.
  String get _avatarEmotion =>
      ref.watch(avatarPrefsProvider).asData?.value.emotion ?? 'neutral';

  NovaAvatarDensity get _avatarDensity => NovaAvatarDensity.parse(
    ref.watch(avatarPrefsProvider).asData?.value.animationDensity,
  );

  /// `.bubble` — 80px gradient orb, cyan `.dot`, float + pulse loops.
  ///
  /// The face inside is the code-drawn rig ([NovaAvatarFace]) at 60px, not an
  /// emoji: its line weights derive from the paint box, so the eyes and mouth
  /// survive the small size. It follows the same [voiceProvider] /
  /// [avatarStateProvider] state the Home and Converse avatars use.
  Widget _orb(NovaColors c, bool live, NovaAvatarFaceState face) {
    return Semantics(
      button: true,
      label: 'Summon NOVA',
      child: GestureDetector(
        onTap: _summon,
        behavior: HitTestBehavior.opaque,
        child: AnimatedBuilder(
          animation: _float,
          builder: (context, child) => Transform.translate(
            offset: Offset(0, -6 * Curves.easeInOut.transform(_float.value)),
            child: child,
          ),
          child: SizedBox(
            width: 80,
            height: 80,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Positioned.fill(
                  child: Container(
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: c.accentGradient,
                      boxShadow: [
                        BoxShadow(
                          color: c.accent.withValues(alpha: 0.6),
                          blurRadius: 60,
                          spreadRadius: -16,
                          offset: const Offset(0, 24),
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
                          c.onAccent.withValues(alpha: 0),
                        ],
                        stops: const [0, 0.55],
                      ),
                    ),
                    child: Container(
                      width: 62,
                      height: 62,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: c.surface,
                      ),
                      child: NovaAvatarFace(
                        size: 60,
                        state: face,
                        emotion: _avatarEmotion,
                        density: _avatarDensity,
                        // The orb rides above every tab, so its rig is the one
                        // face that could bill the whole app: it animates only
                        // while a turn is live.
                        animate: live,
                      ),
                    ),
                  ),
                ),
                Positioned(
                  top: -2,
                  right: -2,
                  child: AnimatedBuilder(
                    animation: _pulse,
                    builder: (context, _) => Transform.scale(
                      scale: live ? 0.9 + 0.2 * _pulse.value : 1,
                      child: Opacity(
                        opacity: live ? 0.6 + 0.4 * _pulse.value : 1,
                        child: Container(
                          width: 18,
                          height: 18,
                          decoration: BoxDecoration(
                            color: live ? c.cyan : c.muted,
                            shape: BoxShape.circle,
                            border: Border.all(color: c.surface, width: 2),
                          ),
                        ),
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

  /// `.panel` — glass sheet with the real state copy, four chips and the CTA.
  Widget _panel(NovaColors c, ({String headline, String detail}) prompt) {
    return ClipRRect(
      borderRadius: NovaRadius.rLg,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 40, sigmaY: 40),
        child: Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: c.surface.withValues(alpha: 0.85),
            borderRadius: NovaRadius.rLg,
            border: Border.all(color: c.glassBorder),
            boxShadow: [
              BoxShadow(
                color: c.shadow,
                blurRadius: 80,
                spreadRadius: -20,
                offset: const Offset(0, 30),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('NOVA', style: _display(c, 16, NovaType.wBold)),
                  const Spacer(),
                  Semantics(
                    button: true,
                    label: 'Close NOVA panel',
                    child: GestureDetector(
                      onTap: () => setState(() => _expanded = false),
                      behavior: HitTestBehavior.opaque,
                      child: Container(
                        width: 28,
                        height: 28,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: c.glass,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          Icons.close_rounded,
                          size: 15,
                          color: c.fg,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: prompt.headline, style: _body(c, 14, c.fg)),
                    TextSpan(
                      text: '\n${prompt.detail}',
                      style: _body(c, 13, c.fg.withValues(alpha: 0.55)),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  _chip(c, '🌐', 'Translate', widget.onTranslate),
                  const SizedBox(width: 8),
                  _chip(c, '⏰', 'Reminder', widget.onReminder),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  _chip(c, '✓', 'Task', widget.onTask),
                  const SizedBox(width: 8),
                  _chip(c, '✍', 'Draft reply', widget.onDraftReply),
                ],
              ),
              const SizedBox(height: 12),
              _primary(c),
            ],
          ),
        ),
      ),
    );
  }

  /// `.action-chip` — 12px radius, glass fill, 12px label.
  Widget _chip(NovaColors c, String emoji, String label, VoidCallback? onTap) {
    return Expanded(
      child: Semantics(
        button: true,
        enabled: onTap != null,
        label: label,
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: Opacity(
            opacity: onTap == null ? 0.45 : 1,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: c.glass,
                borderRadius: NovaRadius.rControl,
                border: Border.all(color: c.glassBorder),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(emoji, style: const TextStyle(fontSize: 12)),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: NovaTheme.chip(c),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// `.action-primary` — 12px padding/radius, accent gradient, 14px display.
  Widget _primary(NovaColors c) {
    return Semantics(
      button: true,
      label: 'Ask NOVA',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: _startVoice,
          borderRadius: NovaRadius.rControl,
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              gradient: c.accentGradient,
              borderRadius: NovaRadius.rControl,
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.mic_none_rounded, size: 16, color: c.onAccent),
                const SizedBox(width: 8),
                Text(
                  'Ask NOVA',
                  style: _display(
                    c,
                    14,
                    NovaType.wSemiBold,
                  ).copyWith(color: c.onAccent),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The wake word NOVA will actually listen for, humanised (`hey_nova` ->
/// `Hey Nova`), or null when no wake word is installed in this build.
///
/// There is deliberately no invented fallback. An earlier version returned the
/// string `'Hey Nova'` unconditionally, from a hardcoded product name rather
/// than from what the service reports, so the app could name a phrase the
/// microphone was not listening for. Callers now have to say something honest
/// when this returns null.
///
/// Public because `wakeword_page.dart` shows it too.
String? wakePhrase(WakeWordState wake) => wake.phrase;

// The export pins exact families/weights, so these build them from the bundled
// NovaFonts/NovaType tokens rather than falling back to framework defaults.
TextStyle _display(NovaColors c, double size, FontWeight weight) => TextStyle(
  fontFamily: NovaFonts.display,
  fontSize: size,
  fontWeight: weight,
  color: c.fg,
  height: 1.2,
  letterSpacing: size >= 28 ? -0.02 : -0.01,
  fontVariations: [FontVariation('wght', NovaTheme.wght(weight))],
);

TextStyle _body(NovaColors c, double size, Color color) => TextStyle(
  fontFamily: NovaFonts.body,
  fontSize: size,
  color: color,
  height: 1.5,
  fontVariations: [FontVariation('wght', NovaTheme.wght(NovaType.wRegular))],
);
