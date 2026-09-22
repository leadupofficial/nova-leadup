import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../avatar/avatar_provider.dart' show AvatarState;
import '../../theme/nova_theme.dart';
import '../../voice/voice_capture.dart';
import '../../voice/voice_provider.dart';
import 'nova_avatar_rig_painter.dart';
import 'nova_avatar_rig_support.dart';

/// The rig's vocabulary: how lively it may be, and which state it is in.
///
/// Both map onto `NovaAvatarPrefs` from the settings API, and
/// [NovaAvatarFaceState] mirrors the `AvatarState` union in
/// `packages/shared-types/src/types.ts` (~line 720) — the contract the repo
/// already models and has no Dart side of yet. The app's smaller [AvatarState] /
/// [VoiceState] enums are translated by [faceStateForAvatar],
/// [faceStateForVoice] and [faceStateForWake].

/// How lively the rig is allowed to be (`NovaAvatarPrefs.animationDensity`).
enum NovaAvatarDensity {
  /// Slower, subtler motion and rarer blinks.
  low,

  /// The default: mid-speed motion and typical human blink cadence.
  medium,

  /// More frequent blinks and livelier drift.
  high;

  /// Anything unrecognised (including `null`) is [NovaAvatarDensity.medium].
  static NovaAvatarDensity parse(String? raw) => switch (raw) {
    'low' => NovaAvatarDensity.low,
    'high' => NovaAvatarDensity.high,
    _ => NovaAvatarDensity.medium,
  };
}

/// Mirror of the shared-types `AvatarState` union (types.ts ~line 720).
///
/// The rig speaks the cross-platform contract's vocabulary; the app's smaller
/// [AvatarState] / [VoiceState] enums are translated by [faceStateForAvatar],
/// [faceStateForVoice] and [faceStateForWake].
enum NovaAvatarFaceState {
  idle,
  listening,
  thinking,
  speaking,
  success,
  warning,
  offline,
  recording;

  /// Not [NovaAvatarFaceState.offline]: they are the two states where the face
  /// holds still rather than idling.
  bool get isStill =>
      this == NovaAvatarFaceState.success || this == NovaAvatarFaceState.warning;

  /// True only while NOVA is doing something the user is waiting on: a voice
  /// turn in flight, or a recording. These are the states whose motion is worth
  /// a continuous frame budget.
  ///
  /// [listening] is included because it is what a real listening turn maps to.
  /// It is *not* the passive "wake word is armed" state — that is a background
  /// capability, not foreground activity, and a caller that only knows the wake
  /// word is armed must not pass `animate: true` (see `faceStateForWake`).
  bool get isLive =>
      this == NovaAvatarFaceState.listening ||
      this == NovaAvatarFaceState.thinking ||
      this == NovaAvatarFaceState.speaking ||
      this == NovaAvatarFaceState.recording;
}

/// [AvatarState] -> [NovaAvatarFaceState].
NovaAvatarFaceState faceStateForAvatar(AvatarState state) => switch (state) {
  AvatarState.idle => NovaAvatarFaceState.idle,
  AvatarState.listening => NovaAvatarFaceState.listening,
  AvatarState.thinking => NovaAvatarFaceState.thinking,
  AvatarState.speaking => NovaAvatarFaceState.speaking,
  AvatarState.alert => NovaAvatarFaceState.warning,
  AvatarState.sleeping => NovaAvatarFaceState.offline,
};

/// [VoiceState] -> [NovaAvatarFaceState].
NovaAvatarFaceState faceStateForVoice(VoiceState state) => switch (state) {
  VoiceState.inactive => NovaAvatarFaceState.offline,
  VoiceState.ready => NovaAvatarFaceState.idle,
  VoiceState.listening => NovaAvatarFaceState.listening,
  VoiceState.processing => NovaAvatarFaceState.thinking,
  VoiceState.speaking => NovaAvatarFaceState.speaking,
  VoiceState.error => NovaAvatarFaceState.warning,
};

/// `emotion` is one of [NovaAvatarPrefs.emotions]; anything else is neutral.
/// `wake` is a face state used only while the app is idle off the wake word.
NovaAvatarFaceState faceStateForWake(NovaAvatarFaceState current, bool wake) {
  if (!wake || current != NovaAvatarFaceState.idle) return current;
  return NovaAvatarFaceState.listening;
}

