import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/core/api/device_registration.dart';
import 'package:nova_mobile/features/auth/auth_controller.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';

import '../helpers/test_harness.dart';

/// The device is reported to the operator's inventory when a session exists.
///
/// The registration call was made once, from a post-frame callback, and it reads the access
/// token from secure storage. That read is asynchronous, so the first attempt could find no
/// token and return `reported: false, error: 'no session'` — correctly silent, because
/// registration is telemetry. The consequence was measured on an emulator: the device row
/// appeared only after the app had been backgrounded and resumed once, so a user who launched
/// NOVA and left it in the foreground was never counted at all.
///
/// The fix is an auth-state listener, and these tests pin it by **counting invocations**
/// rather than inspecting an HTTP adapter. That distinction matters: the call goes through
/// `deviceRegistrationProvider` into a `Dio` and then into `device_info_plus`, so a test that
/// depended on all three resolving would be testing the plugin rather than the wiring. A spy
/// on the provider observes exactly the thing that was missing.
void main() {
  const signedIn = <String, String>{
    'auth_token':
        '{"access_token":"a","refresh_token":"r","expires_at":"2099-01-01T00:00:00.000"}',
    'auth_user': '{"id":"user-1","email":"alex@example.com","name":"Alex"}',
  };

  /// Counts how many times the app asked for a registration.
  ({Future<DeviceRegistrationResult> Function() spy, List<int> calls}) spyOnRegistration() {
    final calls = <int>[];
    return (
      spy: () async {
        calls.add(calls.length);
        return const DeviceRegistrationResult(reported: false, error: 'test spy');
      },
      calls: calls,
    );
  }

  testWidgets('a restored session registers the device at launch, with no resume', (tester) async {
    useTallSurface(tester);
    final spy = spyOnRegistration();
    final deps = await createTestDependencies(secureStorage: signedIn);
    addTearDown(deps.dispose);

    await tester.pumpWidget(
      testScope(
        deps,
        const NovaApp(),
        networkService: emptyApiNetworkService(),
        deviceRegistration: spy.spy,
      ),
    );
    await tester.pumpAndSettle();

    // One call is the post-frame attempt, which runs unconditionally. The second is the auth
    // listener — the half that was missing, and the reason a launch with a restored session
    // now registers without needing a background/resume cycle first.
    expect(
      spy.calls.length,
      2,
      reason: 'a restored session must add a registration attempt on top of the post-frame one',
    );
  });

  testWidgets('a fresh install with no session makes only the post-frame attempt', (tester) async {
    // The endpoint is authenticated and a device row with no owner would not answer the
    // question the inventory exists for, so an unauthenticated launch must not add attempts —
    // and must not fail the launch either.
    useTallSurface(tester);
    final spy = spyOnRegistration();
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await tester.pumpWidget(
      testScope(
        deps,
        const NovaApp(),
        networkService: emptyApiNetworkService(),
        deviceRegistration: spy.spy,
      ),
    );
    await tester.pumpAndSettle();

    expect(spy.calls.length, 1, reason: 'only the unconditional post-frame attempt');
  });

  testWidgets('a session that arrives later registers the device too', (tester) async {
    // The other order the listener has to handle: the app starts signed out, so the
    // post-frame attempt finds no token, and the session appears afterwards. Without the
    // listener this device would not be reported until the next resume.
    useTallSurface(tester);
    final spy = spyOnRegistration();
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await tester.pumpWidget(
      testScope(
        deps,
        const NovaApp(),
        networkService: emptyApiNetworkService(),
        deviceRegistration: spy.spy,
      ),
    );
    await tester.pumpAndSettle();
    expect(spy.calls.length, 1);

    // What a successful sign-in leaves behind in the repository, followed by the rebuild the
    // app's own sign-in path triggers.
    await deps.authRepository.saveSession(
      AuthToken(
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      ),
      user: const AuthUser(id: 'user-1', email: 'alex@example.com', name: 'Alex'),
    );
    final container = ProviderScope.containerOf(tester.element(find.byType(NovaApp)));
    container.invalidate(authStateProvider);
    await tester.pumpAndSettle();

    expect(
      spy.calls.length,
      2,
      reason: 'the transition into an authenticated state must trigger a registration',
    );
  });
}
