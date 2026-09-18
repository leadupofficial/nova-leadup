import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';
import 'nova_avatar_rig.dart';

// The rig's state and density vocabulary is part of this file's public API
// (`NovaAvatarRing.animationDensity`, `NovaAvatarHeroCard.state`), so callers
// that import the avatar directly do not also need to import the rig.
export 'nova_avatar_rig.dart' show NovaAvatarDensity, NovaAvatarFaceState;

/// `.avatar-ring` + `.avatar-inner` from the converse screen.
///
/// A gradient ring that breathes (`breatheRing`, 4s, scale .96 <-> 1.04) around
/// a surface-filled circle showing the companion face.
///
/// blueprint §6.6 sets the real target: MVP is "2D rigged (Live2D-class)" with
/// expression states, blink, head tilt and amplitude-driven mouth motion, behind
/// an `AvatarEngine` interface. This widget is the designed *container* for that
/// — it renders the ring, glow and state, and takes an arbitrary [child] so a
/// rigged renderer can be dropped in without touching the layout.
///
/// Since [NovaAvatarFace] exists, the rig **is** the default face. [face] is
/// retained so callers that predate the rig still compile, but the emoji is now
/// an explicit fallback: pass `showEmojiFace: true` to opt back into it (and
/// `reducedMotionFace: true` to prefer it under OS "Reduce Motion"). [child]
/// still wins over both, so an external renderer can replace the rig.
class NovaAvatarRing extends StatefulWidget {
  const NovaAvatarRing({
    super.key,
    this.size = 180,
    this.face = '😊',
    this.state = NovaAvatarState.idle,
    this.child,
    this.breathe = true,
    this.emotion = 'neutral',
    this.animationDensity = NovaAvatarDensity.medium,
    this.showEmojiFace = false,
    this.reducedMotionFace = false,
  });

  final double size;
  final String face;
  final NovaAvatarState state;

  /// When provided, replaces the rig (e.g. a Rive/Live2D renderer).
  final Widget? child;
  final bool breathe;

  /// `NovaAvatarPrefs.emotion`, passed straight through to the rig.
  final String emotion;

  /// `NovaAvatarPrefs.animationDensity`, passed straight through to the rig.
  final NovaAvatarDensity animationDensity;

  /// Opt back into the emoji instead of the code-drawn rig.
  final bool showEmojiFace;

  /// Draw the emoji (rather than the rig's calm still pose) when the OS has
  /// "Reduce Motion" on.
  final bool reducedMotionFace;

  @override
  State<NovaAvatarRing> createState() => _NovaAvatarRingState();
}

/// The face layer that sits inside an avatar circle.
///
/// [state] is the rig's own vocabulary; [faceStateFor] converts the design
/// system's `NovaAvatarState` for callers that have one.
///
/// Priority: an explicit [child], then the emoji when asked for, then the rig.
/// The rig handles its own "Reduce Motion" pose, so it stays the default even
/// when that setting is on unless the caller opts out.
Widget novaAvatarFaceLayer({
  required BuildContext context,
  required double size,
  required NovaAvatarFaceState state,
  required NovaAvatarDensity animationDensity,
  required String emotion,
  required String emoji,
  required Widget? child,
  required bool showEmojiFace,
  required bool reducedMotionFace,
  double? emojiSize,
}) {
  if (child != null) return child;
  final reduce = context.novaReduceMotion;
  if (showEmojiFace || (reducedMotionFace && reduce)) {
    // Falls back to the circle diameter, which is what the pre-rig call sites
    // used as the glyph size.
    return Text(
      emoji,
      style: TextStyle(fontSize: emojiSize ?? size),
    );
  }
  return NovaAvatarFace(
    size: size,
    state: state,
    emotion: emotion,
    density: animationDensity,
  );
}

/// The design system's `NovaAvatarState` -> the rig's state vocabulary.
NovaAvatarFaceState faceStateFor(NovaAvatarState state) => switch (state) {
  NovaAvatarState.idle => NovaAvatarFaceState.idle,
  NovaAvatarState.wake => NovaAvatarFaceState.listening,
  NovaAvatarState.listening => NovaAvatarFaceState.listening,
  NovaAvatarState.thinking => NovaAvatarFaceState.thinking,
  NovaAvatarState.awaitingConfirmation => NovaAvatarFaceState.thinking,
  NovaAvatarState.executing => NovaAvatarFaceState.thinking,
  NovaAvatarState.speaking => NovaAvatarFaceState.speaking,
  NovaAvatarState.success => NovaAvatarFaceState.success,
  NovaAvatarState.error => NovaAvatarFaceState.warning,
  NovaAvatarState.recording => NovaAvatarFaceState.recording,
};

