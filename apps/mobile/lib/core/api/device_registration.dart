/// NOVA — Device registration.
///
/// The server's `devices` table had **no writer at all**: it existed in the canonical schema
/// and nothing ever inserted into it. That is why the console's device list, app-version
/// adoption and OS-version views were empty, and why a force-update decision had no data to
/// target — a missing writer, not a rendering problem.
///
/// This is the client half: one call after a session exists, reporting the platform, OS
/// version, device model and app version.
///
/// Three deliberate choices:
///
///  * **Registration failure is never fatal.** It is telemetry for the operator. A device that
///    cannot report itself must still be able to use NOVA, so every error is swallowed and
///    logged rather than surfaced.
///  * **An `installationId` identifies the install, not the launch.** It is generated once and
///    kept in `SharedPreferences`, so re-registering updates the same server row on every
///    launch instead of appending a new one. Without it the inventory would grow by one row
///    per app start and be useless.
///  * **Nothing is fabricated.** The app has no `device_info_plus` dependency, so the device
///    model and OS version are reported as `null` rather than invented. `defaultTargetPlatform`
///    and the compile-time version are real values, and those are sent.
///
/// The endpoint requires authentication, so this runs when there is an access token — after
/// sign-in and on resume while signed in.
library;

import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../app/providers.dart';
import '../../config/api_config.dart';
import '../api/version_info.dart';

/// The registration endpoint. Derived from the shared base URL so an `--dart-define`
/// override applies here as it does everywhere else.
String get deviceRegisterEndpoint => '${ApiConfig.baseUrl}/api/v1/device/register';

/// The preference key holding this install's stable identifier.
///
/// Exposed so a test can seed it, and so a future "forget this device" action knows what to
/// clear.
const String kInstallationIdPreferenceKey = 'nova_installation_id';

/// Generates an installation id once and keeps it.
///
/// Not a platform identifier: it is randomly generated and stored locally, so it cannot be
/// used to correlate a device across apps or across a reinstall. It exists only so the server
/// can update one row rather than insert a new one per launch.
Future<String> installationId(SharedPreferences prefs) async {
  final existing = prefs.getString(kInstallationIdPreferenceKey);
  if (existing != null && existing.length >= 8) return existing;

  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  final generated = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  await prefs.setString(kInstallationIdPreferenceKey, generated);
  return generated;
}

/// What the client reports about itself.
///
/// `model` and `platformVersion` stay nullable because reading them can fail, on a platform
/// this build does not support, or on a ROM that reports `unknown`. The server accepts a
/// partial report rather than losing the device entirely, and the console shows what arrived
/// instead of filling the gap.
@immutable
class DeviceRegistration {
  const DeviceRegistration({
    required this.installId,
    required this.platform,
    required this.appVersion,
    this.model,
    this.platformVersion,
    this.name,
  });

  /// The install's stable identifier. Named `installId` so it does not shadow the
  /// top-level `installationId(prefs)` helper; the wire field stays `installationId`.
  final String installId;
  final String platform;
  final String appVersion;
  final String? model;
  final String? platformVersion;
  final String? name;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'installationId': installId,
        'platform': platform,
        'appVersion': appVersion,
        if (model != null) 'model': model,
        if (platformVersion != null) 'platformVersion': platformVersion,
        if (name != null) 'name': name,
      };

  /// Builds a report from what the app can honestly observe.
  ///
  /// Named `observe` rather than `current` so it does not shadow the `installationId`
  /// field when calling the top-level helper of the same name.
  static Future<DeviceRegistration> observe(SharedPreferences prefs) async {
    final version = await NovaVersionInfo.current();
    return DeviceRegistration(
      installId: await installationId(prefs),
      platform: version.platform,
      appVersion: version.version,
      // Reported when the platform can tell us, and omitted when it cannot. The server
      // stores null, and the console renders "not reported" — the alternative, a
      // placeholder, would put a fabricated handset in the operator's inventory. Measured
      // before this: a real device registered with `platform_version` and `model` both
      // null, so the console's "Android versions" tile was populated only by a synthetic
      // verification row.
      model: version.model,
      platformVersion: version.platformVersion,
    );
  }
}

/// Outcome of a registration attempt, for logging and tests.
@immutable
class DeviceRegistrationResult {
  const DeviceRegistrationResult({required this.reported, this.deviceId, this.error});

  final bool reported;
  final String? deviceId;
  final String? error;
}

/// Reports this install to the server.
///
/// Never throws. See the module comment.
Future<DeviceRegistrationResult> registerDevice({
  required Dio dio,
  required SharedPreferences prefs,
  required String? accessToken,
}) async {
  if (accessToken == null || accessToken.isEmpty) {
    // The endpoint is authenticated, and a device row with no owner would not answer the
    // question the inventory exists for. Registration happens once a session exists.
    return const DeviceRegistrationResult(reported: false, error: 'no session');
  }

  try {
    final registration = await DeviceRegistration.observe(prefs);
    final response = await dio.post<Map<String, dynamic>>(
      deviceRegisterEndpoint,
      data: registration.toJson(),
      options: Options(
        headers: <String, dynamic>{'Authorization': 'Bearer $accessToken'},
        // Telemetry must not compete with a real request or retry aggressively; a failure is
        // reported once and the next launch tries again.
        sendTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 8),
      ),
    );

    final data = response.data?['data'];
    final deviceId = data is Map ? data['deviceId']?.toString() : null;
    return DeviceRegistrationResult(reported: true, deviceId: deviceId);
  } catch (error) {
    if (kDebugMode) {
      debugPrint('[nova] device registration failed (non-fatal): $error');
    }
    return DeviceRegistrationResult(reported: false, error: error.toString());
  }
}

/// Provider wrapper so the app can fire this without threading dependencies through.
final deviceRegistrationProvider = Provider<Future<DeviceRegistrationResult> Function()>((ref) {
  return () async {
    final prefs = ref.read(sharedPreferencesProvider);
    final token = ref.read(authRepositoryProvider).currentToken?.accessToken;
    return registerDevice(dio: ref.read(dioProvider), prefs: prefs, accessToken: token);
  };
});
