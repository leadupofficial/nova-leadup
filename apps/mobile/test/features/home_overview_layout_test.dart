import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/features/home/home_page.dart';
import 'package:nova_mobile/features/overlay/floating_overlay.dart';
import 'package:nova_mobile/features/overlay/summon_hint.dart';

import '../helpers/test_harness.dart';

/// The floating assistant's sentence must not be painted over the Home screen.
///
/// Measured on the physical OnePlus 9R (1080x2400, `adb exec-out screencap`):
/// *"NOVA never sees other apps' content. Tap avatar to summon."* was drawn
/// across the *Today's Overview* cards, which were themselves clipped by the
/// bottom edge of the viewport.
///
/// Cause: the sentence was a `Positioned(bottom: 8)` inside `FloatingOverlay`,
/// and `NovaShell` mounts that overlay **above** `navigationShell` in its stack.
/// It therefore painted last, over whatever the current screen's body ended with
/// — and a body is the screen's whole scroll viewport.
///
/// The discriminating measurement is the relation between the sentence and the
/// **scroll viewport**, not between the sentence and the cards. On a viewport
/// tall enough for Home's content the cards are far below the fold and cannot be
/// compared with anything visible, yet the defect is still there: the overlay's
/// `bottom: 8` put the sentence 23px *inside* the viewport, in a band the screen
/// paints into. That is the layout error, and it is height-dependent — which is
/// exactly why it reproduced on the device and not on one fixed test surface.
void main() {
  /// The real app, signed in and on Home, over a network stub that answers every
  /// list with an empty one. The real shell is required: it is what mounts both
  /// the sentence and the screen.
  Future<void> pumpSignedInHome(
    WidgetTester tester, {
    required double height,
  }) async {
    tester.view.physicalSize = Size(1080, height);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
      secureStorage: <String, String>{
        'auth_token': jsonEncode(<String, dynamic>{
          'access_token': 'access-token',
          'refresh_token': 'refresh-token',
          'expires_at': DateTime.now()
              .add(const Duration(hours: 1))
              .toIso8601String(),
        }),
        'auth_user': jsonEncode(<String, dynamic>{
          'id': 'user-1',
          'email': 'alex@example.com',
          'name': 'Alex',
        }),
      },
    );
    addTearDown(deps.dispose);

    await tester.pumpWidget(
      testScope(deps, const NovaApp(), networkService: emptyApiNetworkService()),
    );
    await tester.pumpAndSettle();
  }

  /// The sentence, found by its text as well as by its key.
  ///
  /// The key is what the fixed build carries. The text fallback is what lets
  /// these tests run against the *broken* build and fail on the geometry rather
  /// than on a missing key — otherwise "before" and "after" would prove only that
  /// a key was added.
  Finder hintFinder() {
    final byKey = find.byKey(SummonHint.hintKey);
    if (byKey.evaluate().isNotEmpty) return byKey;
    return find.byWidgetPredicate(
      (widget) =>
          widget is Text &&
          (widget.data ?? '').contains('NOVA never sees other apps'),
    );
  }

  /// The screen's scrolling viewport, in global coordinates.
  Rect scrollViewport(WidgetTester tester) {
    final box =
        find.byType(Scrollable).first.evaluate().single.renderObject
            as RenderBox;
    return box.localToGlobal(Offset.zero) & box.size;
  }

  testWidgets('the hint is no longer painted inside the floating overlay', (
    tester,
  ) async {
    // The structural cause: the overlay is mounted above the body, so anything it
    // paints lands on the screen beneath it.
    await pumpSignedInHome(tester, height: 1600);

    expect(hintFinder(), findsOneWidget);
    expect(
      find.descendant(of: find.byType(FloatingOverlay), matching: hintFinder()),
      findsNothing,
      reason:
          'the sentence is layout chrome now; painting it from the overlay is '
          'what put it on top of the overview cards',
    );
  });

  // Three realistic phone heights. The 800x600 default test surface does not
  // reproduce this defect at all — the sentence and the viewport have to be
  // compared where Home's content is taller than the screen.
  for (final height in <double>[1600, 1800, 2000]) {
    testWidgets(
      'the sentence is never inside the scroll viewport (${height.toInt()}px)',
      (tester) async {
        await pumpSignedInHome(tester, height: height);

        final viewport = scrollViewport(tester);
        final hint = tester.getRect(hintFinder());

        expect(
          hint.top,
          greaterThanOrEqualTo(viewport.bottom),
          reason:
              'the sentence sits in a band the screen paints into, so the '
              'overview cards scroll underneath it; '
              'viewport=$viewport hint=$hint',
        );
      },
    );

    testWidgets(
      'the sentence does not overlap the overview row (${height.toInt()}px)',
      (tester) async {
        await pumpSignedInHome(tester, height: height);

        final hint = tester.getRect(hintFinder());
        final overview = tester.getRect(find.byKey(HomePage.overviewRowKey));

        expect(find.byKey(HomePage.overviewRowKey), findsOneWidget);
        expect(
          hint.overlaps(overview),
          isFalse,
          reason: 'hint=$hint overview=$overview',
        );
      },
    );
  }

  testWidgets('the hint follows the overview row that is on screen', (
    tester,
  ) async {
    // "They do not overlap" is also satisfied by the sentence sliding up over the
    // content that *is* visible, so the ordering is pinned too.
    //
    // Only at a viewport tall enough to hold Home: on a short one the overview
    // row is below the fold, so its painted rectangle is *under* the sentence for
    // the honest reason that it has not been scrolled to yet. Asserting otherwise
    // there would demand the scroll view lie about where its content is.
    await pumpSignedInHome(tester, height: 2600);

    final hintTop = tester.getTopLeft(hintFinder()).dy;
    final overviewBottom = tester
        .getBottomLeft(find.byKey(HomePage.overviewRowKey))
        .dy;

    expect(
      overviewBottom,
      lessThan(hintTop),
      reason: 'the overview is on screen above the sentence',
    );
    expect(
      hintTop,
      greaterThanOrEqualTo(scrollViewport(tester).bottom),
      reason: 'the sentence is footer chrome and must follow the body',
    );
  });

  testWidgets('the overview row still scrolls with the screen', (tester) async {
    // The screenshot also showed the cards cut off at the viewport's bottom edge.
    // Being inside the scrollable area is what makes them reachable, and is a
    // different failure from the overlap — so the fix must not have achieved
    // separation by pinning them somewhere else.
    await pumpSignedInHome(tester, height: 1600);

    expect(
      find.ancestor(
        of: find.byKey(HomePage.overviewRowKey),
        matching: find.byType(Scrollable),
      ),
      findsWidgets,
      reason: 'the cards must scroll with the screen they belong to',
    );
  });
}
