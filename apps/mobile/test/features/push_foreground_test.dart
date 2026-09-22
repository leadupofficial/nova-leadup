import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/notifications/push_messaging.dart';

import '../helpers/fake_reminder_notifications.dart';

/// Android draws a system notification only when the app is backgrounded; with
/// the app open FCM hands the message to `onMessage` and it is the app's job to
/// show it. Measured on the OnePlus 9R: FCM reported the send as accepted, the
/// shade stayed empty while NOVA was in the foreground, and the identical message
/// appeared the moment the app was backgrounded.
void main() {
  test('a foreground push is drawn instead of being dropped', () async {
    final notifications = FakeReminderNotifications();
    final handler = PushForegroundHandler(notifications);

    await handler.handle(
      const RemoteMessage(
        messageId: 'm-1',
        data: <String, dynamic>{'notificationId': 'n-1'},
        notification: RemoteNotification(
          title: 'Call Arun',
          body: 'You have a reminder to call Arun. Would you like to do it now?',
        ),
      ),
    );

    expect(notifications.shownImmediately, hasLength(1));
    expect(notifications.shownImmediately.single.title, 'Call Arun');
    expect(
      notifications.shownImmediately.single.body,
      contains('call Arun'),
    );
  });

  test('falls back to the data payload when there is no notification block', () async {
    final notifications = FakeReminderNotifications();
    final handler = PushForegroundHandler(notifications);

    await handler.handle(
      const RemoteMessage(
        messageId: 'm-2',
        data: <String, dynamic>{'title': 'Pending task', 'body': 'Still open.'},
      ),
    );

    expect(notifications.shownImmediately.single.title, 'Pending task');
    expect(notifications.shownImmediately.single.body, 'Still open.');
  });

  test('a message with nothing to say shows nothing', () async {
    final notifications = FakeReminderNotifications();
    final handler = PushForegroundHandler(notifications);

    await handler.handle(const RemoteMessage(messageId: 'm-3', data: <String, dynamic>{}));

    expect(notifications.shownImmediately, isEmpty);
  });
}
