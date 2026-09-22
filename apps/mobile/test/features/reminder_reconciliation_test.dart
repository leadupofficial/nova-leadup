import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/features/briefing/briefing_reconciler.dart';
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
    expect(
      notifications.interactiveRequests,
      0,
      reason: 'reconciliation must never open a system settings screen',
    );
  });

  group('the notification switch', () {
    test('cancels everything armed when notifications are switched off', () async {
      // Profile → Notifications stores "Device notifications" and "In-app
      // notifications" on the account, and nothing consulted them: reminders are a
      // local alarm, so one set before the user turned the switch off would still
      // fire. Cancelling what is already armed — not merely declining to schedule —
      // is the point.
      final notifications = FakeReminderNotifications(
        scheduled: <int>{
          reminderNotificationId('already-armed'),
          reminderNotificationId('another'),
        },
      );
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
        deliveryEnabled: () => false,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('future', at: now.add(const Duration(hours: 2))),
      ]);

      expect(result.scheduled, 0);
      expect(result.cancelled, 2);
      expect(notifications.scheduled, isEmpty);
      expect(notifications.scheduledCalls, isEmpty);
    });

    test('still schedules while the switch is on', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
        deliveryEnabled: () => true,
      );

      await reconciler.reconcile(<NovaReminder>[
        reminder('future', at: now.add(const Duration(hours: 2))),
      ]);

      expect(notifications.scheduledCalls, hasLength(1));
    });

    test('defaults to delivering, so an untouched account never goes silent', () async {
      // A device whose cache was cleared by a reinstall has no stored answer. Failing
      // closed there would silently stop every reminder.
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      await reconciler.reconcile(<NovaReminder>[
        reminder('future', at: now.add(const Duration(hours: 2))),
      ]);

      expect(notifications.scheduledCalls, hasLength(1));
    });
  });

  test(
    'reconciliation checks exact alarms but never opens the system screen',
    () async {
      // Play's restricted-permission policy for SCHEDULE_EXACT_ALARM: the app must
      // direct the user to the special-access screen rather than throwing them into
      // it. Reconciliation runs on load, on change and on resume — i.e. in the
      // background from the user's point of view — so it may *read* the permission
      // and degrade to inexact scheduling, but it must not *request* one.
      final notifications = FakeReminderNotifications(exactAllowed: false);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      await reconciler.reconcile(<NovaReminder>[
        reminder('due', at: now.add(const Duration(minutes: 5))),
      ]);

      expect(notifications.permissionRequests, greaterThan(0),
          reason: 'it still needs to know whether exact alarms are available');
      expect(
        notifications.interactiveRequests,
        0,
        reason: 'only the Reminders screen may open the "Alarms & reminders" screen, '
            'and only after its own disclosure',
      );
      // The reminder is still armed, just not exactly.
      expect(notifications.scheduledCalls, isNotEmpty);
      expect(notifications.scheduledCalls.every((call) => call.exact), isFalse);
    },
  );

  group('the OS notification permission', () {
    /// The defect this group exists for: a denied `POST_NOTIFICATIONS` made
    /// Android discard every reminder notification at post time while
    /// `AlarmManager` kept the alarm and the reconciler kept reporting
    /// `scheduled: N`. Nothing in the result said the user would hear nothing —
    /// the reminder path's only gate was the *in-app* Profile → Notifications
    /// preference, which is a different thing.
    test('a denied permission is reported on the result', () async {
      final notifications = FakeReminderNotifications(osAllowed: false);
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('due', at: now.add(const Duration(hours: 1))),
      ]);

      expect(
        result.notificationsBlocked,
        isTrue,
        reason:
            "the caller must be able to say Android is blocking NOVA's "
            'notifications, so your reminders cannot reach you',
      );
      expect(
        notifications.osPermissionReads,
        greaterThan(0),
        reason: 'the answer has to come from the real OS permission state',
      );
      // The alarm is still armed. Scheduling it is not the broken half — Android
      // discards the notification at delivery — so the count stays truthful and
      // the flag is what carries the news.
      expect(result.scheduled, 1);
    });

    test('a granted permission reports nothing blocked', () async {
      final notifications = FakeReminderNotifications(osAllowed: true);
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('due', at: now.add(const Duration(hours: 1))),
      ]);

      expect(result.notificationsBlocked, isFalse);
    });

    test('a granted permission leaves the existing scheduled behaviour unchanged', () async {
      // The regression guard for the fix: adding the permission read must not
      // change what a healthy pass does — same count, same ids, same bodies, same
      // exactness, and no extra cancels.
      final notifications = FakeReminderNotifications(
        exactAllowed: false,
        osAllowed: true,
        scheduled: <int>{reminderNotificationId('deleted')},
      );
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('a', at: now.add(const Duration(hours: 1))),
        reminder('b', at: now.add(const Duration(hours: 2))),
        reminder('past', at: now.subtract(const Duration(minutes: 1))),
      ]);

      expect(result.scheduled, 2);
      expect(result.cancelled, 1);
      expect(result.exact, isFalse);
      expect(result.notificationsBlocked, isFalse);
      expect(
        notifications.scheduled,
        <int>{
          reminderNotificationId('a'),
          reminderNotificationId('b'),
        },
      );
      expect(
        notifications.cancelled,
        <int>[reminderNotificationId('deleted')],
      );
      expect(
        notifications.scheduledCalls.map((call) => call.body).toList(),
        <String>['Call a', 'Call b'],
      );
      expect(
        notifications.scheduledCalls.every((call) => call.exact),
        isFalse,
        reason: 'the exact-alarm degradation is untouched by this change',
      );
    });

    test('reconciliation reads the permission but never prompts for it', () async {
      // Reconciliation runs on load, on change and on resume — i.e. in the
      // background from the user's point of view. It may know the answer; asking
      // for it is the reminders screen's job, after its own disclosure.
      final notifications = FakeReminderNotifications(osAllowed: false);
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      await reconciler.reconcile(<NovaReminder>[
        reminder('due', at: now.add(const Duration(hours: 1))),
      ]);

      expect(notifications.osPermissionReads, greaterThan(0));
      expect(
        notifications.settingsOpened,
        0,
        reason: 'a background pass must never throw the user into system settings',
      );
    });

    test('the blocked flag is reported even when nothing was armed', () async {
      // Unlike `exact`, this is not evidence-based on a schedule succeeding: the
      // permission is readable whether or not anything is due, and hearing
      // "reminders cannot reach you" on a pass that armed nothing is still true.
      final notifications = FakeReminderNotifications(osAllowed: false);
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('past', at: now.subtract(const Duration(hours: 1))),
      ]);

      expect(result.scheduled, 0);
      expect(result.notificationsBlocked, isTrue);
    });

    test('the notifications switch off path also reports it', () async {
      // The early return when the user has switched delivery off must not lose the
      // OS answer: the two are separate facts and the screen shows both.
      final notifications = FakeReminderNotifications(osAllowed: false);
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
        deliveryEnabled: () => false,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('due', at: now.add(const Duration(hours: 1))),
      ]);

      expect(result.scheduled, 0);
      expect(result.notificationsBlocked, isTrue);
    });
  });

  group('N-07 — only ever cancels the notifications it owns', () {
    test('leaves the daily briefing alarm armed', () async {
      // The briefing schedules its repeating alarm through the same plugin and the
      // same seam — `reminder_notifications.dart` documents that as deliberate, so
      // the app has one plugin, one timezone database and one permission check.
      // The consequence was not: `scheduledIds()` answered with *every* pending id
      // and the reminder reconciler cancelled all it did not recognise, so the
      // briefing alarm was destroyed on every reminder sync and re-created on the
      // next briefing pass. A comment claimed "the two features cannot collide";
      // nothing enforced it.
      final notifications = FakeReminderNotifications(
        scheduled: <int>{
          BriefingReconciler.notificationId,
          reminderNotificationId('deleted-reminder'),
        },
      );
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      await reconciler.reconcile(<NovaReminder>[
        reminder('future', at: now.add(const Duration(hours: 1))),
      ]);

      expect(
        notifications.cancelled,
        <int>[reminderNotificationId('deleted-reminder')],
        reason: 'a reconciler may only cancel ids inside its own band',
      );
      expect(
        notifications.scheduled,
        contains(BriefingReconciler.notificationId),
      );
    });

    test('switching delivery off does not reach into another owner', () async {
      final notifications = FakeReminderNotifications(
        scheduled: <int>{
          BriefingReconciler.notificationId,
          reminderNotificationId('armed'),
        },
      );
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
        deliveryEnabled: () => false,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('future', at: now.add(const Duration(hours: 1))),
      ]);

      expect(result.cancelled, 1);
      expect(
        notifications.scheduled,
        contains(BriefingReconciler.notificationId),
      );
      expect(notifications.cancelled, isNot(contains(BriefingReconciler.notificationId)));
    });
  });

  group('N-02 — an incomplete list is never evidence of a deletion', () {
    test('cancels nothing when the list is known to be partial', () async {
      final notifications = FakeReminderNotifications(
        scheduled: <int>{reminderNotificationId('on-a-page-nobody-fetched')},
      );
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(
        <NovaReminder>[reminder('future', at: now.add(const Duration(hours: 1)))],
        complete: false,
      );

      expect(result.incomplete, isTrue);
      expect(result.cancelled, 0);
      expect(
        notifications.cancelled,
        isEmpty,
        reason:
            'a reminder that is merely on a page nobody fetched is not a reminder '
            'that was deleted',
      );
      // The page that did load is still worth arming from.
      expect(result.scheduled, 1);
    });

    test('the same list cancels normally once it is complete', () async {
      final notifications = FakeReminderNotifications(
        scheduled: <int>{reminderNotificationId('on-a-page-nobody-fetched')},
      );
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('future', at: now.add(const Duration(hours: 1))),
      ]);

      expect(result.incomplete, isFalse);
      expect(result.cancelled, 1);
    });

    test('switching delivery off still cancels a partial list', () async {
      // The one cancellation that is not an inference from absence: the user has
      // said they do not want device notifications, so an armed alarm must go even
      // if the list could not be read in full.
      final notifications = FakeReminderNotifications(
        scheduled: <int>{reminderNotificationId('armed')},
      );
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
        deliveryEnabled: () => false,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('future', at: now.add(const Duration(hours: 1))),
      ], complete: false);

      expect(result.incomplete, isTrue);
      expect(result.cancelled, 1);
      expect(notifications.scheduled, isEmpty);
    });
  });

  group('N-07 — a notification id collision is reported, not merged', () {
    test('two reminders sharing an id keep the sooner alarm and count the loss', () async {
      // Brute-forced against the id hash below: these two strings share a 30-bit
      // payload, so they share a notification id. The space is finite and the ids
      // are arbitrary, so this is reachable; what must not happen is one reminder
      // quietly overwriting the other with nothing said.
      const first = 'ccabeac';
      const second = 'adeecbbb';
      expect(
        reminderNotificationId(first),
        reminderNotificationId(second),
        reason: 'the fixture only proves anything while these two still collide',
      );

      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder(second, at: now.add(const Duration(hours: 2))),
        reminder(first, at: now.add(const Duration(minutes: 30))),
      ]);

      expect(result.collisions, 1);
      expect(result.scheduled, 1);
      expect(
        notifications.scheduledCalls.single.body,
        'Call $first',
        reason: 'the alarm that is due first is the one worth having',
      );
    });

    test('no collision is reported when every id is distinct', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = ReminderReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(<NovaReminder>[
        reminder('a', at: now.add(const Duration(hours: 1))),
        reminder('b', at: now.add(const Duration(hours: 2))),
      ]);

      expect(result.collisions, 0);
      expect(result.scheduled, 2);
    });
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
