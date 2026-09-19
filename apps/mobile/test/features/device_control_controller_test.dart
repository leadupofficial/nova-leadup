import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/device_control/device_control_controller.dart';
import 'package:nova_mobile/features/device_control/device_control_models.dart';

import '../helpers/fake_device_control_platform.dart';

/// Controller-level tests for the gate and the granted/denied/unsupported
/// branches.
///
/// The property under test throughout is the difference between "it did not run"
/// and "it ran and failed": a refused action must never reach
/// [FakeDeviceControlPlatform.invocations].
void main() {
  ProviderContainer containerWith(FakeDeviceControlPlatform platform) {
    final container = ProviderContainer(
      overrides: [deviceControlPlatformProvider.overrideWithValue(platform)],
    );
    addTearDown(container.dispose);
    return container;
  }

  group('the confirmation gate', () {
    test('an L1 action does not run without confirmation', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.openApp('com.whatsapp'),
      );

      expect(outcome.code, DeviceOutcomeCode.confirmationRequired);
      expect(outcome.ok, isFalse);
      expect(platform.invocations, isEmpty, reason: 'nothing may reach Android');
    });

    test('an L2 call does not run without confirmation', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.dial('+919876543210'),
      );

      expect(outcome.code, DeviceOutcomeCode.confirmationRequired);
      expect(platform.invocations, isEmpty);
    });

    test('an L3 device-setting change does not run without confirmation', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      for (final request in <DeviceActionRequest>[
        const DeviceActionRequest.dnd(true),
        const DeviceActionRequest.brightness(0.4),
      ]) {
        final outcome = await controller.perform(request);
        expect(outcome.code, DeviceOutcomeCode.confirmationRequired);
      }
      expect(platform.invocations, isEmpty);
    });

    test('a confirmed action reaches Android exactly once', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.openApp('com.whatsapp'),
        confirmed: true,
      );

      expect(outcome.ok, isTrue);
      expect(platform.invocations, hasLength(1));
      expect(platform.invocations.single.action, DeviceAction.openApp);
      expect(platform.invocations.single.app, 'com.whatsapp');
    });

    test('a threshold above the level lets it run unconfirmed', () async {
      // The level table is the only thing that decides; a higher threshold must
      // silence a lower level (the API's `VOICE_TOOL_CONFIRM_LEVEL` behaviour).
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(
          confirmLevel: DeviceControlLevels.external,
        ),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final openApp = await controller.perform(
        const DeviceActionRequest.openApp('com.whatsapp'),
      );
      expect(openApp.ok, isTrue);
      expect(platform.invocations, hasLength(1));

      // ...but an L2 still prompts.
      final dial = await controller.perform(
        const DeviceActionRequest.dial('+919876543210'),
      );
      expect(dial.code, DeviceOutcomeCode.confirmationRequired);
      expect(platform.invocations, hasLength(1));
    });

    test('the screen only raises its sheet for L2 and above', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      expect(
        controller.needsConfirmationSheet(
          const DeviceActionRequest.openApp('com.whatsapp'),
        ),
        isFalse,
      );
      expect(
        controller.needsConfirmationSheet(
          const DeviceActionRequest(DeviceAction.mediaPause),
        ),
        isFalse,
      );
      expect(
        controller.needsConfirmationSheet(
          const DeviceActionRequest.dial('+919876543210'),
        ),
        isTrue,
      );
      expect(
        controller.needsConfirmationSheet(const DeviceActionRequest.dnd(true)),
        isTrue,
      );
      expect(
        controller.needsConfirmationSheet(
          const DeviceActionRequest.brightness(0.4),
        ),
        isTrue,
      );
    });
  });

  group('ungranted special access', () {
    test('brightness is refused with the grant screen, and nothing runs', () async {
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(brightnessGranted: false),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.brightness(0.4),
        confirmed: true,
      );

      expect(outcome.code, DeviceOutcomeCode.permissionDenied);
      expect(outcome.grantPanel, DeviceSettingsPanel.writeSettings);
      expect(outcome.message, contains('Modify system settings'));
      expect(
        platform.invocations,
        isEmpty,
        reason: 'an ungranted access must not even be attempted',
      );
    });

    test('DND is refused with the grant screen, and nothing runs', () async {
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(dndGranted: false),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.dnd(true),
        confirmed: true,
      );

      expect(outcome.code, DeviceOutcomeCode.permissionDenied);
      expect(outcome.grantPanel, DeviceSettingsPanel.dndAccess);
      expect(platform.invocations, isEmpty);
    });

    test('openGrantSettings opens the granting panel', () async {
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(brightnessGranted: false),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.openGrantSettings(
        DeviceAction.setBrightness,
      );

      expect(outcome.ok, isTrue);
      expect(platform.invocations, hasLength(1));
      expect(platform.invocations.single.action, DeviceAction.openSettings);
      expect(
        platform.invocations.single.panel,
        DeviceSettingsPanel.writeSettings,
      );
    });
  });

  group('unsupported', () {
    test('a platform with no implementation refuses before Android is asked',
        () async {
      final platform = FakeDeviceControlPlatform(
        status: DeviceControlStatus.unsupported,
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.openApp('com.whatsapp'),
        confirmed: true,
      );

      expect(outcome.code, DeviceOutcomeCode.notSupported);
      expect(platform.invocations, isEmpty);
    });

    test('an action Android reports unavailable is refused with its reason',
        () async {
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(openAppAvailable: false),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.openApp('com.whatsapp'),
        confirmed: true,
      );

      expect(outcome.code, DeviceOutcomeCode.unsupported);
      expect(outcome.message, contains('cannot open apps'));
      expect(platform.invocations, isEmpty);
    });

    test('a missing app is surfaced as app_not_found, never as success',
        () async {
      final platform = FakeDeviceControlPlatform()
        ..reply(
          DeviceAction.openApp,
          const DeviceOutcome(
            code: DeviceOutcomeCode.appNotFound,
            message: 'com.example.ghost is not installed.',
          ),
        );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest.openApp('com.example.ghost'),
        confirmed: true,
      );

      expect(outcome.code, DeviceOutcomeCode.appNotFound);
      expect(outcome.ok, isFalse);
    });

    test('media with no active session is refused, not reported as sent',
        () async {
      final platform = FakeDeviceControlPlatform()
        ..reply(
          DeviceAction.mediaPause,
          const DeviceOutcome(
            code: DeviceOutcomeCode.noActiveSession,
            message: 'No media session is active, so nothing was sent.',
          ),
        );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.perform(
        const DeviceActionRequest(DeviceAction.mediaPause),
        confirmed: true,
      );

      expect(outcome.code, DeviceOutcomeCode.noActiveSession);
      expect(outcome.ok, isFalse);
    });
  });

  group('voice commands', () {
    test('a spoken app name reaches the gate and then Android', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      // Unconfirmed: the gate stops it.
      final blocked = await controller.runVoiceCommand('open WhatsApp');
      expect(blocked!.code, DeviceOutcomeCode.confirmationRequired);
      expect(platform.invocations, isEmpty);

      // Confirmed: it runs.
      final ran = await controller.runVoiceCommand(
        'open WhatsApp',
        confirmed: true,
      );
      expect(ran!.ok, isTrue);
      // The payload keeps the spoken casing; the Kotlin resolver lower-cases it
      // before looking the alias up.
      expect(platform.invocations.single.app, 'WhatsApp');
    });

    test('a spoken Wi-Fi toggle opens the panel and says it cannot toggle',
        () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.runVoiceCommand(
        'turn on wifi',
        confirmed: true,
      );

      expect(outcome!.ok, isTrue);
      expect(platform.invocations.single.action, DeviceAction.openSettings);
      expect(
        platform.invocations.single.panel,
        DeviceSettingsPanel.wifi,
      );
      // The whole point: the reply must not imply the switch moved.
      expect(outcome.message, contains('Android 10'));
      expect(outcome.message.toLowerCase(), contains('cannot'));
    });

    test('a spoken Bluetooth toggle is honest in the same way', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.runVoiceCommand(
        'turn off bluetooth',
        confirmed: true,
      );

      expect(outcome!.message, contains('Android 12'));
      expect(platform.invocations.single.panel, DeviceSettingsPanel.bluetooth);
    });

    test('a spoken call is gated at L2', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final blocked = await controller.runVoiceCommand('call 9876543210');
      expect(blocked!.code, DeviceOutcomeCode.confirmationRequired);
      expect(platform.invocations, isEmpty);

      final ran = await controller.runVoiceCommand(
        'call 9876543210',
        confirmed: true,
      );
      expect(ran!.ok, isTrue);
      expect(platform.invocations.single.action, DeviceAction.dialNumber);
      expect(platform.invocations.single.number, '9876543210');
    });

    test('a relative brightness resolves against the current value', () async {
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(brightness: 128),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.runVoiceCommand(
        'brighter',
        confirmed: true,
      );

      expect(outcome!.ok, isTrue);
      // 128/255 + 0.15 ≈ 0.652
      expect(
        platform.invocations.single.brightness,
        closeTo(128 / 255 + 0.15, 0.001),
      );
    });

    test('a DND toggle resolves against the current state', () async {
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(dndEnabled: false),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      await controller.runVoiceCommand(
        'toggle do not disturb',
        confirmed: true,
      );

      expect(platform.invocations.single.dndEnabled, isTrue);
    });

    test('an ordinary sentence matches nothing', () async {
      final platform = FakeDeviceControlPlatform();
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      for (final phrase in <String>[
        'what is on my calendar today',
        'remind me to call the bank',
        'call Priya',
        '',
      ]) {
        expect(
          await controller.runVoiceCommand(phrase, confirmed: true),
          isNull,
          reason: '"$phrase" must not become a device action',
        );
      }
      expect(platform.invocations, isEmpty);
    });

    test('a relative command with no readable state changes nothing', () async {
      final platform = FakeDeviceControlPlatform(
        status: fakeDeviceControlStatus(brightness: null),
      );
      final container = containerWith(platform);
      final controller = container.read(deviceControlProvider.notifier);
      await pumpEventQueue();

      final outcome = await controller.runVoiceCommand(
        'brighter',
        confirmed: true,
      );

      expect(outcome!.code, DeviceOutcomeCode.invalidArgument);
      expect(platform.invocations, isEmpty);
    });
  });

  test('a successful state change re-reads the reported state', () async {
    final platform = FakeDeviceControlPlatform(
      status: fakeDeviceControlStatus(dndEnabled: false),
    );
    final container = containerWith(platform);
    final controller = container.read(deviceControlProvider.notifier);
    await pumpEventQueue();
    final before = platform.statusCalls;

    await controller.perform(const DeviceActionRequest.dnd(true), confirmed: true);
    await pumpEventQueue();

    expect(platform.statusCalls, greaterThan(before));
  });
}
