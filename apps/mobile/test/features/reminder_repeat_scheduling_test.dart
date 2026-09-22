import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/features/reminders/reminder_reconciler.dart';
import 'package:nova_mobile/features/reminders/reminder_sync.dart';

import '../helpers/fake_reminder_notifications.dart';

/// Arming a *repeating* reminder, and leaving a one-shot exactly as it was.
///
/// The mechanism is the one the daily briefing already uses: `zonedSchedule` with
/// `matchDateTimeComponents`, which Android re-arms from its own manifest receiver
/// after each delivery — so the repeat survives the app being killed. A Dart timer
/// cannot: the isolate is suspended and the timer simply does not run (the
/// scheduler in `reminder_sync.dart` says so in its own comment, and it is why the
/// speech half is documented as best-effort).
///
/// The regression guard matters as much as the feature: every existing reminder is
/// a one-shot, and none of them may change shape.
void main() {
  final now = DateTime(2026, 1, 12, 12); // a Monday, midday

  NovaReminder reminder(
    String id, {
    DateTime? at,
    bool dismissed = false,
    String? repeatRule,
  }) => NovaReminder(
    id: id,
    title: 'Call $id',
    remindAt: at,
    dismissed: dismissed,
    repeatRule: NovaRepeatRule.tryParse(repeatRule),
  );

  ReminderReconciler reconcilerFor(FakeReminderNotifications notifications) =>
      ReminderReconciler(notifications: notifications, now: () => now);

  group('a one-shot reminder is scheduled exactly as before', () {
    test('one future one-shot, armed once, with no repeat component', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final at = now.add(const Duration(hours: 2));

      final result = await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('bank', at: at),
      ]);

      expect(result.scheduled, 1);
      expect(
        notifications.repeatingCalls,
        isEmpty,
        reason: 'a reminder with no rule must never acquire one',
      );
      expect(notifications.scheduledCalls.single.id, reminderNotificationId('bank'));
      expect(notifications.scheduledCalls.single.when, at);
      expect(notifications.scheduledCalls.single.body, 'Call bank');
    });

    test('a past one-shot is still skipped entirely', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      final result = await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('past', at: now.subtract(const Duration(minutes: 1))),
      ]);

      expect(result.scheduled, 0);
      expect(notifications.scheduledCalls, isEmpty);
      expect(notifications.repeatingCalls, isEmpty);
    });
  });

  group('a recurring reminder is armed as an OS-level repeat', () {
    test('a weekly rule uses the weekday repeat, not a one-shot', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      final result = await reconcilerFor(notifications).reconcile(<NovaReminder>[
        // Jan 12 2026 is a Monday, so the stored trigger and the rule agree.
        reminder('bins', at: DateTime(2026, 1, 12, 18), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);

      expect(result.scheduled, 1);
      expect(
        notifications.scheduledCalls,
        isEmpty,
        reason: 'a one-shot fires once and stops — that is the defect being fixed',
      );
      expect(notifications.repeatingCalls.single.repeat, ReminderRepeat.weekly);
      expect(notifications.repeatingCalls.single.firstOccurrence, DateTime(2026, 1, 12, 18));
      expect(notifications.scheduled, <int>{reminderNotificationId('bins')});
    });

    test('a daily rule uses the daily repeat', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('pills', at: now.add(const Duration(hours: 3)), repeatRule: 'FREQ=DAILY'),
      ]);

      expect(notifications.repeatingCalls.single.repeat, ReminderRepeat.daily);
    });

    test('a monthly rule uses the day-of-month repeat', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('rent', at: DateTime(2026, 2, 1, 10), repeatRule: 'FREQ=MONTHLY;BYMONTHDAY=1'),
      ]);

      expect(notifications.repeatingCalls.single.repeat, ReminderRepeat.monthly);
    });

    test('a trigger that has already gone by rolls forward to the next occurrence', () async {
      // The row's trigger_at is only the *first* time it goes off, and nothing
      // server-side advances it. Without this the alarm would be armed in the past.
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      final result = await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 5, 9), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);

      expect(result.scheduled, 1);
      expect(
        notifications.repeatingCalls.single.firstOccurrence,
        DateTime(2026, 1, 19, 9),
        reason: 'the 12th went by at 09:00, so the next Monday is the 19th',
      );
      expect(notifications.repeatingCalls.single.firstOccurrence.isAfter(now), isTrue);
    });

    test('a rule whose weekday the trigger does not sit on repeats on the rule\'s day', () async {
      // "Make my Monday reminder repeat every Tuesday": the row still carries a
      // Monday trigger. Arming `dayOfWeekAndTime` at that instant would repeat on
      // Mondays, which is the opposite of what was asked.
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('standup', at: DateTime(2026, 1, 12, 9), repeatRule: 'FREQ=WEEKLY;BYDAY=TU'),
      ]);

      final first = notifications.repeatingCalls.single.firstOccurrence;
      expect(first.weekday, DateTime.tuesday);
      expect(first, DateTime(2026, 1, 13, 9));
    });

    test('re-reconciling replaces the alarm instead of stacking another', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = reconcilerFor(notifications);
      final list = <NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ];

      await reconciler.reconcile(list);
      final second = await reconciler.reconcile(list);
      await reconciler.reconcile(list);

      expect(second.scheduled, 1);
      expect(second.cancelled, 0);
      expect(notifications.cancelled, isEmpty);
      expect(
        notifications.scheduled,
        hasLength(1),
        reason: 'the id is derived from the reminder, so a repeat pass replaces it',
      );
      expect(notifications.repeatingCalls, hasLength(3));
      expect(
        notifications.repeatingCalls.map((call) => call.id).toSet(),
        <int>{reminderNotificationId('bins')},
      );
    });

    test('a snooze moves the repeating alarm rather than adding one', () async {
      // Snoozing a recurring reminder rewrites trigger_at; the next occurrence is
      // computed from the rule, so the alarm moves and the old one is replaced.
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = reconcilerFor(notifications);

      await reconciler.reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);
      await reconciler.reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 19, 8), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);

      expect(notifications.repeatingCalls, hasLength(2));
      expect(notifications.repeatingCalls.last.firstOccurrence, DateTime(2026, 1, 19, 8));
      expect(notifications.scheduled, hasLength(1));
    });
  });

  group('a recurring reminder stops recurring', () {
    test('dismissing it cancels the repeating alarm', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = reconcilerFor(notifications);

      await reconciler.reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);
      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18), dismissed: true, repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);

      expect(result.scheduled, 0);
      expect(result.cancelled, 1);
      expect(notifications.cancelled, <int>[reminderNotificationId('bins')]);
      expect(
        notifications.scheduled,
        isEmpty,
        reason: 'an OS repeat outlives the app, so dismissing it has to cancel it',
      );
    });

    test('clearing the rule leaves exactly one one-shot alarm behind', () async {
      // The user asked for a one-off. The id is unchanged, so the repeat is
      // replaced by a single-shot schedule rather than living on beside it.
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = reconcilerFor(notifications);

      await reconciler.reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);
      await reconciler.reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18)),
      ]);

      expect(notifications.repeatingCalls, hasLength(1));
      expect(notifications.scheduledCalls, hasLength(1));
      expect(notifications.scheduled, <int>{reminderNotificationId('bins')});
      expect(notifications.cancelled, isEmpty);
    });

    test('switching notifications off cancels a repeating alarm too', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
        deliveryEnabled: () => false,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
      ]);

      expect(result.scheduled, 0);
      expect(notifications.repeatingCalls, isEmpty);
    });
  });

  group('a rule the OS cannot repeat is reported, not silently mis-scheduled', () {
    test('an interval rule is armed as its next single occurrence', () async {
      // `flutter_local_notifications` has no interval component: `time`,
      // `dayOfWeekAndTime` and `dayOfMonthAndTime` all repeat at their own
      // frequency. Repeating a "every 3 days" rule daily would be worse than
      // arming one correct alarm, so the next occurrence is armed once and the
      // loss is counted on the result — the same shape as `exact` and
      // `notificationsBlocked`.
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      final result = await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('plants', at: DateTime(2026, 1, 12, 9), repeatRule: 'FREQ=DAILY;INTERVAL=3'),
      ]);

      expect(result.scheduled, 1);
      expect(result.notRepeating, 1);
      expect(notifications.repeatingCalls, isEmpty);
      expect(notifications.scheduledCalls.single.when, DateTime(2026, 1, 15, 9));
    });

    test('the count is zero when every rule repeats on its own', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);

      final result = await reconcilerFor(notifications).reconcile(<NovaReminder>[
        reminder('bins', at: DateTime(2026, 1, 12, 18), repeatRule: 'FREQ=WEEKLY;BYDAY=MO'),
        reminder('bank', at: now.add(const Duration(hours: 1))),
      ]);

      expect(result.notRepeating, 0);
    });
  });

  group('a recurring reminder is still spoken while the app is open', () {
    test('a trigger that has gone by is spoken at its next occurrence', () async {
      // The speaking half is best-effort by design — a Dart timer cannot run while
      // the isolate is suspended, which is why the OS repeat is what makes a
      // recurring reminder arrive with the app closed. While the app *is* open,
      // though, a recurring reminder must behave like the one-shot one it used to
      // be: the old filter skipped anything whose stored trigger was in the past,
      // which for a repeat is every occurrence after the first.
      final spoken = <String>[];
      final scheduler = ReminderSpeechScheduler(
        (reminder) async => spoken.add(reminder.id),
        now: () => DateTime(2026, 1, 7, 8, 59, 59, 970),
      );
      addTearDown(scheduler.cancel);

      scheduler.arm(<NovaReminder>[
        // Due in 30ms: the daily rule's next occurrence after the frozen clock.
        NovaReminder(
          id: 'plants',
          title: 'Water the plants',
          remindAt: DateTime(2026, 1, 5, 9),
          repeatRule: NovaRepeatRule.tryParse('FREQ=DAILY'),
        ),
      ]);

      await Future<void>.delayed(const Duration(milliseconds: 300));

      expect(spoken, <String>['plants']);
    });

    test('a one-shot whose trigger has gone by is still left alone', () async {
      final spoken = <String>[];
      final scheduler = ReminderSpeechScheduler(
        (reminder) async => spoken.add(reminder.id),
        now: () => DateTime(2026, 1, 7, 9),
      );
      addTearDown(scheduler.cancel);

      scheduler.arm(<NovaReminder>[
        NovaReminder(id: 'bank', title: 'Call the bank', remindAt: DateTime(2026, 1, 5, 9)),
      ]);

      await Future<void>.delayed(const Duration(milliseconds: 100));

      expect(spoken, isEmpty);
    });
  });
}
