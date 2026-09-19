import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/design/widgets/index.dart';
import 'package:nova_mobile/features/device_control/device_control_controller.dart';
import 'package:nova_mobile/features/device_control/device_control_models.dart';
import 'package:nova_mobile/features/device_control/device_control_page.dart';

import '../helpers/fake_device_control_platform.dart';
import '../helpers/test_harness.dart';

/// Widget tests for the device-control screen.
///
/// The screen is where the honest limits have to be *visible*: an action that
/// cannot run must show why, not offer a button that fails silently.
void main() {
  Widget pageApp(FakeDeviceControlPlatform platform) => ProviderScope(
    overrides: [deviceControlPlatformProvider.overrideWithValue(platform)],
    child: MaterialApp(
      theme: NovaTheme.darkTheme,
      home: const MediaQuery(
        data: MediaQueryData(disableAnimations: true),
        child: DeviceControlPage(),
      ),
    ),
  );

  Future<FakeDeviceControlPlatform> pumpPage(
    WidgetTester tester, {
    FakeDeviceControlPlatform? platform,
  }) async {
    useTallSurface(tester);
    final fake = platform ?? FakeDeviceControlPlatform();
    await tester.pumpWidget(pageApp(fake));
    await tester.pumpAndSettle();
    return fake;
  }

  testWidgets('renders the capability disclosure and both honest limits',
      (WidgetTester tester) async {
    await pumpPage(tester);

    expect(find.text('Device control'), findsOneWidget);
    expect(find.textContaining('cannot toggle Wi-Fi or Bluetooth'), findsOneWidget);
    // The excluded capabilities are shown with their spec reason.
    expect(find.text('Send SMS'), findsOneWidget);
    expect(
      find.text('Read the screen or control other apps'),
      findsOneWidget,
    );
  });

  testWidgets('shows the Android-version reasons for Wi-Fi and Bluetooth',
      (WidgetTester tester) async {
    await pumpPage(tester);

    expect(find.textContaining('Android 10 removed programmatic Wi-Fi'), findsOneWidget);
    expect(find.textContaining('Android 12 made Bluetooth'), findsOneWidget);
  });

  testWidgets('an L1 app launch runs on the tap, with no extra dialog',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);

    await tester.enterText(find.byType(TextField).first, 'WhatsApp');
    await tester.tap(find.widgetWithText(NovaSecondaryButton, 'Open'));
    await tester.pumpAndSettle();

    expect(find.text('Do it'), findsNothing);
    expect(platform.invocations, hasLength(1));
    expect(platform.invocations.single.action, DeviceAction.openApp);
    expect(platform.invocations.single.app, 'WhatsApp');
  });

  testWidgets('an unrecognised app is reported, never silently opened',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);
    platform.reply(
      DeviceAction.openApp,
      const DeviceOutcome(
        code: DeviceOutcomeCode.appNotFound,
        message: 'com.example.ghost is not installed.',
      ),
    );

    await tester.enterText(find.byType(TextField).first, 'com.example.ghost');
    await tester.tap(find.widgetWithText(NovaSecondaryButton, 'Open'));
    await tester.pumpAndSettle();

    // Shown both in the outcome banner and the snack bar.
    expect(find.textContaining('is not installed'), findsWidgets);
  });

  testWidgets('dialling raises the confirmation sheet and only runs on confirm',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);

    await tester.enterText(find.byType(TextField).at(1), '9876543210');
    await tester.tap(find.widgetWithText(NovaSecondaryButton, 'Open dialer'));
    await tester.pumpAndSettle();

    // §9.2: show the number and confirm. Nothing has run yet.
    expect(find.text('Open the dialer?'), findsOneWidget);
    expect(find.textContaining('9876543210'), findsWidgets);
    expect(platform.invocations, isEmpty);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(platform.invocations, isEmpty);

    await tester.tap(find.widgetWithText(NovaSecondaryButton, 'Open dialer'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Do it'));
    await tester.pumpAndSettle();

    expect(platform.invocations, hasLength(1));
    expect(platform.invocations.single.action, DeviceAction.dialNumber);
    expect(platform.invocations.single.number, '9876543210');
  });

  testWidgets('an ungranted brightness access offers the grant screen instead',
      (WidgetTester tester) async {
    final platform = await pumpPage(
      tester,
      platform: FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(brightnessGranted: false),
      ),
    );

    expect(find.text('access not granted'), findsWidgets);
    expect(find.textContaining('Modify system settings'), findsWidgets);

    await tester.tap(find.widgetWithText(NovaSecondaryButton, 'Grant access').first);
    await tester.pumpAndSettle();

    expect(platform.invocations, hasLength(1));
    expect(platform.invocations.single.action, DeviceAction.openSettings);
    expect(platform.invocations.single.panel, DeviceSettingsPanel.writeSettings);
  });

  testWidgets('a granted brightness control runs after confirmation',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);

    await tester.tap(find.widgetWithText(NovaSecondaryButton, '50%'));
    await tester.pumpAndSettle();

    // L3: the sheet must appear before anything runs.
    expect(find.text('Screen brightness?'), findsOneWidget);
    expect(platform.invocations, isEmpty);

    await tester.tap(find.text('Do it'));
    await tester.pumpAndSettle();

    expect(platform.invocations, hasLength(1));
    expect(platform.invocations.single.action, DeviceAction.setBrightness);
    expect(platform.invocations.single.brightness, closeTo(0.5, 0.0001));
  });

  testWidgets('a media key is a low-risk tap and reaches the platform',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);

    await tester.tap(find.widgetWithText(NovaSecondaryButton, 'Pause'));
    await tester.pumpAndSettle();

    expect(platform.invocations, hasLength(1));
    expect(platform.invocations.single.action, DeviceAction.mediaPause);
  });

  testWidgets('a no-active-session refusal is shown, not hidden',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);
    platform.reply(
      DeviceAction.mediaPlay,
      const DeviceOutcome(
        code: DeviceOutcomeCode.noActiveSession,
        message: 'No media session is active, so nothing was sent.',
      ),
    );

    await tester.tap(find.widgetWithText(NovaSecondaryButton, 'Play'));
    await tester.pumpAndSettle();

    expect(find.textContaining('No media session is active'), findsWidgets);
  });

  testWidgets('the voice console runs the matcher and asks for confirmation',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);

    await tester.enterText(find.byType(TextField).at(2), 'pause the music');
    await tester.testTextInput.receiveAction(TextInputAction.go);
    await tester.pumpAndSettle();

    expect(find.text('Pause?'), findsOneWidget);
    expect(platform.invocations, isEmpty);

    await tester.tap(find.text('Do it'));
    await tester.pumpAndSettle();

    expect(platform.invocations, hasLength(1));
    expect(platform.invocations.single.action, DeviceAction.mediaPause);
  });

  testWidgets('a spoken Wi-Fi toggle explains itself instead of claiming success',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);

    await tester.enterText(find.byType(TextField).at(2), 'turn on wifi');
    await tester.testTextInput.receiveAction(TextInputAction.go);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Do it'));
    await tester.pumpAndSettle();

    expect(platform.invocations.single.action, DeviceAction.openSettings);
    expect(platform.invocations.single.panel, DeviceSettingsPanel.wifi);
    // The spoken reply carries the Android reason, not "done".
    expect(find.textContaining('Android 10'), findsWidgets);
  });

  testWidgets('an ordinary sentence is refused by the console',
      (WidgetTester tester) async {
    final platform = await pumpPage(tester);

    await tester.enterText(
      find.byType(TextField).at(2),
      'what is on my calendar',
    );
    await tester.testTextInput.receiveAction(TextInputAction.go);
    await tester.pumpAndSettle();

    expect(find.textContaining('No device command'), findsOneWidget);
    expect(platform.invocations, isEmpty);
  });

  testWidgets('DND shows its current state and toggles it',
      (WidgetTester tester) async {
    final platform = await pumpPage(
      tester,
      platform: FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(dndEnabled: false),
      ),
    );

    expect(find.text('off'), findsWidgets);
    await tester.tap(
      find.widgetWithText(NovaSecondaryButton, 'Turn Do Not Disturb on'),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Do it'));
    await tester.pumpAndSettle();

    expect(platform.invocations.single.action, DeviceAction.setDnd);
    expect(platform.invocations.single.dndEnabled, isTrue);
  });
}
