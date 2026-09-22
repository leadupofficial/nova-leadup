import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/core/api/nova_api.dart';
import 'package:nova_mobile/features/notifications/push_messaging.dart';

import '../helpers/fake_reminder_notifications.dart';

/// Android draws a system notification only when the app is backgrounded; with
/// the app open FCM hands the message to `onMessage` and it is the app's job to
/// show it. Measured on the OnePlus 9R: FCM reported the send as accepted, the
/// shade stayed empty while NOVA was in the foreground, and the identical message
/// appeared the moment the app was backgrounded.
void main() {
  _inboxTests();
  _unreadCountTests();

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

/// The bell showed a hardcoded `0` and the inbox did not exist, so a nudge lived
/// only in the system shade. These pin the model and the refresh contract.
void _inboxTests() {
  test('parses a server notification row, payload included', () {
    final n = NovaNotification.fromJson(<String, dynamic>{
      'id': 'n-1',
      'title': 'Call Arun',
      'body': 'You have a reminder.',
      'type': 'warning',
      'read': false,
      'payload': {'category': 'reminder', 'actionUrl': '/reminders'},
      'occurredAt': '2026-09-23T03:30:00.000Z',
    });

    expect(n.id, 'n-1');
    expect(n.title, 'Call Arun');
    expect(n.read, isFalse);
    // Both live inside `payload`, which is where the API actually puts them.
    expect(n.category, 'reminder');
    expect(n.actionUrl, '/reminders');
    expect(n.occurredAt, isNotNull);
  });

  test('reads a row that is already marked read', () {
    final n = NovaNotification.fromJson(<String, dynamic>{
      'id': 'n-2',
      'title': 'Briefing',
      'body': 'Three things today.',
      'type': 'info',
      'read': true,
    });

    expect(n.read, isTrue);
    expect(n.category, isNull);
  });

  test('a missing payload does not throw', () {
    final n = NovaNotification.fromJson(<String, dynamic>{'id': 'n-3'});
    expect(n.title, '');
    expect(n.category, isNull);
  });

  test('a foreground push asks the inbox to refresh', () async {
    final notifications = FakeReminderNotifications();
    var refreshes = 0;
    final handler = PushForegroundHandler(
      notifications,
      onPush: () => refreshes++,
    );

    await handler.handle(
      const RemoteMessage(
        messageId: 'm-9',
        notification: RemoteNotification(title: 'Call Arun', body: 'Now?'),
      ),
    );

    expect(refreshes, 1);
  });
}

/// The bell is the only place a user sees that something is waiting. `_get`
/// unwraps the `{success, data}` envelope, so the payload arrives as `{count: N}`
/// — reading `data['data']` returned null on every call and the badge stayed
/// empty on the device even though the server held a real count.
void _unreadCountTests() {
  test('reads the count from the unwrapped payload', () {
    expect(parseUnreadCount(<String, dynamic>{'count': 3}), 3);
  });

  test('still reads it if the raw envelope is handed over', () {
    expect(
      parseUnreadCount(<String, dynamic>{
        'success': true,
        'data': {'count': 2},
      }),
      2,
    );
  });

  test('answers zero for shapes it does not understand, without throwing', () {
    expect(parseUnreadCount(null), 0);
    expect(parseUnreadCount(<String, dynamic>{}), 0);
    expect(parseUnreadCount(<String, dynamic>{'count': 'nonsense'}), 0);
  });
}
