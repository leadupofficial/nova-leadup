import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/features/reminders/reminder_reconciler.dart';

import '../helpers/fake_reminder_notifications.dart';

/// Reminder reconciliation: the server's list is the source of truth, and the
/// OS's scheduled notifications are brought back in line with it on every load.
/// Broken scheduling used to be invisible, so these tests pin the "future only,
/// stable ids, cancel what is gone" contract.
void main() {
  final now = DateTime(2026, 1, 1, 12);

  NovaReminder reminder(String id, {DateTime? at, bool dismissed = false}) =>
      NovaReminder(id: id, title: 'Call $id', remindAt: at, dismissed: dismissed);

  test('schedules future reminders and cancels notifications that are gone', () async {
    final notifications = FakeReminderNotifications(
      scheduled: <int>{reminderNotificationId('deleted-reminder')},
    );
    addTearDown(notifications.cancelAll);
    final reconciler = ReminderReconciler(
      notifications: notifications,
      now: () => now,
    );

    final result = await reconciler.reconcile(<NovaReminder>[
      reminder('future-a', at: now.add(const Duration(hours: 1))),
      reminder('future-b', at: now.add(const Duration(hours: 2))),
      reminder('past', at: now.subtract(const Duration(minutes: 1))),
      reminder('dismissed', at: now.add(const Duration(hours: 3)), dismissed: true),
      reminder('no-time'),
    ]);

    expect(result.scheduled, 2);
    expect(result.cancelled, 1);
    expect(result.exact, isTrue);
    expect(
      notifications.scheduled,
      <int>{
        reminderNotificationId('future-a'),
        reminderNotificationId('future-b'),
      },
    );
    expect(
      notifications.cancelled,
      <int>[reminderNotificationId('deleted-reminder')],
    );
    expect(
      notifications.scheduledCalls.map((call) => call.body).toList(),
      <String>['Call future-a', 'Call future-b'],
      // The body carries the reminder text, so the notification alone is useful
      // when the app is not running to speak it.
    );
    expect(notifications.initializeCalls, greaterThan(0));
  });

  test('an existing reminder is replaced in place, not cancelled', () async {
    final id = reminderNotificationId('a');
    final notifications = FakeReminderNotifications(scheduled: <int>{id});
    addTearDown(notifications.cancelAll);
    final snoozedTo = now.add(const Duration(hours: 4));
    final reconciler = ReminderReconciler(
      notifications: notifications,
      now: () => now,
    );

    final result = await reconciler.reconcile(<NovaReminder>[
      reminder('a', at: snoozedTo),
    ]);

    expect(result.scheduled, 1);
    expect(result.cancelled, 0);
    expect(notifications.cancelled, isEmpty);
    expect(notifications.scheduledCalls.single.when, snoozedTo);
    expect(notifications.scheduledCalls.single.id, id);
  });

  test('is idempotent, so repeated loads never stack up alarms', () async {
    final notifications = FakeReminderNotifications();
    addTearDown(notifications.cancelAll);
    final reconciler = ReminderReconciler(
      notifications: notifications,
      now: () => now,
    );
    final reminders = <NovaReminder>[
      reminder('a', at: now.add(const Duration(hours: 1))),
    ];

    await reconciler.reconcile(reminders);
    final second = await reconciler.reconcile(reminders);

    expect(second.scheduled, 1);
    expect(second.cancelled, 0);
    expect(notifications.cancelled, isEmpty);
    expect(notifications.scheduled, hasLength(1));
  });

  test('degrades to inexact scheduling when exact alarms are refused', () async {
    final notifications = FakeReminderNotifications(exactAllowed: false);
    addTearDown(notifications.cancelAll);
    final reconciler = ReminderReconciler(
      notifications: notifications,
      now: () => now,
    );

    final result = await reconciler.reconcile(<NovaReminder>[
      reminder('a', at: now.add(const Duration(hours: 1))),
    ]);

    expect(result.exact, isFalse);
    expect(result.scheduled, 1, reason: 'a late reminder beats no reminder');
    expect(notifications.scheduledCalls.single.exact, isFalse);
  });

  test('asks for the exact-alarm permission only when something is due', () async {
    final notifications = FakeReminderNotifications();
    addTearDown(notifications.cancelAll);
    final reconciler = ReminderReconciler(
      notifications: notifications,
      now: () => now,
    );

    final result = await reconciler.reconcile(<NovaReminder>[
      reminder('past', at: now.subtract(const Duration(hours: 1))),
      reminder('dismissed', at: now.add(const Duration(hours: 1)), dismissed: true),
    ]);

    expect(result.scheduled, 0);
    expect(notifications.scheduled, isEmpty);
    expect(
      notifications.permissionRequests,
      0,
      reason: 'a user with no reminders must never see the Alarms settings screen',
    );
  });

  group('notification id', () {
    test('is stable for the same reminder across runs', () {
      expect(reminderNotificationId('rem-1'), reminderNotificationId('rem-1'));
      expect(reminderNotificationId('rem-1'), isNot(reminderNotificationId('rem-2')));
    });

    test('stays inside the range Android accepts', () {
      for (final id in <String>['a', 'b', 'rem-1', '6f1e0b1c-0000-4000-8000-000000000000']) {
        expect(reminderNotificationId(id), greaterThanOrEqualTo(0));
        expect(reminderNotificationId(id), lessThanOrEqualTo(0x7fffffff));
      }
    });
  });
}
