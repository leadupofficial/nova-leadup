import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/app.dart';
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

    await tester.pumpWidget(testScope(deps, const NovaApp()));
    await tester.pumpAndSettle();

    // The greeting proves the persisted session was restored and injected before the
    // first frame, rather than being loaded asynchronously afterwards.
    expect(find.text('Hi Alex'), findsOneWidget);
    expect(find.text('Wake word'), findsOneWidget);
  });
}
