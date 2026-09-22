import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/design/widgets/index.dart';

/// An idle screen must settle.
///
/// The defect this pins: every continuous animation in the app was a
/// `repeat()`ing [AnimationController] guarded only by
/// `MediaQuery.disableAnimations`, so it started at mount and never stopped.
/// A running controller asks the engine for a frame every vsync, and each of
/// those frames repainted the whole screen. Measured on the OnePlus 9R, an
/// otherwise idle Home screen presented **61 fps and burned ~113 % of one
/// core** — with the wake word switched off. The shell mounts the assistant orb
/// (and so the rig) on every tab, which is why Tasks, Memory and Me each cost
/// about the same.
///
/// Reducing the wake word to "not listening" did not stop it either: the loops
/// were never tied to whether anything was actually happening. Against the
/// unfixed widgets these two idle assertions fail with
/// `transientCallbackCount` 1 (the rig's five-minute timeline) and 2 (the hero
/// card's aura *and* its rig) — one ticker per continuous animation.
///
/// Both directions are asserted, and both matter: with no frame budget an idle
/// face parks its timeline and stops scheduling frames at all, and with one it
/// animates. The fix parks idle content rather than disabling the animation
/// everywhere.
///
/// Animations are deliberately **on** (`disableAnimations: false`). The rest of
/// the suite runs under reduced motion, where every one of these guards already
/// short-circuits and this bug is invisible; that is exactly why it survived.
Widget _host(Widget child) {
  return ProviderScope(
    child: MaterialApp(
      theme: NovaTheme.dark(),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: false),
          child: Scaffold(body: Center(child: child)),
        ),
      ),
    ),
  );
}

void main() {
  group('an idle listening screen settles', () {
    testWidgets('the rig parks its timeline and stops scheduling frames', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const NovaAvatarFace(
            state: NovaAvatarFaceState.listening,
            // Supplied so the face never reaches for the real recorder: this
            // test is about frames, not audio.
            micLevels: Stream<double>.empty(),
          ),
        ),
      );
      await tester.pump();

      // Nothing is live, so no ticker may be registered at all.
      expect(tester.binding.transientCallbackCount, 0);

      // The screen has now been "looked at" for three seconds. Before the fix
      // the rig re-requested a frame on every one of them.
      await tester.pump(const Duration(seconds: 3));
      expect(
        tester.binding.transientCallbackCount,
        0,
        reason: 'an idle listening face must not hold a ticker open',
      );
      expect(
        tester.binding.hasScheduledFrame,
        isFalse,
        reason: 'an idle screen must stop scheduling frames',
      );
    });

    testWidgets('the same face still animates while it is live', (tester) async {
      await tester.pumpWidget(
        _host(
          const NovaAvatarFace(
            state: NovaAvatarFaceState.listening,
            micLevels: Stream<double>.empty(),
            animate: true,
          ),
        ),
      );
      await tester.pump();

      expect(
        tester.binding.transientCallbackCount,
        greaterThan(0),
        reason: 'a face with a frame budget must keep animating',
      );
      expect(tester.binding.hasScheduledFrame, isTrue);
    });

    testWidgets('the hero card parks its breathing aura as well', (
      tester,
    ) async {
      // This is what Home renders while the wake word is merely armed: the
      // expression says "listening", but there is no turn and so no motion.
      await tester.pumpWidget(
        _host(
          const NovaAvatarHeroCard(
            state: NovaAvatarFaceState.listening,
            statusLabel: 'Listening for "Hey Nova"',
          ),
        ),
      );
      await tester.pump();

      await tester.pump(const Duration(seconds: 3));
      expect(
        tester.binding.transientCallbackCount,
        0,
        reason: 'the aura and the rig must both be parked',
      );
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('a live turn still animates the hero card', (tester) async {
      await tester.pumpWidget(
        _host(
          const NovaAvatarHeroCard(
            state: NovaAvatarFaceState.speaking,
            statusLabel: 'Speaking',
            animate: true,
          ),
        ),
      );
      await tester.pump();

      expect(tester.binding.transientCallbackCount, greaterThan(0));
    });
  });
}
