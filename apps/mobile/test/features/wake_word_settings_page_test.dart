import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/theme/nova_theme.dart';
import 'package:nova_mobile/core/voice/wake_word_service.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/features/settings/wake_word_settings_page.dart';

import '../helpers/test_harness.dart';

/// Pumps the wake-word settings screen with every platform dependency faked.
///
/// `networkService` answers the §13.10 config read, so the account card settles
/// instead of reaching for the real API.
Future<void> pumpPage(
  WidgetTester tester,
  TestDependencies deps, {
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
        networkServiceProvider.overrideWithValue(emptyApiNetworkService()),
        authNetworkServiceProvider.overrideWithValue(emptyApiNetworkService()),
      ],
      child: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: MaterialApp(
          theme: light ? NovaTheme.light() : NovaTheme.darkTheme,
          home: const WakeWordSettingsPage(),
        ),
      ),
    ),
  );
  // Explicit pumps rather than `pumpAndSettle`: the loading spinner and the
  // provider futures settle quickly, and the surrounding design system has
  // loops that never do.
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets('says plainly that only one wake word is installed', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    // The shipped build installs one classifier. The screen must say that
    // rather than draw a picker with a single, inert option.
    expect(find.text('Only one wake word is installed'), findsOneWidget);
    expect(
      find.textContaining('nothing to choose between'),
      findsWidgets,
    );
    // No radio rows at all: nothing is being offered as a choice.
    expect(find.byIcon(Icons.radio_button_unchecked_rounded), findsNothing);
    expect(find.byIcon(Icons.radio_button_checked_rounded), findsNothing);

    // The phrase shown is the installed classifier, humanised — not "Hey Nova".
    expect(find.text('"Hey Jarvis"'), findsOneWidget);
    expect(find.text('Hey Nova'), findsNothing);
    expect(find.text('"Hey Nova"'), findsNothing);

    // What switching would actually take is stated, with where it is documented.
    expect(
      find.textContaining('wakeword/models.json'),
      findsOneWidget,
    );
    expect(
      find.textContaining('No such model exists in this repository'),
      findsOneWidget,
    );
  });

  testWidgets('does not claim the wake word can run a device action', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    expect(
      find.textContaining('It opens the conversation when NOVA hears the phrase'),
      findsOneWidget,
    );
    expect(
      find.textContaining('It cannot run a device action'),
      findsOneWidget,
    );
  });

  testWidgets('the §13.10 record is described as a preference, not a control',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    expect(find.text('ON YOUR ACCOUNT'), findsOneWidget);
    // The faked GET answers `wakeWord: null`, so no phrase is claimed.
    expect(find.text('No wake word recorded yet'), findsOneWidget);
    expect(
      find.textContaining('does not change what your microphone listens for'),
      findsOneWidget,
    );
  });

  testWidgets('offers a real picker only when several classifiers exist',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      wakeWordAvailability: const WakeWordAvailability(
        available: true,
        reason: 'ok',
        models: <String>['hey_jarvis', 'hey_mycroft'],
        selected: 'hey_jarvis',
      ),
    );
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    // This is the shape a second installed model would produce. No shipped build
    // reaches it, which is exactly why the single-model screen above says so.
    expect(find.text('Only one wake word is installed'), findsNothing);
    expect(find.text('Hey Mycroft'), findsOneWidget);
    expect(find.byIcon(Icons.radio_button_checked_rounded), findsOneWidget);
    expect(find.byIcon(Icons.radio_button_unchecked_rounded), findsOneWidget);

    await tester.tap(find.text('Hey Mycroft'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(deps.wakeWordPlatform.selectModelCalls, <String>['hey_mycroft']);
    expect(find.text('Listening for this phrase'), findsOneWidget);
  });

  testWidgets('records the choice against the account after selecting',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      wakeWordAvailability: const WakeWordAvailability(
        available: true,
        reason: 'ok',
        models: <String>['hey_jarvis', 'hey_mycroft'],
        selected: 'hey_jarvis',
      ),
    );
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    await tester.tap(find.text('Hey Mycroft'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));

    // The device applied it, and the account note followed. The device is still
    // what decides; the record is only a note.
    expect(deps.wakeWordPlatform.selectModelCalls, <String>['hey_mycroft']);
    expect(find.text('Recorded on your account.'), findsOneWidget);
  });

  testWidgets('no installed classifier is stated honestly', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      wakeWordAvailability: const WakeWordAvailability(
        available: false,
        reason: 'no_wake_word_model',
      ),
    );
    addTearDown(deps.dispose);

    await pumpPage(tester, deps);

    expect(find.text('Wake word detection is unavailable'), findsOneWidget);
    expect(find.text('No wake word is installed in this build.'), findsOneWidget);
    expect(
      find.text('Nothing — no wake word is installed'),
      findsOneWidget,
    );
    // Nothing was invented, and no selection was offered.
    expect(find.text('Hey Nova'), findsNothing);
    expect(find.byIcon(Icons.radio_button_unchecked_rounded), findsNothing);
  });

  testWidgets('renders in light mode from the same tokens', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps, light: true);

    // No hardcoded dark-only colours: the same screen builds against the light
    // palette with the same content.
    expect(find.text('Only one wake word is installed'), findsOneWidget);
    expect(find.text('"Hey Jarvis"'), findsOneWidget);
    expect(find.text('ON YOUR ACCOUNT'), findsOneWidget);
  });
}
