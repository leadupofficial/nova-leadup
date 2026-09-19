import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/voice/device_tts.dart';
import 'package:nova_mobile/features/notifications/notification_controller.dart';
import 'package:nova_mobile/features/notifications/notification_models.dart';
import 'package:nova_mobile/features/notifications/notification_platform.dart';
import 'package:nova_mobile/features/notifications/notification_settings_store.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

import '../core/voice/voice_realtime_test_support.dart';
import '../helpers/fake_notification_platform.dart';
import '../helpers/test_harness.dart';

/// A container with every dependency the notification assistant touches
/// overridden, including the two — the platform and the device voice — that the
/// shared harness deliberately leaves alone.
ProviderContainer notificationContainer(
  TestDependencies deps, {
  required FakeNotificationAssistantPlatform platform,
  required FakeDeviceTts tts,
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
      notificationAssistantPlatformProvider.overrideWithValue(platform),
      deviceTtsProvider.overrideWithValue(tts),
    ],
  );
}

CapturedNotification slack({
  String title = 'Design review',
  String body = 'Moved to 15:00 in Room 4.',
}) {
  return CapturedNotification(
    packageName: 'com.Slack',
    appLabel: 'Slack',
    title: title,
    body: body,
    importance: 4,
    category: 'msg',
    postedAt: DateTime.utc(2026, 1, 1, 9),
  );
}

/// Preferences with the assistant on and Slack allowed.
Map<String, Object> enabledPrefs({bool readAloud = false}) => <String, Object>{
  NotificationSettingsStore.enabledKey: true,
  NotificationSettingsStore.allowedPackagesKey: <String>['com.Slack'],
  NotificationSettingsStore.readAloudKey: readAloud,
};

