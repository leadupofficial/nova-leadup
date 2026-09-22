import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/features/auth/auth_api.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';
import 'package:nova_mobile/features/auth/auth_controller.dart';
import 'package:nova_mobile/features/onboarding/pending_persona_flush.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

import '../helpers/test_harness.dart';

/// The deferred companion must be pushed **when the user signs in**.
///
/// ## What went wrong, twice
///
/// `CompanionPage` runs before sign-in, so its `PUT /settings/persona` always failed and
/// the choice was kept under `savePendingPersona`. First fix attempt: a notifier that
/// watches the auth state and flushes on the first authenticated frame — wired in
/// `NovaApp.initState` as `ref.read(pendingPersonaFlushProvider.notifier)`.
///
/// That does not work. `ref.read` constructs the notifier and returns; it creates **no
/// subscription**, and in Riverpod an element with no listeners is not eagerly rebuilt
/// when a dependency changes. So `build()` ran once, in whatever auth state existed at
/// startup, and never again: the persona was pushed on the *next cold start* that began
/// authenticated, not at sign-in. The same mistake meant reminders already armed were not
/// cancelled when the user switched delivery off, and a persona left pending across a
/// sign-out could be written to whoever signed in next.
///
/// The tests that existed called `flush()` directly, so they exercised the flush and never
/// the wiring — a green suite over a broken feature. These tests drive the auth transition
/// itself, which is the only thing that would have caught it.
void main() {
  const personaJson = <String, dynamic>{
    'name': 'Ada',
    'personality': 'friendly',
    'languagePolicy': 'ta',
    'voiceSpeed': 1.0,
  };

  Future<ProviderContainer> containerWith(
    TestDependencies deps,
    FakeHttpAdapter adapter,
    AuthApi authApi,
  ) async {
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(deps.preferences),
        authRepositoryProvider.overrideWithValue(deps.authRepository),
        onboardingServiceProvider.overrideWithValue(deps.onboardingService),
        wakeWordPlatformProvider.overrideWithValue(deps.wakeWordPlatform),
        crashReportingServiceProvider.overrideWithValue(deps.crashReporting),
        analyticsServiceProvider.overrideWithValue(deps.analytics),
        networkInfoServiceProvider.overrideWithValue(deps.networkInfo),
        healthServiceProvider.overrideWithValue(deps.healthService),
        reminderNotificationsProvider.overrideWithValue(deps.reminderNotifications),
        networkServiceProvider.overrideWithValue(fakeNetworkService(adapter)),
        authApiProvider.overrideWithValue(authApi),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  Future<TestDependencies> signedOutWithPendingPersona() => createTestDependencies(
        preferences: <String, Object>{
          'nova_onboarding_persona': jsonEncode(personaJson),
        },
      );

  /// An `AuthApi` that signs in successfully without touching the network.
  ///
  /// `AuthController.login` calls `authApiProvider`, not the shared HTTP client, so
  /// overriding the adapter alone leaves the sign-in failing and every assertion below
  /// passing for the wrong reason — the flush is never *supposed* to run while signed out.
  AuthApi succeedingAuthApi(FakeHttpAdapter adapter) =>
      _SucceedingAuthApi(fakeNetworkService(adapter));

  /// Records every request the app makes, so "was the persona pushed" is answered by the
  /// wire rather than by internal state.
  ({FakeHttpAdapter adapter, List<String> paths}) recordingAdapter() {
    final paths = <String>[];
    final adapter = FakeHttpAdapter((options) async {
      paths.add('${options.method} ${options.path}');
      // The login response has to satisfy the auth layer, or the transition never
      // happens and the test would pass for the wrong reason.
      if (options.path.contains('/auth/login')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': {
            'access_token': 'access-token',
            'refresh_token': 'refresh-token',
            'expires_in': 900,
            'user': {'id': 'user-1', 'email': 'ada@example.com', 'name': 'Ada'},
          },
        });
      }
      return jsonResponse(<String, dynamic>{'success': true});
    });
    return (adapter: adapter, paths: paths);
  }

  /// Polls until [predicate] holds, or gives up. Returns whether it held.
  Future<bool> waitFor(
    bool Function() predicate, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      if (predicate()) return true;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    return predicate();
  }

  test('a subscriber makes the flush run at sign-in, without a restart', () async {
    final deps = await signedOutWithPendingPersona();
    addTearDown(deps.dispose);
    final recorder = recordingAdapter();
    final container = await containerWith(deps, recorder.adapter, succeedingAuthApi(recorder.adapter));

    // Exactly what `NovaApp.initState` does now.
    container.listen(pendingPersonaFlushProvider, (_, _) {});

    final signedIn = await container
        .read(authStateProvider.notifier)
        .login(email: 'ada@example.com', password: 'correct-horse-battery');
    expect(signedIn, isTrue, reason: 'the harness sign-in must actually succeed');

    // Waits for the **outcome**, not the request. The flush is scheduled from `build` as
    // a microtask, then puts, then clears the stored copy; polling for the request alone
    // returned while the clear was still in flight, which read as "the persona is pushed
    // twice on the next launch" when nothing was wrong. A test that fails because it
    // stopped waiting too early looks exactly like the bug it is meant to catch.
    await waitFor(() => deps.onboardingService.getPendingPersona() == null);

    expect(
      recorder.paths.any((p) => p.contains('persona')),
      isTrue,
      reason: 'the companion chosen before sign-in must be pushed at sign-in',
    );
    expect(
      deps.onboardingService.getPendingPersona(),
      isNull,
      reason: 'and consumed, so it is not pushed again on the next launch',
    );
  });

  test('without a subscriber the auth change is invisible, which is the old bug',
      () async {
    // This is the regression itself, pinned as a test. `ref.read` builds the notifier but
    // subscribes to nothing, and an unlistened element is not rebuilt on a dependency
    // change — so the flush never fires. If this test ever starts failing because riverpod
    // changed that behaviour, the `listenManual` calls in `app.dart` are no longer load
    // bearing and this comment should be removed with them.
    final deps = await signedOutWithPendingPersona();
    addTearDown(deps.dispose);
    final recorder = recordingAdapter();
    final container = await containerWith(deps, recorder.adapter, succeedingAuthApi(recorder.adapter));

    // Deliberately the old wiring.
    container.read(pendingPersonaFlushProvider.notifier);

    final signedIn = await container
        .read(authStateProvider.notifier)
        .login(email: 'ada@example.com', password: 'correct-horse-battery');
    expect(signedIn, isTrue);

    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(
      recorder.paths.any((p) => p.contains('persona')),
      isFalse,
      reason: 'an unlistened notifier does not see the auth transition — this is the bug '
          'the listenManual calls in app.dart fix',
    );
  });
}

/// The minimum `AuthApi` surface these tests need: a login that always succeeds.
class _SucceedingAuthApi extends AuthApi {
  /// The superclass wants a `NetworkService`, which the harness builds around the same
  /// recording adapter. Nothing reaches it, because [login] is overridden.
  _SucceedingAuthApi(super.network);

  @override
  Future<AuthSession> login({required String email, required String password}) async {
    return AuthSession(
      token: AuthToken(
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: DateTime.now().add(const Duration(minutes: 15)),
      ),
      user: const AuthUser(id: 'user-1', email: 'ada@example.com', name: 'Ada'),
    );
  }
}

