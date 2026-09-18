import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/app/router.dart';
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
      '/admin',
      '/translate',
      '/wakeword',
    ]) {
      // NovaApp sits ABOVE the router it creates, so GoRouter.of() cannot find
      // it from that context; read it from the provider container instead.
      final container = ProviderScope.containerOf(
        tester.element(find.byType(NovaApp)),
      );
      container.read(routerProvider).go(route);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('No screen matches'),
        findsNothing,
        reason: 'route $route did not resolve',
      );
    }
  });
}
