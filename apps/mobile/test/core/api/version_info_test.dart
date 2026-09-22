import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/version_info.dart';

/// NOVA's build identity, and what it can honestly say about the host device.
///
/// Two properties matter, and both were defects at some point:
///
///  1. **The startup path must not touch a platform channel.** `buildTime` is a `const`, and
///     the version gate reads it during launch — the whole reason `startup.dart` exists is
///     that an awaited channel hung the first frame. Reading a device model there would
///     reintroduce exactly that.
///  2. **A device field that cannot be read is `null`, not a placeholder.** The console
///     renders `null` as "not reported". A real device previously registered with both
///     `platform_version` and `model` null, which left the operator's "Android versions"
///     tile populated only by a synthetic verification row; the fix was to read the real
///     values, not to invent them.
void main() {
  group('build-time identity', () {
    test('is a compile-time constant with no device detail', () {
      // `const`, so the compiler proves no channel call can be on this path.
      const info = NovaVersionInfo.buildTime;
      expect(info.version, isNotEmpty);
      expect(info.platform, anyOf('native', 'web'));
      // Device fields are only available from `current()`, which start-up does not await.
      expect(info.platformVersion, isNull);
      expect(info.model, isNull);
    });

    test('labels itself without device detail', () {
      expect(NovaVersionInfo.buildTime.label, contains('v'));
      expect(NovaVersionInfo.buildTime.label, isNot(contains('null')));
    });
  });

  group('current()', () {
    test('never throws when the device channel is unavailable', () async {
      // In the test environment there is no platform channel behind `device_info_plus`, so
      // this exercises the failure path: the fields are omitted rather than the call
      // blowing up and taking device registration with it.
      final info = await NovaVersionInfo.current();
      expect(info.version, NovaVersionInfo.buildTime.version);
      expect(info.platformVersion, isNull);
      expect(info.model, isNull);
    });

    test('reports a concrete platform name rather than "native"', () async {
      final info = await NovaVersionInfo.current();
      // The constant cannot call `defaultTargetPlatform`, so it says "native"; the value
      // sent to the server must be the real one.
      expect(info.platform, isNot('native'));
      expect(info.platform, isNotEmpty);
    });

    test('does not leak nulls into the label when the device is unknown', () async {
      final info = await NovaVersionInfo.current();
      expect(info.label, isNot(contains('null')));
      expect(info.label, contains(info.platform));
    });
  });

  group('label with device detail', () {
    test('names the OS version and the model when both are known', () {
      const info = NovaVersionInfo(
        version: '1.2.3',
        platform: 'android',
        platformVersion: '14',
        model: 'Pixel 8',
      );
      expect(info.label, 'v1.2.3 (android 14, Pixel 8)');
    });

    test('falls back to the platform alone, never to a placeholder', () {
      const noDevice = NovaVersionInfo(version: '1.2.3', platform: 'android');
      expect(noDevice.label, 'v1.2.3 (android)');
      expect(noDevice.label, isNot(contains('unknown')));
    });
  });

  test('the convenience constant matches the class default', () {
    expect(kAppVersion, NovaVersionInfo.buildTime.version);
  });

  test('kIsWeb and defaultTargetPlatform are consistent with the reported platform', () async {
    final info = await NovaVersionInfo.current();
    if (kIsWeb) {
      expect(info.platform, 'web');
    } else {
      expect(info.platform, isNot('web'));
    }
  });
}
