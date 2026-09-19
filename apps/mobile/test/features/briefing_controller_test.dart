import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/voice/device_tts.dart';
import 'package:nova_mobile/features/briefing/briefing_controller.dart';
import 'package:nova_mobile/features/briefing/briefing_models.dart';
import 'package:nova_mobile/features/briefing/briefing_reconciler.dart';
import 'package:nova_mobile/features/briefing/briefing_settings_store.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/services/analytics_service.dart';
import 'package:nova_mobile/services/network_service.dart';

import '../core/voice/voice_realtime_test_support.dart';
import '../helpers/test_harness.dart';

/// A restored session, so the controller's authenticated paths run.
Map<String, String> signedInStorage() => <String, String>{
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

const String groundedText =
    'Good morning. One task is overdue: Send the invoice.';

/// Answers `/briefing` with a well-formed payload and everything else emptily.
NetworkService briefingNetwork({
  String text = groundedText,
  String language = 'en',
}) {
  return fakeNetworkService(
    FakeHttpAdapter((options) async {
      if (options.path.contains('/briefing')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'text': text,
            'source': 'grounded',
            'language': language,
            'guardRejection': null,
            'generatedAt': DateTime.utc(2026, 9, 18, 2, 30).toIso8601String(),
            'counts': <String, int>{'overdue': 1},
            'capabilities': <String, bool>{
              'tasks': true,
              'reminders': true,
              'memories': true,
              'calendar': false,
              'weather': false,
              'eveningRecap': false,
              'locationNudges': false,
            },
          },
        });
      }
      return jsonResponse(<String, dynamic>{'success': true, 'data': null});
    }),
  );
}

ProviderContainer briefingContainer(
  TestDependencies deps, {
  required FakeDeviceTts tts,
  NetworkService? network,
}) {
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(deps.preferences),
      authRepositoryProvider.overrideWithValue(deps.authRepository),
      onboardingServiceProvider.overrideWithValue(deps.onboardingService),
      wakeWordPlatformProvider.overrideWithValue(deps.wakeWordPlatform),
      crashReportingServiceProvider.overrideWithValue(deps.crashReporting),
      analyticsServiceProvider.overrideWithValue(deps.analytics),
      networkInfoServiceProvider.overrideWithValue(deps.networkInfo),
      healthServiceProvider.overrideWithValue(deps.healthService),
      reminderNotificationsProvider.overrideWithValue(
        deps.reminderNotifications,
      ),
      deviceTtsProvider.overrideWithValue(tts),
      networkServiceProvider.overrideWithValue(network ?? briefingNetwork()),
      authNetworkServiceProvider.overrideWithValue(network ?? briefingNetwork()),
    ],
  );
}

