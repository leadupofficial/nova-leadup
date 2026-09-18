import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';
import 'nova_avatar_rig.dart';
import 'nova_avatar_rig_support.dart';

/// The rig's drawing layer: everything the face is made of.
///
/// One [NovaAvatarFacePainter] draws exactly one frame from a
/// [NovaAvatarRigFrame] that [NovaAvatarFace] resolves. It holds no animation
/// state of its own, so it can never disagree with the widget about what time
/// it is.
///
/// ## What is real and what is not
///
/// * **Speaking is a stylised approximation, not lip-sync.** The TTS path
///   (`VoicePlayback` -> `just_audio`) exposes no viseme track and no waveform,
///   so there is no phoneme information to synchronise against. The mouth is a
///   procedural open/close envelope — a slow two-component sine standing in for
///   syllable rate, scaled by "audio is playing". It correlates with talking; it
///   does not track words. `packages/shared-types` models a 13-value `Viseme`
///   union and an optional `AvatarEngine.setViseme`, but nothing in this app
///   produces visemes, so none are pretended here.
/// * **Listening is real data.** While the user speaks, [NovaAvatarFace] feeds
///   the measured microphone amplitude from `VoiceCapture.levels` (dBFS mapped
///   to `0..1` by `VoiceCapture._addLevel`) into the frame.
/// * **Everything else is procedural**: the blink schedule, the pupil drift and
///   the breathing float are generated, not measured.
///
/// Every colour comes from [NovaColors], so dark and light both work, and every
/// dimension is a ratio of the paint box, so an 80px overlay orb and a 180px
/// converse ring use the same rig. Details that would smear at small sizes
/// (catchlights, blush, the attentive bracket) are skipped below a threshold
/// rather than drawn as mud.
class NovaAvatarFacePainter extends CustomPainter {
  const NovaAvatarFacePainter({required this.frame});

  final NovaAvatarRigFrame frame;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    final center = Offset(size.width / 2, size.height / 2);
    final radius = s * 0.40;
    final stroke = math.max(1.0, s * 0.012);
    final fine = math.max(0.9, s * 0.009);
    final shift = center + Offset(0, frame.float);

    canvas.save();
    canvas.translate(shift.dx, shift.dy);
    canvas.rotate(frame.tilt);
    canvas.translate(-shift.dx, -shift.dy);

    _head(canvas, shift, radius, stroke);
    _brows(canvas, shift, radius, stroke);
    _eyes(canvas, shift, radius, fine, s);
    _mouth(canvas, shift, radius, stroke);

