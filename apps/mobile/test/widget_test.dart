import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/app/router.dart';
import 'package:nova_mobile/features/onboarding/offline_page.dart';
import 'package:nova_mobile/features/onboarding/onboarding_service.dart';

import 'helpers/test_harness.dart';

/// Verifies that the real app widget actually boots and routes.
///
/// The previous version of this file asserted that a bare "Nova" label rendered,
/// which is exactly the stub `main.dart` used to be. It passed while the app had no
/// routing, no auth wiring and no reachable services.
void main() {
  testWidgets('fresh install boots into onboarding, not a placeholder', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await tester.pumpWidget(testScope(deps, const NovaApp()));
    await tester.pumpAndSettle();

    expect(find.text('Meet NOVA'), findsOneWidget);
    expect(find.text('Get started'), findsOneWidget);
  });

  testWidgets('abandoned onboarding resumes at the saved step', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        'nova_onboarding_status': 'inProgress',
        'nova_onboarding_step': OnboardingStep.profileSetup.stepIndex,
      },
    );
    addTearDown(deps.dispose);

    await tester.pumpWidget(testScope(deps, const NovaApp()));
    await tester.pumpAndSettle();

    expect(find.text('About you'), findsOneWidget);
  });

  testWidgets('completed onboarding with no session routes to login', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
    );
    addTearDown(deps.dispose);

    await tester.pumpWidget(testScope(deps, const NovaApp()));
    await tester.pumpAndSettle();

    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
  });

  testWidgets('completed onboarding with a stored session routes to home', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
      secureStorage: <String, String>{
        'auth_token': jsonEncode(<String, dynamic>{
          'access_token': 'access-token',
          'refresh_token': 'refresh-token',
          'expires_at':
              DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
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

    // The persisted session being restored is proved by the user's name rendering
    // on the dashboard, and by the wake-word control that only the authenticated
    // screen exposes.
    //
    // NOTE: the redesigned dashboard (OpenDesign `home/home.html`) shows the name
    // as its own hero line beneath a separate greeting line ("Good morning"),
    // rather than the old single "Hi Alex" string.
    expect(find.text('Alex'), findsWidgets);
    expect(find.text('Wake word'), findsOneWidget);
    expect(find.text('Tap to talk'), findsOneWidget);
  });

  testWidgets('every authenticated route resolves, not just the tab roots', (tester) async {
    // Regression guard. The conversation-history route was first declared as a
    // go_router CHILD path of the form '../conversations'. go_router child paths
    // are sub-segments only, so the route silently never matched and the app
    // rendered "No screen matches /conversations" — a bug that only appeared when
    // the screen was actually opened on a device, not at analysis or test time.
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
      secureStorage: <String, String>{
        'auth_token': jsonEncode(<String, dynamic>{
          'access_token': 'access-token',
          'refresh_token': 'refresh-token',
          'expires_at':
              DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
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

    for (final route in <String>[
      '/conversations',
      '/tasks',
      '/memory',
      '/me',
      '/converse',
      // Added alongside the OpenDesign screens that were still unbuilt. Every
      // one of these is a route a user can reach from the UI.
      '/tasks/reminders',
      '/me/integrations',
      // Smart Notification Assistant (§5.21).
      '/me/notifications',
      // Daily briefing (§9.4).
      '/me/briefing',
      // Call-recording summaries (requirement 6c), a Me setting reachable from
      // the UI.
      '/me/call-recordings',
      // Device and system control (requirement 6a). This was previously left out
      // because the route never settled under `pumpAndSettle` - the avatar's
      // breathing animation is an infinite `repeat()`, so nothing on a screen that
      // renders it ever settles. That was the test being wrong, not the screen: the
      // assertion below only asks whether the route resolved, which does not require
      // waiting for an animation that is designed never to finish.
      '/me/device-control',
      // Wake word (requirement 2, §5.16/§13.10), a Me setting beside the others.
      // The screen names the classifier actually installed in the build.
      '/me/wake-word',
      // The two store-required surfaces. Both are hard submission gates:
      // App Review 5.1.1(i) / Play's User Data policy need the privacy policy
      // readable in-app, and App Review 5.1.1(v) / Play's account-deletion
      // requirement need an in-app deletion path. A route that silently failed to
      // match would leave the Profile rows pointing at "No screen matches", which is
      // exactly the failure this guard exists to catch.
      '/me/privacy-policy',
      '/me/delete-account',
      '/admin',
      '/translate',
      '/wakeword',
    ]) {
      // NovaApp sits ABOVE the router it created, so GoRouter.of() cannot find
      // it from that context; read it from the provider container instead.
      final container = ProviderScope.containerOf(
        tester.element(find.byType(NovaApp)),
      );
      container.read(routerProvider).go(route);
      // `pump` with a duration, not `pumpAndSettle`. The avatar breathes forever by
      // design, so a settle would block until timeout on any screen that shows it -
      // which is most of them. Pumping a few frames is enough for the router to
      // resolve and build, which is all this test asserts.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        find.textContaining('No screen matches'),
        findsNothing,
        reason: 'route $route did not resolve',
      );
    }
  });

  testWidgets('the Profile rows actually navigate to the store-required screens',
      (tester) async {
    // The test above proves the ROUTES resolve. This one proves the Profile rows
    // point at them, which is a different failure: the delete-account and
    // privacy-policy routes are children of `/me`, and the rows were first written
    // as `context.push('/delete-account')` — an absolute path that matches no route.
    // Every test still passed, and the app rendered go_router's "No screen matches
    // /delete-account" page when the row was tapped on a device. Only tapping it
    // catches that, so this test taps it.
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
      secureStorage: <String, String>{
        'auth_token': jsonEncode(<String, dynamic>{
          'access_token': 'access-token',
          'refresh_token': 'refresh-token',
          'expires_at':
              DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
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

    final container = ProviderScope.containerOf(tester.element(find.byType(NovaApp)));
    container.read(routerProvider).go('/me');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    for (final row in <String>['Privacy policy', 'Delete account']) {
      // The rows live below the fold on the Profile screen.
      await tester.scrollUntilVisible(find.text(row), 200);
      await tester.pump(const Duration(milliseconds: 200));

      await tester.tap(find.text(row));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      expect(
        find.textContaining('No screen matches'),
        findsNothing,
        reason: 'tapping "$row" landed on a route that does not exist',
      );

      // And it must land on the right screen, not merely somewhere valid.
      final expected = row == 'Privacy policy'
          ? 'Privacy Policy'
          : 'Delete account';
      expect(find.text(expected), findsWidgets,
          reason: '"$row" did not open its screen');

      // Back to Profile for the next row.
      container.read(routerProvider).go('/me');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }
  });

  testWidgets('losing connectivity opens the offline screen, and reconnecting leaves it',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
    );
    addTearDown(deps.dispose);

    await tester.pumpWidget(testScope(deps, const NovaApp()));
    await tester.pumpAndSettle();
    expect(find.byType(OfflinePage), findsNothing);

    // The connectivity stream is the signal the offline screen was built for.
    deps.networkInfo.setConnected(false);
    await tester.pumpAndSettle();
    expect(find.byType(OfflinePage), findsOneWidget);

    // Coming back routes through the normal gates rather than restoring a stale
    // location, so a signed-out user still lands on login.
    deps.networkInfo.setConnected(true);
    await tester.pumpAndSettle();
    expect(find.byType(OfflinePage), findsNothing);
    expect(find.text('Welcome back'), findsOneWidget);
  });

  testWidgets('the offline screen does not blame rate limiting for a lost connection',
      (tester) async {
    // This banner used to be a `const` widget with no inputs, so it rendered
    // "Rate-limited or maintenance mode. Retry later or contact support." on
    // every visit to this page — including the one it exists for. Observed on
    // the OnePlus 9R after a reboot with the API unreachable: the header said
    // "No connection" while the banner told the user to contact support about a
    // rate limit. Two contradictory diagnoses on one screen, and the wrong one
    // sends a user with no wifi to the wrong action.
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
    );
    addTearDown(deps.dispose);

    await tester.pumpWidget(testScope(deps, const NovaApp()));
    await tester.pumpAndSettle();

    deps.networkInfo.setConnected(false);
    await tester.pumpAndSettle();
    expect(find.byType(OfflinePage), findsOneWidget);

    // The real condition is a lost connection, and that is what it must say.
    expect(find.textContaining('Rate-limited or maintenance'), findsNothing,
        reason: 'a lost connection is not a rate limit');
    expect(find.textContaining('offline'), findsWidgets,
        reason: 'the user is offline and must be told so');

    // The rest of the screen was already right and must stay right.
    expect(find.text('No connection'), findsOneWidget);
    expect(find.textContaining('Your saved reminders still work'), findsOneWidget);
  });
}
