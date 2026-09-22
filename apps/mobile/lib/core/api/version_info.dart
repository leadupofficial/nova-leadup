/// NOVA — Build version and platform identity.
///
/// The app had **no** way to report its version. The only version string anywhere was
/// a hardcoded `_kBuildLabel = 'v1.0.0'` in the bundled admin page, kept in sync with
/// `pubspec.yaml` **by hand**. That made the version gate impossible to implement and
/// version adoption impossible to measure.
///
/// There are three problems to avoid here:
///
///  1. **A second hand-maintained copy of the version.** [NovaVersionInfo.version] is
///     the single source. Set it at build time with
///     `--dart-define=APP_VERSION=1.2.3`, which CI can take from `pubspec.yaml`, and
///     every caller gets the same value. The default matches the current
///     `pubspec.yaml` (`version: 1.0.0+1`) so an un-stamped local build is honest
///     rather than blank.
///
///  2. **Claiming more device detail than we have.** The device model and OS version come
///     from `device_info_plus`, which reads `android.os.Build.MODEL` /
///     `Build.VERSION.RELEASE` (and the iOS equivalents) with no permission. They are
///     `null` when that call fails, and the console renders them as "not reported" —
///     never as a placeholder. Reporting a fabricated model string would be worse than
///     reporting none: an operator filtering by OS version would be filtering on an
///     invention.
///
///  3. **Making startup depend on a platform channel.** [buildTime] stays a `const` and
///     never touches one; only [current], which the caller already invokes off the
///     critical path (device registration and telemetry), awaits the plugin. `startup.dart`
///     exists because an awaited channel hung the first frame, and the version gate reads
///     [buildTime] for exactly that reason.
library;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';

/// The application's build identity, and what the host device is.
@immutable
class NovaVersionInfo {
  const NovaVersionInfo({
    required this.version,
    required this.platform,
    this.platformVersion,
    this.model,
  });

  /// Semantic version of this build, e.g. `1.0.0`.
  final String version;

  /// `android` | `ios` | `web` | `macos` | `windows` | `linux`.
  final String platform;

  /// OS release, e.g. `14` on Android or `17.4` on iOS. Null when unreadable.
  final String? platformVersion;

  /// Device model, e.g. `Pixel 8`. Null when unreadable.
  final String? model;

  /// `--dart-define=APP_VERSION=1.2.3`, falling back to the pubspec version.
  static const String _buildVersion =
      String.fromEnvironment('APP_VERSION', defaultValue: '1.0.0');

  /// The compile-time constant, without touching a platform channel.
  ///
  /// Deliberately synchronous: the version gate runs during startup, and the whole
  /// reason `startup.dart` exists is that an awaited platform channel hung the first
  /// frame. A version lookup must never be able to do that.
  ///
  /// `platform` on this constant is only `web` or `native` because a `const` cannot
  /// call `defaultTargetPlatform`. Use [current] when the concrete platform name
  /// matters (it is sent to the server purely as diagnostic context), and note that
  /// the device model and OS version are only available from [current].
  static const NovaVersionInfo buildTime = NovaVersionInfo(
    version: _buildVersion,
    platform: kIsWeb ? 'web' : 'native',
  );

  /// Resolves the version, the platform name, and the device's own identity.
  ///
  /// Never throws and never blocks startup: a plugin failure yields `null` for the two
  /// device fields, which the server accepts and the console reports as unknown. The
  /// callers are telemetry (device registration) and diagnostics, neither of which is
  /// worth failing a launch over.
  static Future<NovaVersionInfo> current() async {
    final device = await _deviceIdentity();
    return NovaVersionInfo(
      version: _buildVersion,
      platform: _platformName(),
      platformVersion: device.platformVersion,
      model: device.model,
    );
  }

  /// Reads the model and OS release from the platform, or reports nothing.
  ///
  /// A single implementation for both platforms because the two fields mean the same
  /// thing on each, and because a `try`/`catch` that returns empty values is the honest
  /// answer for every other platform: there is no `device_info` support for desktop
  /// Linux here, and inventing one would put a fabricated row in the operator's
  /// inventory.
  static Future<({String? platformVersion, String? model})> _deviceIdentity() async {
    if (kIsWeb) return (platformVersion: null, model: null);
    try {
      final plugin = DeviceInfoPlugin();
      switch (defaultTargetPlatform) {
        case TargetPlatform.android:
          final info = await plugin.androidInfo;
          return (platformVersion: _clean(info.version.release), model: _clean(info.model));
        case TargetPlatform.iOS:
          final info = await plugin.iosInfo;
          return (platformVersion: _clean(info.systemVersion), model: _clean(info.utsname.machine));
        default:
          return (platformVersion: null, model: null);
      }
    } catch (error) {
      // Logged rather than swallowed silently so a permanently failing plugin is
      // visible in a debug build, while a release build still registers the device.
      debugPrint('[nova] could not read the device identity (non-fatal): $error');
      return (platformVersion: null, model: null);
    }
  }

  /// Trims a platform string, and turns the platform's own "unknown" into nothing.
  ///
  /// Android reports the literal string `unknown` for `Build.MODEL` on some emulators and
  /// cut-down ROMs. Storing that would put a row in the inventory that looks like a real
  /// handset called "unknown"; `null` is rendered as "not reported", which is what it is.
  static String? _clean(String? value) {
    final trimmed = value?.trim();
    if (trimmed == null || trimmed.isEmpty) return null;
    if (trimmed.toLowerCase() == 'unknown') return null;
    return trimmed;
  }

  static String _platformName() {
    if (kIsWeb) return 'web';
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return 'android';
      case TargetPlatform.iOS:
        return 'ios';
      case TargetPlatform.macOS:
        return 'macos';
      case TargetPlatform.windows:
        return 'windows';
      case TargetPlatform.linux:
        return 'linux';
      case TargetPlatform.fuchsia:
        return 'fuchsia';
    }
  }

  /// A short human label, e.g. `v1.0.0 (android 14, Pixel 8)`.
  String get label {
    final os = platformVersion == null ? platform : '$platform $platformVersion';
    return model == null ? 'v$version ($os)' : 'v$version ($os, $model)';
  }

  @override
  String toString() => label;
}

/// Convenience constant for call sites that only need the string.
const String kAppVersion = NovaVersionInfo._buildVersion;
