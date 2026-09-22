import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../reminders/reminder_notifications.dart';

/// The FCM registration token for this install.
///
/// This is the address a proactive nudge is sent to. Everything here is
/// best-effort and honest about failure: on a device without Play services, or a
/// build whose Firebase config is wrong, [current] returns null and says why in
/// the log. It never invents a token — a fabricated one would be stored, reported
/// as `hasPushToken: true`, and silently drop every push.
class NovaPush {
  const NovaPush();

  /// Asks for a token, or returns null with a reason.
  ///
  /// `getToken` can hang on a device that cannot reach FCM, so it is bounded: the
  /// caller is registering a device, and a telemetry call must never wedge it.
  Future<String?> current({
    Duration timeout = const Duration(seconds: 12),
  }) async {
    try {
      final messaging = FirebaseMessaging.instance;

      // iOS will not deliver anything until this is answered; on Android 13+ the
      // OS dialog is raised by the permission flow the app already drives, so a
      // refusal here is recorded rather than turned into a second prompt.
      await messaging.requestPermission();

      final token = await messaging.getToken().timeout(timeout);
      if (token == null || token.isEmpty) {
        debugPrint('[NovaPush] FCM returned no token for this install');
        return null;
      }
      return token;
    } catch (error) {
      // A missing Play service, a blocked network or a build whose Firebase config
      // does not match the project all land here. None of them may stop the app.
      debugPrint('[NovaPush] could not obtain an FCM token: $error');
      return null;
    }
  }

  /// Calls [onToken] whenever FCM rotates the token.
  ///
  /// Without this a rotated token is never reported and the device silently stops
  /// receiving anything, which looks exactly like the feature working until the
  /// day it does not.
  StreamSubscription<String>? listenForRefresh(void Function(String token) onToken) {
    try {
      return FirebaseMessaging.instance.onTokenRefresh.listen(
        onToken,
        onError: (Object error) =>
            debugPrint('[NovaPush] token refresh stream failed: $error'),
      );
    } catch (error) {
      debugPrint('[NovaPush] could not subscribe to token refresh: $error');
      return null;
    }
  }
}

/// Shows a push that arrives while the app is in the foreground.
///
/// Android posts a system notification only when the app is backgrounded. With
/// the app open, FCM hands the message to `onMessage` and nothing appears unless
/// the app draws it — measured on the OnePlus 9R: FCM reported the send as
/// accepted, the shade stayed empty with NOVA in the foreground, and the same
/// message appeared immediately once the app was backgrounded.
class PushForegroundHandler {
  PushForegroundHandler(this._notifications, {this.onPush});

  final ReminderNotifications _notifications;

  /// Called once a foreground push has been drawn, so the caller can refresh
  /// whatever lists it — without this the bell keeps the count it fetched at
  /// startup and the new nudge is missing from the inbox until a restart.
  final VoidCallback? onPush;
  StreamSubscription<RemoteMessage>? _subscription;

  /// Notification id for foreground pushes. Fixed so a second push replaces the
  /// first rather than stacking an unbounded list of nudges.
  static const int _notificationId = 900001;

  void start() {
    _subscription ??= FirebaseMessaging.onMessage.listen(
      (message) => unawaited(handle(message)),
      onError: (Object error) {
        debugPrint('[NovaPush] foreground message stream failed: $error');
      },
    );
  }

  /// Draws one message. Public so the behaviour can be tested without Firebase.
  Future<void> handle(RemoteMessage message) async {
    final notification = message.notification;
    final title = notification?.title ?? message.data['title'] as String?;
    final body = notification?.body ?? message.data['body'] as String?;
    if (title == null && body == null) return;
    try {
      await _notifications.showNow(
        id: _notificationId,
        title: title ?? 'NOVA',
        body: body ?? '',
        payload: message.data['notificationId'] as String?,
      );
      onPush?.call();
    } catch (error) {
      debugPrint('[NovaPush] could not show a foreground push: $error');
    }
  }

  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
  }
}
