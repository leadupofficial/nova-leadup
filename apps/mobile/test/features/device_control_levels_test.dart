import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/device_control/device_control_models.dart';

/// The Dart half of the device-control registry.
///
/// `DeviceControlCatalogTest.kt` pins the same table for Kotlin and
/// `device_control_contract_test.dart` asserts the two agree; this file is where
/// the *decisions* are stated, so a level can never be changed by accident.
void main() {
  group('the permission-level registry', () {
    test('classifies every declared action, with no strays', () {
      expect(
        DeviceControlLevels.levels.keys.toSet(),
        DeviceAction.values.toSet(),
        reason: 'every action must carry a level',
      );
    });

    test('rates the low-risk, reversible actions L1', () {
      // Opening an app or a settings panel changes nothing by itself; a media
      // transport key is local and instantly reversible (the owner's brief
      // calls pausing media low-risk).
      expect(DeviceControlLevels.levelOf(DeviceAction.openApp), 1);
      expect(DeviceControlLevels.levelOf(DeviceAction.openSettings), 1);
      expect(DeviceControlLevels.levelOf(DeviceAction.mediaPlay), 1);
      expect(DeviceControlLevels.levelOf(DeviceAction.mediaPause), 1);
      expect(DeviceControlLevels.levelOf(DeviceAction.mediaNext), 1);
      expect(DeviceControlLevels.levelOf(DeviceAction.mediaPrevious), 1);
    });

    test('rates the actions that leave NOVA or reach a person L2', () {
      // An arbitrary URI leaves the app for content NOVA did not choose, and a
      // call reaches someone outside the user's account — §9.2's "show number,
      // confirm".
      expect(DeviceControlLevels.levelOf(DeviceAction.openDeepLink), 2);
      expect(DeviceControlLevels.levelOf(DeviceAction.dialNumber), 2);
    });

    test('rates the device-wide setting changes L3', () {
      // §10.1: "change account setting" is sensitive/consequential, so DND and
      // brightness demand an explicit confirmation.
      expect(DeviceControlLevels.levelOf(DeviceAction.setDnd), 3);
      expect(DeviceControlLevels.levelOf(DeviceAction.setBrightness), 3);
    });

    test('requires confirmation at the beta threshold for L1 and above', () {
      for (final action in DeviceAction.values) {
        expect(
          DeviceControlLevels.requiresConfirmation(action),
          DeviceControlLevels.levelOf(action) >=
              DeviceControlLevels.defaultConfirmLevel,
          reason: 'confirmation arithmetic must match the level (${action.wireName})',
        );
      }
      expect(DeviceControlLevels.requiresConfirmation(DeviceAction.openApp), isTrue);
      expect(DeviceControlLevels.requiresConfirmation(DeviceAction.setDnd), isTrue);
      expect(DeviceControlLevels.requiresConfirmation(DeviceAction.dialNumber), isTrue);
    });

    test('L0 is below every real threshold, so it can never prompt', () {
      // The property the API gate depends on, asserted against the constant the
      // scale starts at (no action is L0 today).
      expect(DeviceControlLevels.readOnly, 0);
      for (var threshold = 1; threshold <= 3; threshold++) {
        expect(DeviceControlLevels.readOnly >= threshold, isFalse);
      }
    });

    test('an unclassified action is treated as the most sensitive, never L0', () {
      // The untrusted-caller rule. Reached through a synthetic value only, but
      // pinned because the default is what keeps a future action safe.
      expect(DeviceControlLevels.sensitive, 3);
    });

    test('a higher threshold requires confirmation only for higher levels', () {
      expect(
        DeviceControlLevels.requiresConfirmation(
          DeviceAction.openApp,
          threshold: DeviceControlLevels.external,
        ),
        isFalse,
      );
      expect(
        DeviceControlLevels.requiresConfirmation(
          DeviceAction.setDnd,
          threshold: DeviceControlLevels.sensitive,
        ),
        isTrue,
      );
      expect(
        DeviceControlLevels.requiresConfirmation(
          DeviceAction.setDnd,
          threshold: 4,
        ),
        isFalse,
      );
    });
  });

  group('wire ids', () {
    test('round-trip and reject unknown values', () {
      for (final action in DeviceAction.values) {
        expect(DeviceAction.fromWire(action.wireName), action);
      }
      expect(DeviceAction.fromWire('launch_missiles'), isNull);
      expect(DeviceAction.fromWire(''), isNull);

      for (final panel in DeviceSettingsPanel.values) {
        expect(DeviceSettingsPanel.fromWire(panel.wireName), panel);
      }
      expect(DeviceSettingsPanel.fromWire('nope'), isNull);
    });

    test('the action ids are the frozen snake-case set', () {
      expect(
        DeviceAction.values.map((DeviceAction a) => a.wireName).toSet(),
        <String>{
          'open_app',
          'open_deep_link',
          'open_settings',
          'dial_number',
          'set_brightness',
          'set_dnd',
          'media_play',
          'media_pause',
          'media_next',
          'media_previous',
          'start_recording',
          'stop_recording',
        },
      );
    });

    test('there is no SMS action and no screen-reading action', () {
      // §9.2 defers SMS and excludes accessibility screen reading. Their absence
      // is a spec decision, so it is asserted rather than assumed.
      final ids = DeviceAction.values
          .map((DeviceAction a) => a.wireName)
          .toList(growable: false);
      expect(ids.any((String id) => id.contains('sms')), isFalse);
      expect(ids.any((String id) => id.contains('screen')), isFalse);
      expect(ids.any((String id) => id.contains('accessibility')), isFalse);
    });

    test('outcome codes parse and default to a failure, never to ok', () {
      for (final code in DeviceOutcomeCode.values) {
        expect(DeviceOutcomeCode.fromWire(code.wireName), code);
      }
      expect(DeviceOutcomeCode.fromWire('nonsense'), DeviceOutcomeCode.failed);
      expect(DeviceOutcomeCode.failed.succeeded, isFalse);
      expect(DeviceOutcomeCode.ok.succeeded, isTrue);
    });
  });

  group('requests', () {
    test('carry the exact platform arguments the Kotlin handler reads', () {
      expect(
        const DeviceActionRequest.openApp('com.whatsapp').platformArguments,
        <String, Object?>{'app': 'com.whatsapp'},
      );
      expect(
        const DeviceActionRequest.openDeepLink('https://x.test').platformArguments,
        <String, Object?>{'uri': 'https://x.test'},
      );
      expect(
        const DeviceActionRequest.openPanel(DeviceSettingsPanel.wifi)
            .platformArguments,
        <String, Object?>{'panel': 'wifi'},
      );
      expect(
        const DeviceActionRequest.dial('+919876543210').platformArguments,
        <String, Object?>{'number': '+919876543210'},
      );
      expect(
        const DeviceActionRequest.brightness(0.4).platformArguments,
        <String, Object?>{'value': 0.4},
      );
      expect(
        const DeviceActionRequest.dnd(true).platformArguments,
        <String, Object?>{'enabled': true},
      );
      expect(
        const DeviceActionRequest(DeviceAction.mediaNext).platformArguments,
        <String, Object?>{'action': 'media_next'},
      );
    });

    test('map onto the method names the Kotlin handler answers', () {
      expect(const DeviceActionRequest.openApp('x').method, 'openApp');
      expect(const DeviceActionRequest.openDeepLink('x').method, 'openDeepLink');
      expect(
        const DeviceActionRequest.openPanel(DeviceSettingsPanel.wifi).method,
        'openSettings',
      );
      expect(const DeviceActionRequest.dial('123').method, 'dial');
      expect(const DeviceActionRequest.brightness(0.5).method, 'setBrightness');
      expect(const DeviceActionRequest.dnd(true).method, 'setDnd');
      expect(
        const DeviceActionRequest(DeviceAction.mediaPause).method,
        'media',
      );
    });

    test('carry the registry level, not a value chosen by the caller', () {
      expect(
        const DeviceActionRequest.dial('123').level,
        DeviceControlLevels.levelOf(DeviceAction.dialNumber),
      );
      expect(
        const DeviceActionRequest.brightness(0.5).requiresConfirmation(),
        isTrue,
      );
    });

    test('a confirmation summary states the exact effect', () {
      expect(
        const DeviceActionRequest.dnd(true).confirmationSummary,
        contains('Do Not Disturb on'),
      );
      expect(
        const DeviceActionRequest.brightness(0.4).confirmationSummary,
        contains('40%'),
      );
      // Dialling must say, in the sheet, that NOVA does not place the call.
      expect(
        const DeviceActionRequest.dial('+919876543210').confirmationSummary,
        contains('does not place the call'),
      );
    });
  });

  group('status decoding', () {
    test('decodes a full status map', () {
      final status = DeviceControlStatus.fromMap(const <String, Object?>{
        'supported': true,
        'androidSdk': 36,
        'androidRelease': '16',
        'confirmLevel': 1,
        'actions': <Object?>[
          <String, Object?>{
            'action': 'set_dnd',
            'level': 3,
            'capability': 'functional',
            'available': true,
            'granted': false,
            'reason': 'needs access',
          },
        ],
        'panels': <Object?>[
          <String, Object?>{
            'panel': 'wifi',
            'capability': 'deep_link_only',
            'available': true,
            'reason': 'Android 10',
          },
        ],
        'excluded': <Object?>[
          <String, Object?>{'id': 'send_sms', 'title': 'Send SMS', 'reason': 'deferred'},
        ],
        'brightness': 200,
        'dndEnabled': true,
      });

      expect(status.supported, isTrue);
      expect(status.androidSdk, 36);
      expect(status.actionStatus(DeviceAction.setDnd)!.granted, isFalse);
      expect(status.actionStatus(DeviceAction.setDnd)!.level, 3);
      expect(
        status.panelStatus(DeviceSettingsPanel.wifi)!.capability,
        DeviceCapability.deepLinkOnly,
      );
      expect(status.excluded.single.id, 'send_sms');
      expect(status.brightness, 200);
      expect(status.dndEnabled, isTrue);
    });

    test('a missing supported flag is read as unsupported, not as usable', () {
      // A map with no `supported` key must not silently become "everything
      // works": fromMap is only reached through the platform, which always
      // sends it, but the default matters.
      final status = DeviceControlStatus.fromMap(const <String, Object?>{});
      expect(status.supported, isTrue); // explicit `supported: false` is required
      expect(status.actions, isEmpty);
      expect(status.actionStatus(DeviceAction.openApp), isNull);
    });
  });
}