void main() {
  test('a fresh install is off, schedules nothing and says nothing', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final tts = FakeDeviceTts();
    final container = briefingContainer(deps, tts: tts);
    addTearDown(container.dispose);

    final state = container.read(dailyBriefingProvider);

    expect(state.isEnabled, isFalse);
    expect(state.briefing, isNull);
    expect(
      deps.preferences.getBool(BriefingSettingsStore.enabledKey),
      isNull,
      reason: 'the opt-in must not be written until the user asks for it',
    );

    await pumpEventQueue();

    expect(deps.reminderNotifications.dailyCalls, isEmpty);
    expect(deps.reminderNotifications.permissionRequests, 0);
    expect(tts.spoken, isEmpty);
  });

  test('turning it on arms one daily alarm and persists the opt-in', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final tts = FakeDeviceTts();
    final container = briefingContainer(deps, tts: tts);
    addTearDown(container.dispose);

    container.read(dailyBriefingProvider);
    await container.read(dailyBriefingProvider.notifier).setEnabled(true);
    await pumpEventQueue();

    expect(deps.preferences.getBool(BriefingSettingsStore.enabledKey), isTrue);
    expect(deps.reminderNotifications.dailyCalls, hasLength(1));
    expect(deps.reminderNotifications.dailyCalls.single.hour, 8);
    expect(deps.reminderNotifications.dailyCalls.single.minute, 0);
    expect(
      deps.reminderNotifications.dailyCalls.single.id,
      BriefingReconciler.notificationId,
    );
    expect(container.read(dailyBriefingProvider).isEnabled, isTrue);
  });

  test('changing the time re-arms the same alarm, never a second one', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final container = briefingContainer(deps, tts: FakeDeviceTts());
    addTearDown(container.dispose);

    final notifier = container.read(dailyBriefingProvider.notifier);
    await notifier.setEnabled(true);
    await notifier.setTime(hour: 7, minute: 45);
    await pumpEventQueue();

    expect(deps.reminderNotifications.dailyCalls, hasLength(2));
    expect(deps.reminderNotifications.dailyCalls.last.hour, 7);
    expect(deps.reminderNotifications.dailyCalls.last.minute, 45);
    expect(deps.reminderNotifications.scheduled, hasLength(1));
    expect(deps.reminderNotifications.cancelled, isEmpty);
    expect(deps.preferences.getInt(BriefingSettingsStore.hourKey), 7);
    expect(deps.preferences.getInt(BriefingSettingsStore.minuteKey), 45);
  });

  test('turning it off drops the alarm', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final container = briefingContainer(deps, tts: FakeDeviceTts());
    addTearDown(container.dispose);

    final notifier = container.read(dailyBriefingProvider.notifier);
    await notifier.setEnabled(true);
    await notifier.setEnabled(false);
    await pumpEventQueue();

    expect(deps.preferences.getBool(BriefingSettingsStore.enabledKey), isFalse);
    expect(deps.reminderNotifications.scheduled, isEmpty);
    expect(
      deps.reminderNotifications.cancelled,
      contains(BriefingReconciler.notificationId),
    );
  });

  test('scheduled speaking refuses to run while the opt-in is off', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final tts = FakeDeviceTts();
    final container = briefingContainer(deps, tts: tts);
    addTearDown(container.dispose);

    final outcome = await container
        .read(dailyBriefingProvider.notifier)
        .fetchAndSpeak();

    expect(outcome, BriefingSpeechOutcome.notOptedIn);
    expect(tts.spoken, isEmpty);
  });

  test('a preview fetches and speaks the server text verbatim', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final tts = FakeDeviceTts();
    final container = briefingContainer(deps, tts: tts);
    addTearDown(container.dispose);

    final outcome = await container
        .read(dailyBriefingProvider.notifier)
        .preview();

    expect(outcome, BriefingSpeechOutcome.spoken);
    expect(tts.spoken.single, groundedText);
    final briefing = container.read(dailyBriefingProvider).briefing!;
    expect(briefing.isEmpty, isFalse);
    expect(
      briefing.hasSource('calendar'),
      isFalse,
      reason: 'the server reports no calendar, and the UI must be able to say so',
    );
  });

  test('an identical-script history is read with the device default voice', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final tts = FakeDeviceTts();
    final container = briefingContainer(deps, tts: tts);
    addTearDown(container.dispose);

    await container.read(dailyBriefingProvider.notifier).preview();

    // The default language policy is `auto`; an English briefing resolves to no
    // fixed tag, which means "the device default voice".
    expect(tts.spokenLanguages.single, isNull);
  });

  test('says so in the UI when the device has no voice for the language', () async {
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final tts = FakeDeviceTts(unsupported: <String>{'ta-IN'});
    final container = briefingContainer(
      deps,
      tts: tts,
      network: briefingNetwork(
        text: 'காலை வணக்கம். ஒரு பணி தாமதமாகிவிட்டது.',
        language: 'ta',
      ),
    );
    addTearDown(container.dispose);

    final outcome = await container
        .read(dailyBriefingProvider.notifier)
        .preview();

    expect(outcome, BriefingSpeechOutcome.noVoice);
    expect(tts.spoken, isEmpty, reason: 'never read Tamil with an English engine');
    final state = container.read(dailyBriefingProvider);
    expect(state.voiceNotice, contains('ta-IN'));
    expect(
      state.briefing?.text,
      isNotNull,
      reason: 'the text is still shown, so the user is not left with nothing',
    );
  });

  test('probeVoice reports a missing voice before the time arrives', () async {
    final deps = await createTestDependencies(
      secureStorage: signedInStorage(),
      preferences: <String, Object>{
        'nova_onboarding_language_policy': 'ta',
      },
    );
    addTearDown(deps.dispose);
    final tts = FakeDeviceTts(unsupported: <String>{'ta-IN'});
    final container = briefingContainer(deps, tts: tts);
    addTearDown(container.dispose);

    await container.read(dailyBriefingProvider.notifier).probeVoice();

    expect(
      container.read(dailyBriefingProvider).voiceNotice,
      contains('ta-IN'),
    );
  });

  test('probeVoice stays quiet when the voice exists', () async {
    final deps = await createTestDependencies(
      secureStorage: signedInStorage(),
      preferences: <String, Object>{
        'nova_onboarding_language_policy': 'ta',
      },
    );
    addTearDown(deps.dispose);
    final container = briefingContainer(deps, tts: FakeDeviceTts());
    addTearDown(container.dispose);

    await container.read(dailyBriefingProvider.notifier).probeVoice();

    expect(container.read(dailyBriefingProvider).voiceNotice, isNull);
  });

  test('an expired session reports a sign-in problem instead of a crash', () async {
    final deps = await createTestDependencies(
      secureStorage: <String, String>{},
    );
    addTearDown(deps.dispose);
    final container = briefingContainer(deps, tts: FakeDeviceTts());
    addTearDown(container.dispose);

    final outcome = await container
        .read(dailyBriefingProvider.notifier)
        .preview();

    expect(outcome, BriefingSpeechOutcome.failed);
    expect(container.read(dailyBriefingProvider).error, contains('Sign in'));
  });

  test('reports the two §22.1 counts an opt-in feature can be measured by', () async {
    // The opt-in is a device-local preference, so the server cannot see it and
    // the product metrics have to come from the client's own analytics.
    final deps = await createTestDependencies(secureStorage: signedInStorage());
    addTearDown(deps.dispose);
    final container = briefingContainer(deps, tts: FakeDeviceTts());
    addTearDown(container.dispose);

    final notifier = container.read(dailyBriefingProvider.notifier);
    await notifier.setEnabled(true);
    await notifier.preview();
    await notifier.setEnabled(false);

    expect(
      deps.analyticsBackend.events,
      contains(AnalyticsService.eventDailyBriefingEnabled),
    );
    expect(
      deps.analyticsBackend.events,
      contains(AnalyticsService.eventDailyBriefingSpoken),
    );
    expect(
      deps.analyticsBackend.parameters[AnalyticsService.eventDailyBriefingEnabled],
      <String, Object?>{'enabled': false},
      reason: 'the last toggle wins, so opt-in rate can be derived',
    );
  });
}
