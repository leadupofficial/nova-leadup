import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';

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
class NovaAvatarRing extends StatefulWidget {
  const NovaAvatarRing({
    super.key,
    this.size = 180,
    this.face = '😊',
    this.state = NovaAvatarState.idle,
    this.child,
    this.breathe = true,
  });

  final double size;
  final String face;
  final NovaAvatarState state;

  /// When provided, replaces the emoji face (e.g. a Rive/Live2D renderer).
  final Widget? child;
  final bool breathe;

  @override
  State<NovaAvatarRing> createState() => _NovaAvatarRingState();
}

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
                    child:
                        widget.child ??
                        Text(
                          widget.face,
                          style: TextStyle(fontSize: widget.size * 0.44),
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

/// `.recording-indicator` — five bars waving out of phase.
///
/// Port of the export: 3px bars, 1s loop, delays 0/.15/.3/.45/.6, height
/// swinging 6px <-> 20px. brand-spec rule 6 makes this the red treatment.
class NovaWaveform extends StatefulWidget {
  const NovaWaveform({
    super.key,
    this.bars = 5,
    this.height = 20,
    this.color,
    this.animate = true,
  });

  final int bars;
  final double height;
  final Color? color;
  final bool animate;

  @override
  State<NovaWaveform> createState() => _NovaWaveformState();
}

class _NovaWaveformState extends State<NovaWaveform>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: NovaMotion.waveform,
  );

  @override
  void initState() {
    super.initState();
  }

  void _sync() {
    final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (widget.animate && !reduce) {
      _c.repeat();
    } else {
      _c.stop();
      _c.value = 0.25;
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
    final color = widget.color ?? c.danger;

    return SizedBox(
      height: widget.height,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: List.generate(widget.bars, (i) {
              // Phase-shift each bar by 0.15 of the cycle, as the CSS delays do.
              final t = (_c.value + i * 0.15) % 1.0;
              final wave = (math.sin(t * 2 * math.pi) + 1) / 2;
              final h = 6 + wave * (widget.height - 6);
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1.5),
                child: Container(
                  width: 3,
                  height: h,
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              );
            }),
          );
        },
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
    this.faceSize = 96,
    this.onTap,
  });

  final String face;
  final String statusLabel;
  final Color? statusTone;
  final double faceSize;
  final VoidCallback? onTap;

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
                child: Text(
                  widget.face,
                  style: TextStyle(fontSize: widget.faceSize),
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