    canvas.restore();
  }

  // ── head ───────────────────────────────────────────────────────────────────

  void _head(Canvas canvas, Offset center, double radius, double stroke) {
    // A pool of accent light behind the head, so the face sits in the ring
    // rather than being pasted onto it.
    canvas.drawCircle(
      center,
      radius * 1.18,
      Paint()
        ..shader = RadialGradient(
          colors: [
            frame.colors.accent.withValues(alpha: 0.18),
            frame.colors.accentSecondary.withValues(alpha: 0.06),
            Colors.transparent,
          ],
          stops: const [0, 0.55, 1],
        ).createShader(Rect.fromCircle(center: center, radius: radius * 1.18)),
    );

    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..shader = RadialGradient(
          center: const Alignment(-0.35, -0.45),
          radius: 1.1,
          colors: [frame.colors.surfaceRaised, frame.colors.surface],
        ).createShader(Rect.fromCircle(center: center, radius: radius)),
    );
    canvas.drawCircle(
      center,
      radius,
      _stroke(stroke, frame.colors.accent.withValues(alpha: 0.55)),
    );

    // A short shoulder arc hints at a body without drawing one.
    canvas.drawPath(
      Path()
        ..moveTo(center.dx - radius * 0.72, center.dy + radius * 1.34)
        ..quadraticBezierTo(
          center.dx,
          center.dy + radius * 0.92,
          center.dx + radius * 0.72,
          center.dy + radius * 1.34,
        ),
      _stroke(stroke * 1.4, frame.colors.border),
    );

    // Cheek warmth for the warm states, but only where it can be seen.
    if (frame.isWarm && radius > 26) {
      final blush = Paint()
        ..color = frame.colors.danger.withValues(alpha: 0.16)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6);
      for (final side in [-1.0, 1.0]) {
        canvas.drawOval(
          Rect.fromCenter(
            center: Offset(
              center.dx + side * radius * 0.52,
              center.dy + radius * 0.34,
            ),
            width: radius * 0.42,
            height: radius * 0.26,
          ),
          blush,
        );
      }
    }
  }

  // ── eyes ───────────────────────────────────────────────────────────────────

  void _eyes(
    Canvas canvas,
    Offset center,
    double radius,
    double fine,
    double s,
  ) {
    for (final eye in eyeGeometry(frame, center, radius)) {
      // A blink overrides every other openness channel, so it still reads while
      // the eyes are half-closed in a calm pose.
      final openness = (1 - frame.blink) * eye.openness;
      final rx = eye.rx;
      final ry = math.max(1.0, eye.ry * openness);
      final rect = Rect.fromCenter(
        center: eye.at,
        width: rx * 2,
        height: ry * 2,
      );
      canvas.drawOval(
        rect,
        Paint()..color = frame.colors.onAccent.withValues(alpha: 0.94),
      );
      canvas.drawOval(
        rect,
        _stroke(fine, frame.colors.accent.withValues(alpha: 0.35)),
      );

      // Pupils hide inside a nearly shut lid rather than clipping to a sliver.
      if (openness > 0.18) {
        _pupil(canvas, rect, eye, rx, ry, s);
      }
      if (eye.wide) {
        // Attentive bracket around the eye — the "listening" read, drawn with a
        // line so it survives small sizes.
        canvas.drawArc(
          Rect.fromCenter(center: eye.at, width: rx * 2.5, height: ry * 2.6),
          0.35,
          math.pi - 0.7,
          false,
          _stroke(fine, frame.colors.accent.withValues(alpha: 0.5)),
        );
      }
    }
  }

  void _pupil(
    Canvas canvas,
    Rect rect,
    NovaAvatarEye eye,
    double rx,
    double ry,
    double s,
  ) {
    final pupilR = math.min(rx, ry) * 0.46;
    final at = eye.at + eye.look * (rx - pupilR * 0.85);
    canvas.save();
    canvas.clipPath(Path()..addOval(rect));
    canvas.drawCircle(at, pupilR, Paint()..color = frame.colors.fg);
    // Below ~34px the catchlight turns into a grey smudge, so it is skipped.
    if (s > 34) {
      canvas.drawCircle(
        at + Offset(-pupilR * 0.35, -pupilR * 0.4),
        pupilR * 0.32,
        Paint()..color = frame.colors.surface,
      );
    }
    canvas.restore();
  }

  // ── brows ──────────────────────────────────────────────────────────────────

  /// Five distinct brow shapes for the five stored emotions, overridden by the
  /// live state (a worried tilt on warning, a raised pair while thinking).
  void _brows(Canvas canvas, Offset center, double radius, double stroke) {
    final y = center.dy - radius * 0.45;
    final dx = radius * 0.30;
    final span = radius * 0.26;
    final paint = _stroke(
      stroke * 0.9,
      frame.colors.fg.withValues(alpha: 0.85),
    );
    // (inner height, outer height, inner-x nudge) — the entire difference
    // between the five stored emotions is these three numbers.
    final (inner, outer, innerX) = browShape(frame);

    for (final side in [-1.0, 1.0]) {
      // `curious` is deliberately asymmetric: one brow up, one brow down.
      final mirrored = frame.emotion == 'curious' && side < 0;
      final baseX = center.dx + side * dx;
      final start = Offset(
        baseX + side * (innerX * radius - span),
        y + radius * (mirrored ? outer : inner),
      );
      final end = Offset(
        baseX + side * span,
        y + radius * (mirrored ? inner : outer),
      );
      canvas.drawPath(
        Path()
          ..moveTo(start.dx, start.dy)
          ..quadraticBezierTo(
            (start.dx + end.dx) / 2,
            math.min(start.dy, end.dy) - radius * 0.09,
            end.dx,
            end.dy,
          ),
        paint,
      );
    }
  }

  // ── mouth ──────────────────────────────────────────────────────────────────

  void _mouth(Canvas canvas, Offset center, double radius, double stroke) {
    final y = center.dy + radius * 0.42;
    final paint = _stroke(stroke, frame.colors.fg.withValues(alpha: 0.9));
    final (halfWidth, halfHeight) = mouthOpening(frame, radius);

    // Open shapes are a filled capsule plus an outline, so they read at 40px
    // where a hairline outline alone would vanish. `speaking` is the procedural
    // envelope and `listening` the measured microphone amplitude; see the class
    // doc above for what those honestly are.
    if (halfHeight > radius * 0.06) {
      final rect = Rect.fromCenter(
        center: Offset(center.dx, y),
        width: halfWidth * 2,
        height: halfHeight * 2,
      );
      canvas.drawPath(
        _rounded(rect, halfHeight),
        Paint()..color = frame.colors.fg.withValues(alpha: 0.55),
      );
      canvas.drawPath(_rounded(rect, halfHeight), paint);
      return;
    }

    switch (frame.state) {
      case NovaAvatarFaceState.thinking:
        // Flat and small, pulled a touch to one side.
        canvas.drawLine(
          Offset(center.dx - radius * 0.13, y),
          Offset(center.dx + radius * 0.07, y + radius * 0.02),
          paint,
        );
      case NovaAvatarFaceState.warning:
        // A concerned mouth: shallow, slightly skewed downturn.
        canvas.drawPath(
          Path()
            ..moveTo(center.dx - radius * 0.24, y + radius * 0.03)
            ..quadraticBezierTo(
              center.dx,
              y - radius * 0.10,
              center.dx + radius * 0.24,
              y + radius * 0.05,
            ),
          paint,
        );
      case NovaAvatarFaceState.success:
        _smile(canvas, center.dx, y, radius * 0.34, radius * 0.20, paint);
      case NovaAvatarFaceState.idle:
        if (frame.isWarm) {
          _smile(canvas, center.dx, y, radius * 0.26, radius * 0.14, paint);
        } else if (frame.emotion == 'focused') {
          _line(canvas, center, y, radius * 0.18, paint);
        } else {
          _smile(canvas, center.dx, y, radius * 0.22, radius * 0.10, paint);
        }
      case NovaAvatarFaceState.listening:
      case NovaAvatarFaceState.recording:
      case NovaAvatarFaceState.offline:
      case NovaAvatarFaceState.speaking:
        // `speaking` never reaches here (its capsule is open), but the switch
        // stays exhaustive rather than relying on a silent default.
        // Small, closed, attentive. Any height these had came from
        // `mouthOpening`; a hairline capsule keeps them visible at 40px.
        final rect = Rect.fromCenter(
          center: Offset(center.dx, y),
          width: halfWidth * 2,
          height: math.max(halfHeight, stroke) * 2,
        );
        canvas.drawPath(_rounded(rect, stroke), paint);
    }
  }

  void _smile(
    Canvas canvas,
    double cx,
    double y,
    double halfWidth,
    double depth,
    Paint paint,
  ) {
    canvas.drawPath(
      Path()
        ..moveTo(cx - halfWidth, y - depth * 0.2)
        ..quadraticBezierTo(cx, y + depth, cx + halfWidth, y - depth * 0.2),
      paint,
    );
  }

  void _line(Canvas canvas, Offset center, double y, double half, Paint paint) {
    canvas.drawLine(
      Offset(center.dx - half, y),
      Offset(center.dx + half, y),
      paint,
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  Paint _stroke(double width, Color color) => Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = width
    ..strokeCap = StrokeCap.round
    ..color = color;

  Path _rounded(Rect rect, double radius) => Path()
    ..addRRect(
      RRect.fromRectAndRadius(rect, Radius.circular(math.max(1.0, radius))),
    );

  @override
  bool shouldRepaint(covariant NovaAvatarFacePainter old) =>
      old.frame != frame;
}
