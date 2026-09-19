import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'notification_models.dart';

/// Whether Notification Access is granted and the native listener is bound.
@immutable
class NotificationAssistantStatus {
  const NotificationAssistantStatus({
    required this.supported,
    required this.accessGranted,
    required this.listenerConnected,
    this.detail,
  });

  /// False on every platform without a native implementation, and on Android
  /// when the channel is missing (a unit-test process, for example).
  final bool supported;

  /// Whether NOVA is the (or a) granted notification listener. Android's
  /// Notification Access screen is the only place this can be changed; an app
  /// cannot grant itself this.
  final bool accessGranted;

  /// Whether the service is actually bound right now.
  final bool listenerConnected;

  final String? detail;

  static const NotificationAssistantStatus unsupported =
      NotificationAssistantStatus(
        supported: false,
        accessGranted: false,
        listenerConnected: false,
        detail: 'Notification monitoring is implemented for Android only.',
      );

  factory NotificationAssistantStatus.fromMap(Map<dynamic, dynamic> map) {
    return NotificationAssistantStatus(
      supported: map['supported'] != false,
      accessGranted: map['accessGranted'] == true,
      listenerConnected: map['connected'] == true,
      detail: map['detail']?.toString(),
    );
  }

  /// A sentence for the settings screen.
  String get userMessage {
    if (!supported) {
      return detail ?? 'Notification monitoring is not available on this build.';
    }
    if (!accessGranted) {
      return 'Notification Access is not granted. NOVA cannot read any '
          'notification until you grant it in Android Settings.';
    }
    return listenerConnected
        ? 'Notification Access is granted.'
        : 'Notification Access is granted; NOVA is connecting to the listener.';
  }

  @override
  bool operator ==(Object other) =>
      other is NotificationAssistantStatus &&
      other.supported == supported &&
      other.accessGranted == accessGranted &&
      other.listenerConnected == listenerConnected;

  @override
  int get hashCode => Object.hash(supported, accessGranted, listenerConnected);
}

/// Something the native listener pushed up.
sealed class NotificationAssistantEvent {
  const NotificationAssistantEvent();
}

/// A notification whose package passed the native package-level checks and is
/// already on the user's allowlist. Content is present; the Dart filter still
/// re-applies every rule.
class NotificationCaptured extends NotificationAssistantEvent {
  const NotificationCaptured(this.notification);

  final CapturedNotification notification;
}

/// An app posted a notification while the assistant was on, and that app is not
/// blocked. Package name and label only — no content, ever. Shown so the user
/// can decide whether to allow it.
class NotificationAppSeen extends NotificationAssistantEvent {
  const NotificationAppSeen({required this.packageName, required this.label});

  final String packageName;
  final String label;
}

/// Platform boundary for the notification listener. Swapped out in tests.
abstract interface class NotificationAssistantPlatform {
  Future<NotificationAssistantStatus> status();

  /// Opens Android's Notification Access screen. The user grants or revokes
  /// there; NOVA can never do it for them.
  Future<bool> openAccessSettings();

  /// The listener's events. Empty on unsupported platforms.
  Stream<NotificationAssistantEvent> get events;

  Future<void> dispose();
}

/// Talks to `NovaNotificationListenerService.kt` over the `nova/notifications`
/// channels, following the same `MethodChannel` + `EventChannel` shape as
/// `wake_word_service.dart`.
class MethodChannelNotificationAssistantPlatform
    implements NotificationAssistantPlatform {
  static const MethodChannel _methodChannel = MethodChannel('nova/notifications');
  static const EventChannel _eventChannel = EventChannel(
    'nova/notifications/events',
  );

  /// The exact channel names, so a test can assert Dart and Kotlin agree.
  static const String methodChannelName = 'nova/notifications';
  static const String eventChannelName = 'nova/notifications/events';

  Stream<NotificationAssistantEvent>? _events;

  @override
  Stream<NotificationAssistantEvent> get events {
    return _events ??= _eventChannel
        .receiveBroadcastStream()
        .map(_decode)
        .where((NotificationAssistantEvent? event) => event != null)
        .cast<NotificationAssistantEvent>()
        // A missing plugin (unit tests, non-Android) delivers an error to the
        // stream rather than throwing from `listen`. It must not fail the
        // controller, and it must never be retried into a hot loop.
        .handleError((Object error) {
          if (kDebugMode) {
            debugPrint('[Notifications] event channel closed: $error');
          }
        });
  }

  @override
  Future<NotificationAssistantStatus> status() async {
    try {
      final result = await _methodChannel.invokeMethod<dynamic>('status');
      if (result is Map) return NotificationAssistantStatus.fromMap(result);
      return NotificationAssistantStatus.unsupported;
    } on MissingPluginException {
      return NotificationAssistantStatus.unsupported;
    } on PlatformException catch (error) {
      return NotificationAssistantStatus(
        supported: true,
        accessGranted: false,
        listenerConnected: false,
        detail: error.message,
      );
    }
  }

  @override
  Future<bool> openAccessSettings() async {
    try {
      return await _methodChannel.invokeMethod<bool>('openAccessSettings') ??
          false;
    } on MissingPluginException {
      return false;
    } on PlatformException catch (error) {
      if (kDebugMode) {
        debugPrint('[Notifications] could not open settings: ${error.message}');
      }
      return false;
    }
  }

  @override
  Future<void> dispose() async {
    _events = null;
  }

  NotificationAssistantEvent? _decode(dynamic raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    switch (map['type']) {
      case 'notification':
        return NotificationCaptured(CapturedNotification.fromPlatform(map));
      case 'app_seen':
        final packageName = (map['package'] ?? '').toString();
        if (packageName.isEmpty) return null;
        final label = (map['label'] ?? '').toString();
        return NotificationAppSeen(
          packageName: packageName,
          label: label.isEmpty ? packageName : label,
        );
      default:
        return null;
    }
  }
}

/// Used on platforms without a native implementation, and in tests.
class UnsupportedNotificationAssistantPlatform
    implements NotificationAssistantPlatform {
  const UnsupportedNotificationAssistantPlatform();

  @override
  Future<NotificationAssistantStatus> status() async =>
      NotificationAssistantStatus.unsupported;

  @override
  Future<bool> openAccessSettings() async => false;

  @override
  Stream<NotificationAssistantEvent> get events =>
      const Stream<NotificationAssistantEvent>.empty();

  @override
  Future<void> dispose() async {}
}