void main() {
  test('the master toggle off drops every notification', () async {
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        // Enabled deliberately left unset: a fresh install monitors nothing.
        NotificationSettingsStore.allowedPackagesKey: <String>['com.Slack'],
      },
    );
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    final tts = FakeDeviceTts();
    final container = notificationContainer(deps, platform: platform, tts: tts);
    addTearDown(container.dispose);
    addTearDown(platform.dispose);

    container.read(notificationAssistantProvider);
    await pumpEventQueue();

    platform.emitNotification(slack());
    await pumpEventQueue();

    expect(container.read(notificationAssistantProvider).inbox, isEmpty);
  });

  test('an allowed, high-priority work notification reaches the inbox', () async {
    final deps = await createTestDependencies(preferences: enabledPrefs());
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    final container = notificationContainer(
      deps,
      platform: platform,
      tts: FakeDeviceTts(),
    );
    addTearDown(container.dispose);
    addTearDown(platform.dispose);

    container.read(notificationAssistantProvider);
    await pumpEventQueue();

    platform.emitNotification(slack());
    await pumpEventQueue();

    final inbox = container.read(notificationAssistantProvider).inbox;
    expect(inbox, hasLength(1));
    expect(inbox.single.packageName, 'com.Slack');
    expect(inbox.single.body, 'Moved to 15:00 in Room 4.');
  });

  test('a sensitive notification from an allowed app never reaches the inbox',
      () async {
    final deps = await createTestDependencies(preferences: enabledPrefs());
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    final container = notificationContainer(
      deps,
      platform: platform,
      tts: FakeDeviceTts(),
    );
    addTearDown(container.dispose);
    addTearDown(platform.dispose);

    container.read(notificationAssistantProvider);
    await pumpEventQueue();

    platform.emitNotification(
      slack(title: 'Your verification code', body: 'Use 448210 to sign in.'),
    );
    await pumpEventQueue();

    expect(container.read(notificationAssistantProvider).inbox, isEmpty);
  });

  test('nothing about the notification is written to persistent storage',
      () async {
    // The "never store raw notification text" rule, checked against the real
    // SharedPreferences the app uses rather than against an intention.
    const title = 'Design review';
    const body = 'Moved to 15:00 in Room 4 — dial-in 4482.';
    final deps = await createTestDependencies(preferences: enabledPrefs());
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    final container = notificationContainer(
      deps,
      platform: platform,
      tts: FakeDeviceTts(),
    );
    addTearDown(container.dispose);
    addTearDown(platform.dispose);

    container.read(notificationAssistantProvider);
    await pumpEventQueue();
    platform.emitNotification(slack(title: title, body: body));
    platform.emitAppSeen('com.example.notes', 'Notes');
    await pumpEventQueue();

    expect(container.read(notificationAssistantProvider).inbox, hasLength(1));

    for (final key in deps.preferences.getKeys()) {
      final value = deps.preferences.get(key).toString();
      expect(
        value,
        isNot(contains(body)),
        reason: 'the notification body must never be persisted ($key)',
      );
      expect(
        value,
        isNot(contains(title)),
        reason: 'the notification title must never be persisted ($key)',
      );
      expect(value, isNot(contains('4482')));
    }
    // Only the five declared settings keys may exist for this feature.
    expect(
      deps.preferences.getKeys().where(
        (String key) => key.startsWith('nova_notification'),
      ),
      everyElement(isIn(NotificationSettingsStore.allKeys)),
    );
  });

  group('read-aloud', () {
    test('is refused while the opt-in is off', () async {
      final deps = await createTestDependencies(preferences: enabledPrefs());
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform();
      final tts = FakeDeviceTts();
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: tts,
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      container.read(notificationAssistantProvider);
      await pumpEventQueue();
      platform.emitNotification(slack());
      await pumpEventQueue();

      final data = container.read(notificationAssistantProvider).inbox.single;
      expect(
        await container.read(notificationAssistantProvider.notifier).speak(data),
        SpeakOutcome.notOptedIn,
      );
      expect(tts.spoken, isEmpty);
    });

    test('requires a confirmation for the session even when opted in',
        () async {
      final deps = await createTestDependencies(
        preferences: enabledPrefs(readAloud: true),
      );
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform();
      final tts = FakeDeviceTts();
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: tts,
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      final controller = container.read(notificationAssistantProvider.notifier);
      await pumpEventQueue();
      platform.emitNotification(slack());
      await pumpEventQueue();

      final data = container.read(notificationAssistantProvider).inbox.single;

      // Opted in, but this session has not confirmed: nothing is spoken.
      expect(await controller.speak(data), SpeakOutcome.confirmationRequired);
      expect(tts.spoken, isEmpty);
      expect(
        container.read(notificationAssistantProvider).sessionSpeechConsent,
        isFalse,
      );

      // With the confirmation, it is spoken exactly once.
      expect(
        await controller.speak(data, sessionConfirmed: true),
        SpeakOutcome.spoken,
      );
      expect(tts.spoken, hasLength(1));
      expect(
        tts.spoken.single,
        'Notification from Slack. Moved to 15:00 in Room 4.',
      );

      // The confirmation now covers the rest of the session.
      expect(await controller.speak(data), SpeakOutcome.spoken);
      expect(tts.spoken, hasLength(2));
    });

    test('refuses to speak content the guard flags, at the last moment',
        () async {
      // Defence in depth: even a value that somehow reached the inbox is
      // re-checked immediately before it would be spoken.
      final deps = await createTestDependencies(
        preferences: enabledPrefs(readAloud: true),
      );
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform();
      final tts = FakeDeviceTts();
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: tts,
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      final controller = container.read(notificationAssistantProvider.notifier);
      await pumpEventQueue();

      final smuggled = UntrustedNotificationData(
        packageName: 'com.Slack',
        appLabel: 'Slack',
        title: 'Gmail',
        body: 'Your OTP is 482913',
        postedAt: DateTime.utc(2026, 1, 1, 9),
      );

      expect(
        await controller.speak(smuggled, sessionConfirmed: true),
        SpeakOutcome.blockedByGuard,
      );
      expect(tts.spoken, isEmpty);
    });

    test('turning the assistant off revokes the session confirmation',
        () async {
      final deps = await createTestDependencies(
        preferences: enabledPrefs(readAloud: true),
      );
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform();
      final tts = FakeDeviceTts();
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: tts,
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      final controller = container.read(notificationAssistantProvider.notifier);
      await pumpEventQueue();
      platform.emitNotification(slack());
      await pumpEventQueue();
      final data = container.read(notificationAssistantProvider).inbox.single;
      await controller.speak(data, sessionConfirmed: true);
      expect(tts.spoken, hasLength(1));

      await controller.setEnabled(false);
      await pumpEventQueue();

      final state = container.read(notificationAssistantProvider);
      expect(state.isEnabled, isFalse);
      expect(state.readAloudEnabled, isFalse);
      expect(state.inbox, isEmpty);
      expect(state.sessionSpeechConsent, isFalse);
      // Even a fresh confirmation cannot speak while the assistant is off.
      expect(
        await controller.speak(data, sessionConfirmed: true),
        SpeakOutcome.notOptedIn,
      );
    });
  });

  group('settings', () {
    test('a blocked app cannot be added to the allowlist', () async {
      final deps = await createTestDependencies(preferences: enabledPrefs());
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform();
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: FakeDeviceTts(),
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      final controller = container.read(notificationAssistantProvider.notifier);
      await pumpEventQueue();

      expect(
        await controller.setPackageAllowed('com.phonepe.app', true),
        isFalse,
      );
      expect(
        container
            .read(notificationAssistantProvider)
            .settings
            .allowedPackages,
        isNot(contains('com.phonepe.app')),
      );
      expect(
        deps.preferences.getStringList(
          NotificationSettingsStore.allowedPackagesKey,
        ),
        isNot(contains('com.phonepe.app')),
      );
    });

    test('turning it on without Notification Access is refused', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform(accessGranted: false);
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: FakeDeviceTts(),
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      final controller = container.read(notificationAssistantProvider.notifier);
      await pumpEventQueue();

      expect(await controller.setEnabled(true), isFalse);
      final state = container.read(notificationAssistantProvider);
      expect(state.isEnabled, isFalse);
      expect(state.error, isNotNull);
    });

    test('revoked access turns a stored "on" back off', () async {
      final deps = await createTestDependencies(preferences: enabledPrefs());
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform(accessGranted: false);
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: FakeDeviceTts(),
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      container.read(notificationAssistantProvider);
      await pumpEventQueue();

      expect(container.read(notificationAssistantProvider).isEnabled, isFalse);
      expect(
        deps.preferences.getBool(NotificationSettingsStore.enabledKey),
        isFalse,
      );
    });

    test('a discovered app is remembered by package and label only', () async {
      final deps = await createTestDependencies(preferences: enabledPrefs());
      addTearDown(deps.dispose);
      final platform = FakeNotificationAssistantPlatform();
      final container = notificationContainer(
        deps,
        platform: platform,
        tts: FakeDeviceTts(),
      );
      addTearDown(container.dispose);
      addTearDown(platform.dispose);

      container.read(notificationAssistantProvider);
      await pumpEventQueue();

      platform.emitAppSeen('com.example.notes', 'Notes');
      platform.emitAppSeen('com.phonepe.app', 'PhonePe');
      await pumpEventQueue();

      final discovered =
          container.read(notificationAssistantProvider).discoveredApps;
      expect(
        discovered.map((DiscoveredApp app) => app.packageName),
        contains('com.example.notes'),
      );
      // A blocked app is never even offered as a candidate.
      expect(
        discovered.map((DiscoveredApp app) => app.packageName),
        isNot(contains('com.phonepe.app')),
      );
    });
  });

  group('Dart and Kotlin agree', () {
    // A Dart-only test cannot prove the Android service binds. It can prove the
    // two sides are wired to the same names, which is the failure mode that
    // actually bites: a renamed preference silently disables the native filter.
    late final String service = File(
      'android/app/src/main/java/com/leadup/nova/NovaNotificationListenerService.kt',
    ).readAsStringSync();

    test('the service reads the same preference keys', () {
      for (final key in NotificationSettingsStore.allKeys) {
        if (key == NotificationSettingsStore.summarizeHighPriorityKey ||
            key == NotificationSettingsStore.readAloudKey) {
          // Not needed natively: both are applied in Dart.
          continue;
        }
        expect(
          service,
          contains('flutter.$key'),
          reason: '$key must be read by the Kotlin listener as flutter.$key',
        );
      }
    });

    test('the shared_preferences file name matches', () {
      expect(service, contains('FlutterSharedPreferences'));
    });

    test('the channel names match the Dart platform', () {
      expect(
        service,
        contains(MethodChannelNotificationAssistantPlatform.methodChannelName),
      );
      expect(
        service,
        contains(MethodChannelNotificationAssistantPlatform.eventChannelName),
      );
    });

    test('the service never logs the notification text', () {
      // The one log line names a package. If a future edit adds `$title` or
      // `$body` to a log call, this fails.
      final logLines = service
          .split('\n')
          .where((String line) => line.contains('Log.'))
          .toList(growable: false);
      expect(logLines, isNotEmpty);
      for (final line in logLines) {
        expect(line, isNot(contains(r'$title')));
        expect(line, isNot(contains(r'$body')));
        expect(line, isNot(contains(r'$text')));
      }
    });
  });
}
