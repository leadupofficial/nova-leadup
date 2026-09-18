import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';
import 'nova_avatar_rig.dart';

/// Support types and pure helpers for the rig painter.
///
/// Split out of `nova_avatar_rig_painter.dart` to keep every file in this
/// directory under the repository's 500-line ceiling. Nothing here touches
/// animation state: given the same [NovaAvatarRigFrame] these functions always
/// return the same geometry.

/// One resolved frame of the rig.
///
/// [NovaAvatarFace] builds this once per animation tick and hands it to the
/// painter, which is why the painter needs no state machine of its own.
@immutable
class NovaAvatarRigFrame {
  const NovaAvatarRigFrame({
    required this.colors,
    required this.seconds,
    required this.state,
    required this.emotion,
    required this.density,
    required this.blink,
    required this.amplitude,
    required this.reducedMotion,
    required this.motion,
    required this.float,
    required this.tilt,
  });

  final NovaColors colors;

  /// Seconds along the rig's timeline.
  final double seconds;
  final NovaAvatarFaceState state;
  final String emotion;
  final NovaAvatarDensity density;

  /// `0` open, `1` fully shut.
  final double blink;

  /// Measured microphone amplitude, `0..1` while listening; `0` otherwise.
  final double amplitude;
  final bool reducedMotion;

  /// Drift scale after [reducedMotion] has been applied.
  final double motion;

  /// Vertical breathing offset, in logical pixels.
  final double float;

  /// Head roll, in radians.
  final double tilt;

  /// `success` and the warm emotions get cheek colour.
  bool get isWarm =>
      state == NovaAvatarFaceState.success ||
      emotion == 'happy' ||
      emotion == 'excited';

  /// Equality includes the numeric channels purely so
  /// [NovaAvatarFacePainter.shouldRepaint] stays honest if it is ever reused
  /// with a held frame rather than rebuilt per tick.
  @override
  bool operator ==(Object other) =>
      other is NovaAvatarRigFrame &&
      other.colors == colors &&
      other.state == state &&
      other.emotion == emotion &&
      other.density == density &&
      other.reducedMotion == reducedMotion &&
      other.seconds == seconds &&
      other.blink == blink &&
      other.amplitude == amplitude &&
      other.motion == motion &&
      other.float == float &&
      other.tilt == tilt;

  @override
  int get hashCode => Object.hash(
    colors,
    state,
    emotion,
    density,
    reducedMotion,
    seconds,
    blink,
    amplitude,
    motion,
    float,
    tilt,
  );
}

/// One eye's resolved geometry for a frame.
@immutable
class NovaAvatarEye {
  const NovaAvatarEye({
    required this.at,
    required this.rx,
    required this.ry,
    required this.look,
    required this.openness,
    required this.wide,
  });

  final Offset at;
  final double rx;
  final double ry;

  /// Pupil offset as a fraction of the travel available inside the eye.
  final Offset look;

  /// Lid openness before the blink channel is applied.
  final double openness;

  /// Draw the attentive bracket around the eye.
  final bool wide;
}

/// Pupil offset, lid openness and softening for the current frame.
///
/// Pupil direction is state-driven: at the user while listening, up and aside
/// while thinking, softened or half-closed at rest. Ambient drift keeps the
/// resting gaze alive without ever looking like a scan.
List<NovaAvatarEye> eyeGeometry(
  NovaAvatarRigFrame frame,
  Offset center,
  double radius,
) {
  final y = center.dy - radius * 0.14;
  final dx = radius * 0.34;
  final rx = radius * 0.155, baseRy = radius * 0.185;
  final asleep = frame.state == NovaAvatarFaceState.offline;
  final motion = frame.reducedMotion ? 0.0 : frame.density.motionScale;

  // Two incommensurate sines so the resting gaze never quite repeats.
  var gaze = Offset(
    math.sin(frame.seconds * 0.13 * 2 * math.pi) * 0.065 * motion,
    math.sin(frame.seconds * 0.21 * 2 * math.pi + 0.7) * 0.045 * motion,
  );
  var openness = 1.0;
  var wide = false;
  var soften = 0.0;

  switch (frame.state) {
    case NovaAvatarFaceState.listening:
      // Look at the person talking.
      gaze += const Offset(0, -0.10);
      wide = true;
    case NovaAvatarFaceState.thinking:
      // Up and off to one side — the "retrieving" tell, held long enough to
      // read without a label.
      gaze += Offset(
        0.26 + math.sin(frame.seconds * 0.35 * 2 * math.pi) * 0.03,
        -0.26,
      );
      openness = 0.92;
      soften = 0.15;
    case NovaAvatarFaceState.speaking:
      gaze += const Offset(0, -0.04);
    case NovaAvatarFaceState.success:
      gaze += const Offset(0, -0.08);
    case NovaAvatarFaceState.warning:
      gaze += const Offset(-0.12, 0.12);
      openness = 0.95;
    case NovaAvatarFaceState.offline:
      gaze = const Offset(0, 0.16);
      openness = 0.18;
    case NovaAvatarFaceState.recording:
      gaze += const Offset(0, -0.06);
      wide = true;
    case NovaAvatarFaceState.idle:
      // Ambient drift only.
      break;
  }

  // The stored emotion biases the resting pose.
  if (frame.emotion == 'calm' && !asleep) {
    openness *= 0.66;
    soften = 0.45;
  }
  if (frame.emotion == 'happy' && !asleep) openness *= 0.82;
  if (frame.emotion == 'focused' && !asleep) {
    openness = math.min(openness, 0.78);
    gaze += const Offset(0, 0.06);
    soften = math.max(soften, 0.2);
  }
  if (frame.emotion == 'curious' && frame.state == NovaAvatarFaceState.idle) {
    gaze += const Offset(0, -0.12);
    wide = true;
  }

  final ry = baseRy * (1 - soften * 0.22);
  return [
    for (final side in [-1.0, 1.0])
      NovaAvatarEye(
        at: Offset(center.dx + side * dx, y),
        rx: rx,
        ry: ry,
        look: gaze,
        openness: openness,
        wide: wide,
      ),
  ];
}

