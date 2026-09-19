import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/theme/nova_theme.dart';
import 'package:nova_mobile/features/call_recording/call_recording_page.dart';
import 'package:nova_mobile/features/call_recording/call_recording_controller.dart';
import 'package:nova_mobile/features/call_recording/call_recording_settings_store.dart';
import 'package:nova_mobile/features/call_recording/call_recording_widgets.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

import '../helpers/fake_call_recording_platform.dart';
import '../helpers/test_harness.dart';

/// Pumps the call-recording screen with the platform and the API faked.
///
/// The two things this screen exists to make impossible to miss are the subject
/// of most of these tests: it must say plainly that it is **not** call
/// screening, and it must read nothing until the user has granted a folder and
/// ticked a file.
Future<void> pumpPage(
  WidgetTester tester,
  TestDependencies deps, {
  required FakeCallRecordingPlatform platform,
  FakeHttpAdapter? adapter,
  bool light = false,
  Map<String, Object> prefs = const <String, Object>{},
}) async {
  final api = adapter ??
      FakeHttpAdapter((options) async {
        if (options.path.contains('/recordings/capabilities')) {
          return jsonResponse(<String, dynamic>{
            'success': true,
            'data': <String, dynamic>{
              'transcription': 'async',
              'objectStorage': true,
              'maxUploadBytes': 0,
            },
          });
        }
        return jsonResponse(<String, dynamic>{'success': true, 'data': null});
      });
  final network = fakeNetworkService(api, networkInfo: deps.networkInfo);

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
        networkServiceProvider.overrideWithValue(network),
        authNetworkServiceProvider.overrideWithValue(network),
        callRecordingPlatformProvider.overrideWithValue(platform),
      ],
      child: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: MaterialApp(
          theme: light ? NovaTheme.light() : NovaTheme.darkTheme,
          home: const CallRecordingPage(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('states plainly what this is not', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(tester, deps, platform: FakeCallRecordingPlatform());

    // The requirement asked for call screening; the screen has to say it is not
    // that, in words a user can read, rather than merely omitting the claim.
    expect(find.text('What this is not'), findsOneWidget);
    expect(find.textContaining('Not call screening'), findsOneWidget);
    expect(find.textContaining('Not call recording'), findsOneWidget);
    expect(find.textContaining('Not the call log'), findsOneWidget);
    expect(
      find.textContaining('does not screen calls'),
      findsOneWidget,
      reason: 'the disclosure must not imply live screening',
    );
  });

  testWidgets('is off until the user grants a folder', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeCallRecordingPlatform();

    await pumpPage(tester, deps, platform: platform);

    // NovaStatusPill upper-cases its label.
    expect(find.text('OFF'), findsOneWidget);
    expect(find.text('NO FOLDER CHOSEN'), findsOneWidget);
    expect(
      platform.listCalls,
      0,
      reason: 'opening the screen must not scan anything',
    );
    expect(platform.readCalls, 0);
    expect(
      deps.preferences.getBool(CallRecordingSettingsStore.enabledKey),
      isNull,
      reason: 'a fresh install has written nothing',
    );
  });

  testWidgets('the folder picker needs the acknowledgement first',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeCallRecordingPlatform();

    await pumpPage(tester, deps, platform: platform);

    // Tap "Choose folder" without ticking the acknowledgement.
    await tester.tap(find.text('Choose folder'));
    await tester.pumpAndSettle();

    expect(
      platform.pickCalls,
      0,
      reason: 'no folder may be granted before the disclosure is read',
    );
    expect(
      find.textContaining('acknowledge what this does'),
      findsOneWidget,
    );
  });

  testWidgets('ticking the acknowledgement allows the picker', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeCallRecordingPlatform();

    await pumpPage(tester, deps, platform: platform);

    await tester.tap(find.byType(CheckboxListTile).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose folder'));
    await tester.pumpAndSettle();

    expect(platform.pickCalls, 1);
    // The folder is stored, but reading is still off until the switch is set.
    expect(find.textContaining('Recordings'), findsWidgets);
    expect(find.text('OFF'), findsOneWidget);
    expect(platform.listCalls, 0);
  });

  testWidgets('a granted folder lists only the files the user selects',
      (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[
        callAsset(id: 'a', name: 'Call_20260101_143000.m4a'),
        callAsset(id: 'b', name: 'Call_20251231_090000.m4a'),
      ].cast(),
    );

    await pumpPage(tester, deps, platform: platform);

    await tester.tap(find.byType(CheckboxListTile).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose folder'));
    await tester.pumpAndSettle();

    // Turn reading on, which is what triggers the first scan.
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();

    expect(platform.listCalls, 1);
    expect(find.textContaining('2 audio files found'), findsOneWidget);
    expect(find.text('Call_20260101_143000.m4a'), findsOneWidget);
    expect(find.text('Call_20251231_090000.m4a'), findsOneWidget);
    // The duration the file carries is shown; NOVA does not invent one.
    expect(find.textContaining('01:35'), findsWidgets);
    expect(
      find.text('Select recordings to import'),
      findsOneWidget,
      reason: 'the import button is disabled until something is ticked',
    );
  });

  testWidgets('renders in light theme too', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    await pumpPage(
      tester,
      deps,
      platform: FakeCallRecordingPlatform(),
      light: true,
    );

    expect(find.text('Call recordings'), findsOneWidget);
    expect(find.byType(CallRecordingDisclosureCard), findsOneWidget);
  });
}
