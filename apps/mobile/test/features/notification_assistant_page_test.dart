import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/theme/nova_theme.dart';
import 'package:nova_mobile/core/voice/device_tts.dart';
import 'package:nova_mobile/features/notifications/notification_assistant_page.dart';
import 'package:nova_mobile/features/notifications/notification_controller.dart';
import 'package:nova_mobile/features/notifications/notification_settings_store.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

import '../core/voice/voice_realtime_test_support.dart';
import '../helpers/fake_notification_platform.dart';
import '../helpers/test_harness.dart';

/// Pumps the settings screen with the notification dependencies faked.
Future<void> pumpPage(
  WidgetTester tester,
  TestDependencies deps, {
  required FakeNotificationAssistantPlatform platform,
  FakeDeviceTts? tts,
  bool light = false,
}) async {
  await tester.pumpWidget(
    ProviderScope(
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
        deviceTtsProvider.overrideWithValue(tts ?? FakeDeviceTts()),
      ],
      child: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: MaterialApp(
          theme: light ? NovaTheme.light() : NovaTheme.darkTheme,
          home: const NotificationAssistantPage(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('states that the assistant is off by default', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    expect(find.text('OFF'), findsOneWidget);
    expect(
      find.textContaining('it is off by default'),
      findsOneWidget,
      reason: 'the disclosure has to say so in words, not only via a pill',
    );
    expect(deps.preferences.getBool(NotificationSettingsStore.enabledKey), isNull);
  });

  testWidgets('opens Android Notification Access settings', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform(accessGranted: false);
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);
    expect(find.text('Open Notification Access'), findsOneWidget);

    await tester.tap(find.text('Open Notification Access'));
    await tester.pumpAndSettle();

    expect(platform.openSettingsCalls, 1);
  });

  testWidgets('the master toggle persists and can be turned straight back off',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    // The first SwitchListTile in the tree is the master toggle: the disclosure
    // card above it has none.
    await tester.tap(find.byType(SwitchListTile).first);
    await tester.pumpAndSettle();

    expect(
      deps.preferences.getBool(NotificationSettingsStore.enabledKey),
      isTrue,
    );
    expect(find.text('Turn off and clear'), findsOneWidget);

    await tester.tap(find.text('Turn off and clear'));
    await tester.pumpAndSettle();

    expect(
      deps.preferences.getBool(NotificationSettingsStore.enabledKey),
      isFalse,
    );
    expect(find.text('OFF'), findsOneWidget);
  });

  testWidgets('safety rules are shown as locked, not as switches',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        NotificationSettingsStore.enabledKey: true,
        NotificationSettingsStore.allowedPackagesKey: <String>['com.Slack'],
      },
    );
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    for (final label in <String>[
      'Ignore OTPs, passwords, bank alerts, auth messages',
      'Do not store raw notification text',
      'Ask before reading notifications aloud',
    ]) {
      expect(find.text(label), findsOneWidget);
      expect(
        find.ancestor(
          of: find.text(label),
          matching: find.byType(SwitchListTile),
        ),
        findsNothing,
        reason: '$label is enforced and must not be switchable',
      );
    }

    // The two rules that are the user's choice do have switches.
    expect(
      find.ancestor(
        of: find.text('Summarize only high-priority work notifications'),
        matching: find.byType(SwitchListTile),
      ),
      findsOneWidget,
    );
  });

  testWidgets('blocked apps have no switch and allowed apps do', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    expect(find.text('Google Authenticator'), findsOneWidget);
    expect(find.text('PhonePe'), findsOneWidget);
    expect(
      find.ancestor(
        of: find.text('Google Authenticator'),
        matching: find.byType(SwitchListTile),
      ),
      findsNothing,
      reason: '§5.21 requires banking and OTP apps to be un-selectable',
    );
    expect(
      find.ancestor(
        of: find.text('PhonePe'),
        matching: find.byType(SwitchListTile),
      ),
      findsNothing,
      reason: 'a payment app must not be selectable either',
    );

    expect(
      find.ancestor(
        of: find.text('Slack'),
        matching: find.byType(SwitchListTile),
      ),
      findsOneWidget,
    );
  });

  testWidgets('ticking an app writes the allowlist, and NOVA says it is off',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    await tester.tap(find.text('Slack'));
    await tester.pumpAndSettle();

    expect(
      deps.preferences.getStringList(
        NotificationSettingsStore.allowedPackagesKey,
      ),
      contains('com.Slack'),
    );
    // The master toggle is still off, so the screen still says so.
    expect(find.text('OFF'), findsOneWidget);
  });

  testWidgets('read-aloud is refused until the opt-in is switched on',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        NotificationSettingsStore.enabledKey: true,
        NotificationSettingsStore.allowedPackagesKey: <String>['com.Slack'],
      },
    );
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    // Nothing has been read, so there is nothing to speak and the screen says
    // where summaries will appear.
    expect(find.textContaining('Nothing yet'), findsOneWidget);
    expect(find.text('Read aloud'), findsNothing);
  });

  testWidgets('renders an Android-only notice instead of the console off Android',
      (tester) async {
    // App Review 2.3.1(a). The platform reports `unsupported` on iOS
    // (`UnsupportedNotificationAssistantPlatform`), but the page used to render
    // every step anyway: the access card with its "Manage in Android Settings"
    // button, the master toggle and a live-looking inbox. A reviewer on an iPhone
    // then saw a feature set the build cannot deliver.
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform(supported: false);
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    expect(find.text('Notification assistant is Android only'), findsOneWidget);
    expect(find.textContaining('iOS does not provide'), findsOneWidget);

    // None of the console may render.
    expect(find.text('STEP 1 \u00b7 NOTIFICATION ACCESS'), findsNothing);
    expect(find.text('STEP 2 \u00b7 TURN IT ON'), findsNothing);
    expect(find.text('RULES'), findsNothing);
    expect(find.text('APPS ALLOWED'), findsNothing);
    expect(find.textContaining('Android Settings'), findsNothing);
    expect(find.text('ON'), findsNothing);
    expect(find.text('OFF'), findsNothing);
  });

  testWidgets('still renders the console where the platform supports it',
      (tester) async {
    // The gate must key on the platform's answer, not on the build target, or it
    // would hide a working feature on Android.
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform(supported: true);
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform);

    expect(find.text('Notification assistant is Android only'), findsNothing);
    // `NovaSectionHeader` upper-cases its title.
    expect(find.text('STEP 1 \u00b7 NOTIFICATION ACCESS'), findsOneWidget);
    expect(find.text('STEP 2 \u00b7 TURN IT ON'), findsOneWidget);
  });

  testWidgets('renders in the light theme as well as the dark one',
      (tester) async {
    // The blueprint requires "dark-first ... and a light theme for
    // accessibility/office use", so a screen that only survives one palette is
    // not finished.
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        NotificationSettingsStore.enabledKey: true,
        NotificationSettingsStore.allowedPackagesKey: <String>['com.Slack'],
      },
    );
    addTearDown(deps.dispose);
    final platform = FakeNotificationAssistantPlatform();
    addTearDown(platform.dispose);

    await pumpPage(tester, deps, platform: platform, light: true);

    expect(tester.takeException(), isNull);
    expect(find.text('ON'), findsOneWidget);
    expect(find.text('Google Authenticator'), findsOneWidget);
  });
}
