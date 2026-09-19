import 'dart:async';

import 'package:flutter/services.dart';

import 'device_control_models.dart';

/// The platform boundary for device & system control. Swapped out in tests.
///
/// Mirrors `NotificationAssistantPlatform`: one interface, one Android
/// `MethodChannel` implementation, and an unsupported fallback that reports
/// `supported: false` so the screen explains itself instead of offering controls
/// that could never work.
abstract interface class DeviceControlPlatform {
  /// What this device and this grant state allow.
  Future<DeviceControlStatus> status();

  /// Performs one action and reports exactly what happened.
  ///
  /// Never returns a success it cannot stand behind: an ungranted special access
  /// comes back as [DeviceOutcomeCode.permissionDenied] with the granting panel,
  /// and an unsupported action as [DeviceOutcomeCode.unsupported].
  Future<DeviceOutcome> invoke(DeviceActionRequest request);

  Future<void> dispose();
}

/// Talks to `NovaDeviceControl.kt` over the `nova/device_control` channel,
/// following the same `MethodChannel` shape as the notifications platform.
class MethodChannelDeviceControlPlatform implements DeviceControlPlatform {
  static const MethodChannel _channel = MethodChannel('nova/device_control');

  /// The exact channel name, so a contract test can assert Dart and Kotlin agree.
  static const String channelName = 'nova/device_control';

  @override
  Future<DeviceControlStatus> status() async {
    try {
      final result = await _channel.invokeMethod<dynamic>('status');
      if (result is Map) return DeviceControlStatus.fromMap(result);
      return DeviceControlStatus.unsupported;
    } on MissingPluginException {
      return DeviceControlStatus.unsupported;
    } on PlatformException catch (error) {
      return DeviceControlStatus(supported: true, detail: error.message);
    }
  }

  @override
  Future<DeviceOutcome> invoke(DeviceActionRequest request) async {
    try {
      final result = await _channel.invokeMethod<dynamic>(
        request.method,
        request.platformArguments,
      );
      if (result is Map) return DeviceOutcome.fromMap(result);
      return const DeviceOutcome(
        code: DeviceOutcomeCode.failed,
        message:
            'Android returned no result for that action, so it did not run.',
      );
    } on MissingPluginException {
      return DeviceOutcome.notSupported;
    } on PlatformException catch (error) {
      // The native handler answers a failure as a result, never an exception, so
      // reaching here means the channel itself broke. Say so rather than
      // guessing that the action worked.
      return DeviceOutcome(
        code: DeviceOutcomeCode.failed,
        message: error.message ?? 'Android refused the action.',
      );
    }
  }

  @override
  Future<void> dispose() async {}
}

/// Used on platforms without a native implementation, and in tests.
class UnsupportedDeviceControlPlatform implements DeviceControlPlatform {
  const UnsupportedDeviceControlPlatform();

  @override
  Future<DeviceControlStatus> status() async => DeviceControlStatus.unsupported;

  @override
  Future<DeviceOutcome> invoke(DeviceActionRequest request) async =>
      DeviceOutcome.notSupported;

  @override
  Future<void> dispose() async {}
}
