import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/device_control/device_control_models.dart';
import 'package:nova_mobile/features/device_control/device_control_voice_commands.dart';

import '../helpers/fake_device_control_platform.dart';

/// The spoken-request mapper, pinned phrase by phrase.
///
/// The mapper is the part of the feature most able to go quietly wrong — a
/// "turn on Wi-Fi" that becomes a toggle, or a sentence that becomes an action
/// nobody asked for — so every branch is asserted here, away from the socket.
void main() {
  DeviceVoiceCommand? match(String phrase) => matchDeviceVoiceCommand(phrase);

  group('open apps and links', () {
    test('an app name maps to open_app', () {
      final command = match('open WhatsApp');
      expect(command!.action, DeviceAction.openApp);
      expect(command.app, 'WhatsApp');
    });

    test('launch and start are synonyms', () {
      expect(match('launch Spotify')!.app, 'Spotify');
      expect(match('start Maps')!.app, 'Maps');
    });

    test('a URL maps to the deep-link action, not to an app called https', () {
      final command = match('open https://nova.leadup.tech/pricing');
      expect(command!.action, DeviceAction.openDeepLink);
      expect(command.uri, 'https://nova.leadup.tech/pricing');
    });
  });

  group('calls', () {
    test('a number maps to the dialer and keeps the digits', () {
      final command = match('call 9876543210');
      expect(command!.action, DeviceAction.dialNumber);
      expect(command.number, '9876543210');
    });

    test('a number with punctuation is kept verbatim for the dialer', () {
      expect(match('dial +91 98765-43210')!.number, '+91 98765-43210');
    });

    test('a contact name is refused rather than guessed', () {
      // NOVA has no contacts permission; dialling a guessed number would be
      // worse than saying it cannot.
      expect(match('call Priya'), isNull);
      expect(match('phone mom'), isNull);
    });
  });

  group('do not disturb', () {
    test('on and off are not inverted', () {
      expect(match('turn on do not disturb')!.dndEnabled, isTrue);
      expect(match('turn off do not disturb')!.dndEnabled, isFalse);
      expect(match('enable dnd')!.dndEnabled, isTrue);
      expect(match('disable dnd')!.dndEnabled, isFalse);
      expect(match('do not disturb on')!.dndEnabled, isTrue);
      expect(match('do not disturb off')!.dndEnabled, isFalse);
    });

    test('toggle is deferred to the current state', () {
      final command = match('toggle do not disturb')!;
      expect(command.toggleDnd, isTrue);
      expect(command.needsCurrentState, isTrue);
      // Unknown state: no request, so nothing can be flipped blindly.
      expect(command.resolve(null), isNull);
      expect(
        command.resolve(fakeDeviceControlStatus(dndEnabled: false))!.dndEnabled,
        isTrue,
      );
      expect(
        command.resolve(fakeDeviceControlStatus(dndEnabled: true))!.dndEnabled,
        isFalse,
      );
    });
  });

  group('brightness', () {
    test('a percentage becomes an absolute request', () {
      final command = match('set brightness to 40%')!;
      expect(command.action, DeviceAction.setBrightness);
      expect(command.brightness, closeTo(0.4, 0.0001));
      expect(command.resolve(null)!.brightness, closeTo(0.4, 0.0001));
    });

    test('maximum and minimum map to the ends of the range', () {
      expect(match('maximum brightness')!.brightness, 1.0);
      expect(match('minimum brightness')!.brightness, 0.0);
    });

    test('brighter and dimmer are relative, clamped to the range', () {
      final brighter = match('brighter')!;
      expect(brighter.brightnessDelta, greaterThan(0));
      expect(brighter.needsCurrentState, isTrue);
      // 255 is already full: the relative bump must not exceed 1.0.
      expect(brighter.resolve(fakeDeviceControlStatus(brightness: 255))!.brightness, 1.0);

      final dimmer = match('dim the screen')!;
      expect(dimmer.brightnessDelta, lessThan(0));
      expect(dimmer.resolve(fakeDeviceControlStatus(brightness: 0))!.brightness, 0.0);
    });
  });

  group('media', () {
    test('transport phrases map to the four actions', () {
      expect(match('pause the music')!.action, DeviceAction.mediaPause);
      expect(match('resume')!.action, DeviceAction.mediaPlay);
      expect(match('next track')!.action, DeviceAction.mediaNext);
      expect(match('previous track')!.action, DeviceAction.mediaPrevious);
      expect(match('skip this song')!.action, DeviceAction.mediaNext);
      expect(match('go back a track')!.action, DeviceAction.mediaPrevious);
    });
  });

  group('wifi and bluetooth honesty', () {
    test('a toggle request becomes a deep link with the Android reason', () {
      for (final phrase in <String>[
        'turn on wifi',
        'enable bluetooth',
        'turn off wi-fi',
        'disable bluetooth',
      ]) {
        final command = match(phrase)!;
        expect(command.action, DeviceAction.openSettings);
        expect(command.deepLinkOnly, isTrue);
        expect(command.honestNote, isNotEmpty);
      }
      expect(match('turn on wifi')!.panel, DeviceSettingsPanel.wifi);
      expect(match('enable bluetooth')!.panel, DeviceSettingsPanel.bluetooth);
      expect(match('turn on wifi')!.honestNote, contains('Android 10'));
      expect(match('enable bluetooth')!.honestNote, contains('Android 12'));
    });

    test('an explicit "open Wi-Fi settings" needs no lecture', () {
      final command = match('open wifi settings')!;
      expect(command.action, DeviceAction.openSettings);
      expect(command.panel, DeviceSettingsPanel.wifi);
      expect(command.honestNote, isNull);
    });

    test('the mapper never produces a toggle action', () {
      // There is no action that turns Wi-Fi or Bluetooth on: the absence is the
      // safety property, asserted rather than assumed.
      final ids = DeviceAction.values
          .map((DeviceAction a) => a.wireName)
          .toList(growable: false);
      expect(ids.any((String id) => id.contains('wifi')), isFalse);
      expect(ids.any((String id) => id.contains('bluetooth')), isFalse);
    });
  });

  group('refusals', () {
    test('ordinary conversation matches nothing', () {
      for (final phrase in <String>[
        'what is the weather tomorrow',
        'open up about your day',
        'summarise my notifications',
        '',
        '   ',
      ]) {
        expect(match(phrase), isNull, reason: '"$phrase" must not match');
      }
    });

    test('SMS and screen reading have no phrase at all', () {
      expect(match('send a text to Priya'), isNull);
      expect(match('read my screen'), isNull);
      expect(match('tap the button on screen'), isNull);
    });
  });
}