/// The rigged face: a character drawn entirely in code.
///
/// There is no avatar art in this repository (`assets/avatar/` holds a README
/// and an unrendered placeholder SVG) and no `.riv` file, so this renderer is
/// the whole avatar: a [CustomPainter] plus `context.nova` token colours. No
/// images, no new package. Dark and light both work because every colour comes
/// from the palette.
///
/// Owns one [AnimationController] (a five-minute timeline; the painter resolves
/// each frame from it) and, only while the mouth has a measured source, one
/// microphone-level subscription. Continuous motion is driven from the
/// controller through an [AnimatedBuilder] — there is no per-frame `setState`,
/// so `pumpAndSettle` is not held open by a rebuild loop. Under
/// `MediaQuery.disableAnimations`, or whenever [animate] is false, the
/// controller is stopped at a calm still pose and no blink is ever scheduled.
///
/// [animate] is the frame-budget switch, and it defaults to **false**. A
/// repeating [AnimationController] is a permanent 60 fps commitment: it asks the
/// engine for a frame every vsync for as long as it runs, and each of those
/// frames repaints whatever is on screen. A rig that starts animating at mount
/// and never stops therefore pins a core on an otherwise idle screen — measured
/// on the OnePlus 9R at ~113 % of one core and 61 fps on Home with nothing
/// happening. Callers pass `animate: true` only while the face really is live
/// ([NovaAvatarFaceState.isLive], i.e. a voice turn is in flight), so the same
/// face looks right when it should run and settles when it should not.
///
/// Nothing here claims viseme lip-sync. See [NovaAvatarFacePainter] for exactly
/// what the speaking mouth is and is not.
class NovaAvatarFace extends ConsumerStatefulWidget {
  const NovaAvatarFace({
    super.key,
    this.size = 180,
    this.state = NovaAvatarFaceState.idle,
    this.emotion = 'neutral',
    this.density = NovaAvatarDensity.medium,
    this.micLevels,
    this.animate = false,
  });

  final double size;
  final NovaAvatarFaceState state;

  /// `NovaAvatarPrefs.emotion` — neutral / happy / calm / curious / focused.
  final String emotion;

  /// `NovaAvatarPrefs.animationDensity`.
  final NovaAvatarDensity density;

  /// Microphone amplitude source. Defaults to the real [VoiceCapture.levels]
  /// stream; a test or preview can pass another `Stream<double>` of `0..1`.
  final Stream<double>? micLevels;

  /// Whether this face may hold a continuous frame budget right now.
  ///
  /// False (the default) parks the timeline at a still pose, so an idle screen
  /// settles instead of rendering forever. See the class comment.
  final bool animate;

  @override
  ConsumerState<NovaAvatarFace> createState() => _NovaAvatarFaceState();
}

