import 'dart:async';

import 'package:nova_mobile/features/notifications/notification_models.dart';
import 'package:nova_mobile/features/notifications/notification_platform.dart';

/// Scriptable notification-listener transport for tests.
///
/// Nothing here touches a platform channel, so a test can assert exactly what
/// the controller does with a notification without a device.
class FakeNotificationAssistantPlatform implements NotificationAssistantPlatform {
  FakeNotificationAssistantPlatform({
    this.accessGranted = true,
    this.supported = true,
  });

  /// Whether the "user" has granted Notification Access in Android Settings.
  bool accessGranted;

  bool supported;

  int openSettingsCalls = 0;
  int statusCalls = 0;

  final StreamController<NotificationAssistantEvent> _controller =
      StreamController<NotificationAssistantEvent>.broadcast();

  @override
  Future<NotificationAssistantStatus> status() async {
    statusCalls++;
    return NotificationAssistantStatus(
      supported: supported,
      accessGranted: accessGranted,
      listenerConnected: accessGranted,
    );
  }

  @override
  Future<bool> openAccessSettings() async {
    openSettingsCalls++;
    return true;
  }

  @override
  Stream<NotificationAssistantEvent> get events => _controller.stream;

  /// Pushes a notification as if the native listener had let it through.
  void emitNotification(CapturedNotification notification) =>
      _controller.add(NotificationCaptured(notification));

  /// Pushes a package-only discovery event.
  void emitAppSeen(String packageName, String label) =>
      _controller.add(
        NotificationAppSeen(packageName: packageName, label: label),
      );

  @override
  Future<void> dispose() async {
    await _controller.close();
  }
}
