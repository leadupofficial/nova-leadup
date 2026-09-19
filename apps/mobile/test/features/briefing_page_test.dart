import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/theme/nova_theme.dart';
import 'package:nova_mobile/core/voice/device_tts.dart';
import 'package:nova_mobile/features/briefing/briefing_page.dart';
import 'package:nova_mobile/features/briefing/briefing_settings_store.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

import '../core/voice/voice_realtime_test_support.dart';
import '../helpers/test_harness.dart';

/// Pumps the daily-briefing settings screen with every platform dependency
/// faked, so nothing touches a notification channel or a TTS engine.
Future<void> pumpPage(
  WidgetTester tester,
  TestDependencies deps, {
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
        deviceTtsProvider.overrideWithValue(tts ?? FakeDeviceTts()),
      ],
      child: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: MaterialApp(
          theme: light ? NovaTheme.light() : NovaTheme.darkTheme,
          home: const DailyBriefingPage(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('states that the briefing is off by default', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    expect(find.text('OFF'), findsOneWidget);
    expect(
      find.textContaining('off by default'),
      findsOneWidget,
      reason: 'the opt-in has to be stated in words, not only via a pill',
    );
    expect(
      deps.preferences.getBool(BriefingSettingsStore.enabledKey),
      isNull,
      reason: 'a fresh install must not have written the opt-in at all',
    );
    expect(
      deps.reminderNotifications.dailyCalls,
      isEmpty,
      reason: 'a fresh install schedules nothing',
    );
  });

  testWidgets('turning the switch on persists the opt-in and arms the alarm', (
    tester,
  ) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();

    expect(deps.preferences.getBool(BriefingSettingsStore.enabledKey), isTrue);
    expect(deps.reminderNotifications.dailyCalls, hasLength(1));
  });

  testWidgets('names the sources it does not have instead of implying them', (
    tester,
  ) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    expect(find.text('Calendar and meetings'), findsOneWidget);
    expect(
      find.textContaining('no calendar or event source'),
      findsOneWidget,
      reason: '§9.4 talks about meetings; this repo has no calendar at all',
    );
    expect(find.text('Weather'), findsOneWidget);
    expect(find.textContaining('no weather provider'), findsOneWidget);
    expect(
      find.text('NOT CONNECTED'),
      findsNWidgets(4),
      reason: 'calendar, weather, evening recap and location are all absent',
    );
  });

  testWidgets('renders in the light theme too', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps, light: true);

    expect(find.text('Daily briefing'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('surfaces a missing device voice before the time arrives', (
    tester,
  ) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_language_policy': 'ta'},
    );
    addTearDown(deps.dispose);

    await pumpPage(
      tester,
      deps,
      tts: FakeDeviceTts(unsupported: <String>{'ta-IN'}),
    );

    expect(find.textContaining('no voice for ta-IN'), findsOneWidget);
  });
}