class _NovaAvatarFaceState extends ConsumerState<NovaAvatarFace>
    with SingleTickerProviderStateMixin {
  late final AnimationController _timeline = AnimationController(
    vsync: this,
    duration: const Duration(minutes: 5),
  );

  final math.Random _rng = math.Random();

  /// Populated only while the mouth actually has a measured source, and only
  /// after the first build: nothing reads `voiceCaptureProvider` for a face
  /// that is merely idle, so the recorder is never constructed needlessly.
  StreamSubscription<double>? _levelsSub;

  /// Live mouth amplitude. Written by the stream and read by the builder — it is
  /// never a `setState` input.
  double _mouthAmplitude = 0;

  /// Blink schedule. Absolute seconds along the timeline.
  double _nextBlinkAt = 0;
  double _blinkStartedAt = -1;
  double _blinkDurationSeconds = 0.11;

  /// Whether the current blink is the second half of a double blink.
  bool _blinkIsDouble = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // `MediaQuery` is read here, never in `initState`.
    _syncLevels();
    _syncMotion();
  }

  @override
  void dispose() {
    _levelsSub?.cancel();
    _levelsSub = null;
    _timeline.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant NovaAvatarFace old) {
    super.didUpdateWidget(old);
    if (old.state != widget.state ||
        old.density != widget.density ||
        old.micLevels != widget.micLevels) {
      _syncLevels();
    }
    if (old.state != widget.state ||
        old.density != widget.density ||
        old.micLevels != widget.micLevels ||
        old.animate != widget.animate) {
      _syncMotion();
    }
  }

  /// Subscribes to the microphone exactly while the mouth is being driven by it.
  void _syncLevels() {
    final wants = widget.state == NovaAvatarFaceState.listening ||
        widget.state == NovaAvatarFaceState.recording;
    if (!wants) {
      _levelsSub?.cancel();
      _levelsSub = null;
      return;
    }
    if (_levelsSub != null) return;
    // Real microphone amplitude (dBFS mapped to 0..1 by `VoiceCapture`), unless
    // the caller supplied its own stream. Resolving the capture service is
    // guarded because `record`'s constructor touches the platform channel, and
    // a face must still draw if that is unavailable (as it is in widget tests).
    final Stream<double> levels;
    try {
      levels = widget.micLevels ?? ref.read(voiceCaptureProvider).levels;
    } catch (_) {
      return;
    }
    _levelsSub = levels.listen((level) {
      // Light smoothing so a single loud frame cannot snap the jaw open.
      _mouthAmplitude = (_mouthAmplitude * 0.55 + level.clamp(0.0, 1.0) * 0.45)
          .clamp(0.0, 1.0);
    });
  }

  /// Starts or parks the timeline.
  ///
  /// A parked face holds the same calm pose `MediaQuery.disableAnimations`
  /// produces, so "no motion" is already a designed look rather than a frozen
  /// mid-animation frame. It is also the only way an idle screen can stop asking
  /// the engine for frames: a running [AnimationController] schedules the next
  /// vsync unconditionally.
  void _syncMotion() {
    if (!widget.animate || context.novaReduceMotion) {
      _timeline.stop();
      _timeline.value = 0;
      return;
    }
    if (!_timeline.isAnimating) _timeline.repeat();
  }

  /// Signals that come from the microphone are only honoured while the user is
  /// actually speaking: the level is dropped (and the mouth closed) in every
  /// other state, so a stale stream value can never leave the jaw hanging open.
  double get _effectiveAmplitude =>
      widget.state == NovaAvatarFaceState.listening ||
          widget.state == NovaAvatarFaceState.recording
      ? _mouthAmplitude
      : 0;

  /// Irregular autonomous blink cadence.
  ///
  /// Human blinks are not a metronome, so intervals are drawn from a range
  /// that [NovaAvatarDensity] widens or tightens. `_scheduleBlink` is queued
  /// ahead of the timeline, so a wrap at the 5-minute loop point needs no
  /// special handling. Roughly one blink in eight is a double blink — two short
  /// blinks with a ~115 ms gap — which is the cheapest way for the face to stop
  /// reading as a loop.
  void _advanceBlinkSchedule(double now) {
    if (now < _nextBlinkAt) return;
    final (minGap, maxGap) = switch (widget.density) {
      NovaAvatarDensity.low => (4.0, 7.5),
      NovaAvatarDensity.medium => (2.3, 4.6),
      NovaAvatarDensity.high => (1.5, 2.6),
    };
    final double step;
    if (_blinkIsDouble) {
      step = 0.115;
      _blinkIsDouble = false;
    } else {
      final double gap = minGap + _rng.nextDouble() * (maxGap - minGap);
      _blinkIsDouble = _rng.nextDouble() < 0.12;
      step = gap;
    }
    _nextBlinkAt += step;
    _blinkStartedAt = now;
    _blinkDurationSeconds = switch (widget.density) {
      NovaAvatarDensity.low => 0.14,
      NovaAvatarDensity.medium => 0.11,
      NovaAvatarDensity.high => 0.09,
    };
  }

  double _blinkClosure(double seconds) {
    if (_blinkStartedAt < 0) return 0;
    final t = seconds - _blinkStartedAt;
    if (t < 0 || t > _blinkDurationSeconds) return 0;
    // Stretch the "shut" phase so the lid actually lands rather than
    // triangularly grazing closed.
    return Curves.easeInOut.transform(
      math.sin(t / _blinkDurationSeconds * math.pi),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.nova;
    // "Still" covers both a reader who asked for reduced motion and a caller
    // that has no frame budget to spend: the painter renders the same calm pose.
    final still = !widget.animate || context.novaReduceMotion;
    final secondsPerLoop = _timeline.duration!.inMicroseconds / 1e6;

    return RepaintBoundary(
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        child: AnimatedBuilder(
          animation: _timeline,
          builder: (context, _) {
            final seconds = still ? 0.0 : _timeline.value * secondsPerLoop;
            if (!still) _advanceBlinkSchedule(seconds);
            return CustomPaint(
              painter: NovaAvatarFacePainter(
                frame: rigFrame(
                  colors: colors,
                  seconds: seconds,
                  state: widget.state,
                  emotion: widget.emotion,
                  density: widget.density,
                  blink: still ? 0 : _blinkClosure(seconds),
                  amplitude: _effectiveAmplitude,
                  reducedMotion: still,
                  // Matches the painter's `size.shortestSide * 0.40` head
                  // radius, so the breathing float scales with the face.
                  radius: widget.size * 0.40,
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

