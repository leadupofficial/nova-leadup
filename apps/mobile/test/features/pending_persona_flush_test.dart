import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/features/onboarding/pending_persona_flush.dart';

import '../helpers/test_harness.dart';

/// The companion configured during onboarding must survive until sign-in.
///
/// `PUT /api/v1/settings/persona` is authenticated and onboarding runs **before**
/// sign-in, so on a fresh install the save in `CompanionPage` always failed. The screen
/// kept the choice under `savePendingPersona` and told the user "the choice is stored and
/// will be pushed after sign-in" — and then cleared it on the very next line,
/// unconditionally. Nothing re-pushed it because there was nothing left, so the name,
/// personality and speech style the user had just chosen reverted to the defaults, and
/// the copy promising otherwise was untrue.
///
/// These tests pin both halves of the fix: the pending copy is kept when the push fails,
/// and the flush that runs on the first authenticated frame consumes it exactly once.
void main() {
  const personaJson = <String, dynamic>{
    'name': 'Ada',
    'personality': 'friendly',
    'languagePolicy': 'ta',
    'voiceSpeed': 1.0,
  };

  /// A container with the real providers and a scriptable transport.
  Future<ProviderContainer> containerWith(
    TestDependencies deps,
    FakeHttpAdapter adapter,
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
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('keeps the companion when the push fails, and does not discard it', () async {
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        'nova_onboarding_persona': jsonEncode(personaJson),
      },
    );
    addTearDown(deps.dispose);

    // No stored session, so `flush` must decline to send anything at all.
    final container = await containerWith(
      deps,
      FakeHttpAdapter((_) async => jsonResponse(<String, dynamic>{'success': true})),
    );

    final sent = await container.read(pendingPersonaFlushProvider.notifier).flush();

    expect(sent, isFalse, reason: 'nothing may be pushed before there is a session');
    expect(
      deps.onboardingService.getPendingPersona(),
      isNotNull,
      reason: 'the companion must still be there for the next authenticated launch',
    );
  });

  test('the pending copy survives an unauthenticated launch', () async {
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        'nova_onboarding_persona': jsonEncode(personaJson),
      },
    );
    addTearDown(deps.dispose);

    final container = await containerWith(
      deps,
      FakeHttpAdapter((_) async => jsonResponse(<String, dynamic>{'success': true})),
    );
    // Building the notifier is what `NovaApp` does; with no session it must not throw
    // and must not clear anything.
    container.read(pendingPersonaFlushProvider.notifier);

    expect(deps.onboardingService.getPendingPersona(), isNotNull);
  });

  test('a stored companion is only ever pushed once', () async {
    // The bound on exposure: the pending value has no recorded owner, so it is written
    // to whoever signs in first, and then removed. A second flush must be a no-op.
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        'nova_onboarding_persona': jsonEncode(personaJson),
      },
    );
    addTearDown(deps.dispose);

    final calls = <RequestOptions>[];
    final container = await containerWith(
      deps,
      FakeHttpAdapter((options) async {
        calls.add(options);
        return jsonResponse(<String, dynamic>{'success': true, 'data': <String, dynamic>{}});
      }),
    );

    // No session, so the first flush is a no-op and the value stays.
    await container.read(pendingPersonaFlushProvider.notifier).flush();
    expect(deps.onboardingService.getPendingPersona(), isNotNull);
    expect(calls, isEmpty, reason: 'no request may leave without a session');
  });

  /// The session shape `widget_test.dart` uses to reach an authenticated route.
  Map<String, String> signedIn() => <String, String>{
        'auth_token': jsonEncode(<String, dynamic>{
          'access_token': 'access-token',
          'refresh_token': 'refresh-token',
          'expires_at': DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
        }),
        'auth_user': jsonEncode(<String, dynamic>{
          'id': 'user-1',
          'email': 'alex@example.com',
          'name': 'Alex',
        }),
      };

  test('pushes the companion on the first authenticated frame, then clears it', () async {
    // The behaviour the screen's own copy promises. Before the fix this push never
    // happened: `clearPendingPersona()` ran unconditionally on the line after a
    // pre-sign-in failure, so by the time a session existed there was nothing to send.
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_persona': jsonEncode(personaJson)},
      secureStorage: signedIn(),
    );
    addTearDown(deps.dispose);

    final calls = <RequestOptions>[];
    final container = await containerWith(
      deps,
      FakeHttpAdapter((options) async {
        calls.add(options);
        return jsonResponse(<String, dynamic>{'success': true, 'data': <String, dynamic>{}});
      }),
    );

    final sent = await container.read(pendingPersonaFlushProvider.notifier).flush();

    expect(sent, isTrue, reason: 'the companion must reach the server once signed in');
    expect(calls, hasLength(1));
    expect(calls.single.method, 'PUT');
    expect(calls.single.path, contains('/settings/persona'));
    expect((calls.single.data as Map<String, dynamic>)['name'], 'Ada');

    expect(
      deps.onboardingService.getPendingPersona(),
      isNull,
      reason: 'a pushed companion must not be pushed again on the next launch',
    );

    // A second flush is a no-op.
    expect(await container.read(pendingPersonaFlushProvider.notifier).flush(), isFalse);
    expect(calls, hasLength(1));
  });

  test('keeps the companion when the server rejects it', () async {
    // The failure this guards: clearing before the push succeeded is exactly how the
    // companion was lost. A rejected push must leave the stored copy intact so the next
    // launch retries.
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_persona': jsonEncode(personaJson)},
      secureStorage: signedIn(),
    );
    addTearDown(deps.dispose);

    final container = await containerWith(
      deps,
      FakeHttpAdapter((_) async => jsonResponse(
            <String, dynamic>{'success': false, 'message': 'nope'},
            statusCode: 500,
          )),
    );

    final sent = await container.read(pendingPersonaFlushProvider.notifier).flush();

    expect(sent, isFalse);
    expect(
      deps.onboardingService.getPendingPersona(),
      isNotNull,
      reason: 'a failed push must not consume the stored companion',
    );
  });

  test('the stored companion is what the greeting reads its language from', () async {
    // `getLanguagePolicy` falls back to the pending companion, so keeping the value
    // until sign-in is also what makes the first greeting come out in the right
    // language rather than defaulting to `auto`.
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        'nova_onboarding_persona': jsonEncode(personaJson),
      },
    );
    addTearDown(deps.dispose);

    expect(deps.onboardingService.getLanguagePolicy(), 'ta');
  });
}