/// `(inner height, outer height, inner-x nudge)` for the brows.
///
/// The five stored emotions are distinguished by these three numbers alone; the
/// live state overrides them where the state is more urgent than the preference
/// (thinking raises both brows, warning tilts them concerned, offline flattens).
(double, double, double) browShape(NovaAvatarRigFrame frame) {
  final stored = switch (frame.emotion) {
    'happy' => (-0.02, -0.10, 0.0), // arched open
    'calm' => (0.02, 0.02, 0.0), // level and low
    'curious' => (-0.05, 0.04, 0.0), // asymmetric: one up, one down
    'focused' => (0.10, -0.01, 0.05), // knitted toward the nose
    'concerned' => (-0.09, 0.09, 0.03), // inner ends up, worried
    'excited' => (-0.05, -0.14, 0.0), // raised
    _ => (0.0, 0.0, 0.0), // neutral
  };
  return switch (frame.state) {
    NovaAvatarFaceState.thinking => (
      math.min(stored.$1, -0.10),
      math.min(stored.$2, -0.06),
      stored.$3,
    ),
    NovaAvatarFaceState.warning => (-0.11, 0.10, 0.04),
    NovaAvatarFaceState.offline => (0.05, 0.05, stored.$3),
    _ => stored,
  };
}

/// `(half width, half height)` of the mouth opening for the current frame.
///
/// `speaking` returns a **procedural envelope, not lip-sync** (see the class
/// documentation on `NovaAvatarFacePainter`). `listening` and `recording`
/// return shapes whose height follows the measured microphone amplitude.
/// Everything else returns a closed shape, drawn as a line or a smile.
(double, double) mouthOpening(NovaAvatarRigFrame frame, double radius) {
  switch (frame.state) {
    case NovaAvatarFaceState.speaking:
      // Two incommensurate sines stand in for syllable rate. This is an
      // approximation and is labelled as one everywhere it is described.
      final envelope = frame.reducedMotion
          ? 0.42
          : 0.5 +
                0.5 *
                    math.sin(frame.seconds * 2 * math.pi * 1.7) *
                    math.sin(frame.seconds * 2 * math.pi * 0.61 + 0.4);
      final open = (0.10 + envelope * 0.62).clamp(0.0, 0.7);
      final width =
          radius * (0.30 + 0.06 * math.sin(frame.seconds * 2 * math.pi * 0.9));
      return (width, radius * open);
    case NovaAvatarFaceState.listening:
      final attentive = (frame.amplitude * 0.5).clamp(0.0, 0.5);
      return (radius * 0.20, radius * (0.045 + attentive * 0.10));
    case NovaAvatarFaceState.recording:
      return (
        radius * 0.26,
        radius * (0.05 + 0.16 * (frame.reducedMotion ? 0.5 : frame.amplitude)),
      );
    case NovaAvatarFaceState.offline:
    case NovaAvatarFaceState.success:
    case NovaAvatarFaceState.warning:
    case NovaAvatarFaceState.thinking:
    case NovaAvatarFaceState.idle:
      return (0.0, 0.0);
  }
}

/// Resolves the rig's continuous channels for one frame.
///
/// The drift amplitudes scale with [NovaAvatarDensity] and collapse to zero
/// under "Reduce Motion", which is what makes the reduced-motion pose genuinely
/// still rather than merely slower.
NovaAvatarRigFrame rigFrame({
  required NovaColors colors,
  required double seconds,
  required NovaAvatarFaceState state,
  required String emotion,
  required NovaAvatarDensity density,
  required double blink,
  required double amplitude,
  required bool reducedMotion,
  required double radius,
}) {
  final motion = reducedMotion ? 0.0 : density.motionScale;
  final breathSpeed = density.breathSpeed *
      (state == NovaAvatarFaceState.offline ? 0.55 : 1.0);
  final breath = math.sin(seconds * breathSpeed * 2 * math.pi);
  return NovaAvatarRigFrame(
    colors: colors,
    seconds: seconds,
    state: state,
    emotion: emotion,
    density: density,
    blink: blink,
    amplitude: amplitude,
    reducedMotion: reducedMotion,
    motion: motion,
    float: breath * radius * 0.022 * motion,
    // Head tilt is a slow, mostly unnoticed roll; never a hinge.
    tilt: math.sin(seconds * 0.09 * 2 * math.pi + 1.1) * 0.055 * motion,
  );
}

extension NovaAvatarDensityTuning on NovaAvatarDensity {
  /// How far the drifting channels are allowed to move.
  double get motionScale => switch (this) {
    NovaAvatarDensity.low => 0.55,
    NovaAvatarDensity.medium => 1.0,
    NovaAvatarDensity.high => 1.5,
  };

  /// Breathing cycles per second at 1x.
  double get breathSpeed => switch (this) {
    NovaAvatarDensity.low => 0.13,
    NovaAvatarDensity.medium => 0.17,
    NovaAvatarDensity.high => 0.24,
  };
}