class _NovaAvatarRingState extends State<NovaAvatarRing>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: NovaMotion.breatheRing,
  );

  @override
  void initState() {
    super.initState();
  }

  void _sync() {
    final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (widget.breathe && !reduce && widget.state.isAnimated) {
      _c.repeat(reverse: true);
    } else {
      _c.stop();
      _c.value = 0.5;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(covariant NovaAvatarRing old) {
    super.didUpdateWidget(old);
    if (old.state != widget.state || old.breathe != widget.breathe) _sync();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final recording = widget.state.isRecordingStyle;
    final gradient = recording ? c.recordingGradient : c.accentGradient;

    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: ScaleTransition(
        scale: Tween<double>(begin: 0.96, end: 1.04).animate(
          CurvedAnimation(parent: _c, curve: Curves.easeInOut),
        ),
        child: Container(
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: gradient,
            boxShadow: NovaShadows.avatarRing(c),
          ),
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: c.surface,
            ),
            child: ClipOval(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  // `.avatar-inner::before` — soft top-left highlight.
                  DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: RadialGradient(
                        center: const Alignment(-0.4, -0.4),
                        radius: 0.9,
                        colors: [
                          Colors.white.withValues(alpha: 0.15),
                          Colors.transparent,
                        ],
                      ),
                    ),
                  ),
                  Center(
                    child: novaAvatarFaceLayer(
                      context: context,
                      size: widget.size,
                      state: faceStateFor(widget.state),
                      animationDensity: widget.animationDensity,
                      emotion: widget.emotion,
                      emoji: widget.face,
                      child: widget.child,
                      showEmojiFace: widget.showEmojiFace,
                      reducedMotionFace: widget.reducedMotionFace,
                      emojiSize: widget.size * 0.44,
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
}

/// `.avatar-state` — the floating state pill under the avatar.
class NovaAvatarStateBadge extends StatelessWidget {
  const NovaAvatarStateBadge({super.key, required this.state});

  final NovaAvatarState state;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final tone = state.isRecordingStyle ? c.danger : c.fg;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(
        color: c.pillScrim,
        borderRadius: NovaRadius.rPill,
        border: Border.all(color: c.glassBorder),
      ),
      child: Text(
        state.label,
        style: NovaTheme.avatarState(c).copyWith(color: tone),
      ),
    );
  }
}


/// `.avatar-container` from the home screen — the tall rounded panel that holds
/// the companion, with the `.avatar-status` pill in its top-right corner and a
/// breathing glow behind the face.
class NovaAvatarHeroCard extends StatefulWidget {
  const NovaAvatarHeroCard({
    super.key,
    this.face = '😊',
    this.statusLabel = 'Ready',
    this.statusTone,
    // 0 means "size to the card" — see the LayoutBuilder in build().
    this.faceSize = 0,
    this.onTap,
    this.state = NovaAvatarFaceState.idle,
    this.emotion = 'neutral',
    this.animationDensity = NovaAvatarDensity.medium,
    this.showEmojiFace = false,
  });

  final String face;
  final String statusLabel;
  final Color? statusTone;

  /// Diameter of the face circle (the rig, or the emoji when opted in).
  /// `0` derives it from the card's width.
  final double faceSize;
  final VoidCallback? onTap;

  /// Drives the rig's expression, mouth and eyes.
  final NovaAvatarFaceState state;
  final String emotion;
  final NovaAvatarDensity animationDensity;

  /// Opt back into the emoji instead of the code-drawn rig.
  final bool showEmojiFace;

  @override
  State<NovaAvatarHeroCard> createState() => _NovaAvatarHeroCardState();
}

class _NovaAvatarHeroCardState extends State<NovaAvatarHeroCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: NovaMotion.breathe,
  );

  @override
  void initState() {
    super.initState();
  }

  void _sync() {
    final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (!reduce) {
      _c.repeat(reverse: true);
    } else {
      _c.stop();
      _c.value = 0.5;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final tone = widget.statusTone ?? c.success;

    return AspectRatio(
      aspectRatio: 1 / 1.15,
      child: ClipRRect(
        borderRadius: NovaRadius.rAvatarContainer,
        child: Container(
          decoration: BoxDecoration(
            gradient: c.avatarContainerGradient,
            borderRadius: NovaRadius.rAvatarContainer,
            border: Border.all(color: c.border),
          ),
          child: Stack(
            alignment: Alignment.bottomCenter,
            children: [
              // Breathing aura behind the face.
              Positioned(
                top: 40,
                child: AnimatedBuilder(
                  animation: _c,
                  builder: (context, child) {
                    final s = 0.9 + _c.value * 0.2;
                    return Transform.scale(
                      scale: s,
                      child: Opacity(
                        opacity: 0.6 + _c.value * 0.4,
                        child: child,
                      ),
                    );
                  },
                  child: Container(
                    width: 220,
                    height: 220,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: RadialGradient(
                        colors: [
                          c.accent.withValues(alpha: 0.30),
                          c.accentSecondary.withValues(alpha: 0.15),
                          Colors.transparent,
                        ],
                        stops: const [0, 0.5, 0.7],
                      ),
                    ),
                  ),
                ),
              ),
              // `.avatar-glow` at the base.
              Positioned(
                bottom: 0,
                child: Container(
                  width: 160,
                  height: 160,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(
                      colors: [
                        c.accent.withValues(alpha: 0.2),
                        Colors.transparent,
                      ],
                      stops: const [0, 0.7],
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 20),
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    // Keep the face proportional to the card so the rig never
                    // falls below the size where its detail is legible.
                    final face = widget.faceSize > 0
                        ? widget.faceSize
                        : math.max(96.0, constraints.maxWidth * 0.45);
                    return novaAvatarFaceLayer(
                      context: context,
                      size: face,
                      state: widget.state,
                      animationDensity: widget.animationDensity,
                      emotion: widget.emotion,
                      emoji: widget.face,
                      child: null,
                      showEmojiFace: widget.showEmojiFace,
                      reducedMotionFace: false,
                    );
                  },
                ),
              ),
              // `.avatar-status` pill.
              Positioned(
                top: 16,
                right: 16,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: c.pillScrim,
                    borderRadius: NovaRadius.rPill,
                    border: Border.all(color: c.glassBorder),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          color: tone,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: tone.withValues(alpha: 0.5),
                              blurRadius: 8,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        widget.statusLabel,
                        style: NovaTheme.avatarState(c),
                      ),
                    ],
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
