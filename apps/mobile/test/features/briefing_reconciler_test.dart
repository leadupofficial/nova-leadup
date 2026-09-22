import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/briefing/briefing_models.dart';
import 'package:nova_mobile/features/briefing/briefing_reconciler.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

import '../helpers/fake_reminder_notifications.dart';

/// Daily-briefing reconciliation.
///
/// The contract these pin: nothing is armed unless the user opted in, the alarm
/// is a single stable id that is replaced rather than duplicated, a time that
/// has already passed rolls to tomorrow instead of firing immediately, and a
/// refused exact-alarm grant degrades to inexact scheduling rather than to no
/// briefing at all.
void main() {
  final now = DateTime(2026, 1, 1, 12);

  DailyBriefingSettings settings({
    bool enabled = false,
    int hour = 8,
    int minute = 0,
  }) => DailyBriefingSettings(enabled: enabled, hour: hour, minute: minute);

  group('BriefingReconciler', () {
    test('off by default arms nothing and never asks for exact alarms', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = BriefingReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(settings());

      expect(result.scheduled, isFalse);
      expect(result.nextAt, isNull);
      expect(notifications.dailyCalls, isEmpty);
      expect(
        notifications.permissionRequests,
        0,
        reason:
            'a user who never turns the briefing on must never see the '
            'Alarms & reminders screen',
      );
    });

    test('cancels an alarm left behind by a previous install', () async {
      final notifications = FakeReminderNotifications(
        scheduled: <int>{BriefingReconciler.notificationId},
      );
      addTearDown(notifications.cancelAll);
      final reconciler = BriefingReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(settings());

      expect(result.cancelled, isTrue);
      expect(notifications.scheduled, isEmpty);
      expect(notifications.cancelled, <int>[BriefingReconciler.notificationId]);
    });

    test('enabling arms one repeating alarm at the chosen time', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = BriefingReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(
        settings(enabled: true, hour: 7, minute: 30),
      );

      expect(result.scheduled, isTrue);
      expect(result.exact, isTrue);
      expect(notifications.dailyCalls.single.hour, 7);
      expect(notifications.dailyCalls.single.minute, 30);
      expect(notifications.dailyCalls.single.id, BriefingReconciler.notificationId);
      // 07:30 has passed at the 12:00 `now`, so the first occurrence is tomorrow.
      expect(result.nextAt, DateTime(2026, 1, 2, 7, 30));
    });

    test('repeated reconciles replace the alarm instead of stacking it', () async {
      final notifications = FakeReminderNotifications();
      addTearDown(notifications.cancelAll);
      final reconciler = BriefingReconciler(
        notifications: notifications,
        now: () => now,
      );

      await reconciler.reconcile(settings(enabled: true));
      await reconciler.reconcile(settings(enabled: true, minute: 15));

      expect(notifications.dailyCalls, hasLength(2));
      expect(
        notifications.scheduled,
        hasLength(1),
        reason: 'a stable derived id means a repeat pass replaces, never adds',
      );
      expect(notifications.cancelled, isEmpty);
    });

    test('degrades to inexact when exact alarms are refused', () async {
      final notifications = FakeReminderNotifications(exactAllowed: false);
      addTearDown(notifications.cancelAll);
      final reconciler = BriefingReconciler(
        notifications: notifications,
        now: () => now,
      );

      final result = await reconciler.reconcile(settings(enabled: true));

      expect(result.exact, isFalse);
      expect(result.scheduled, isTrue, reason: 'a late briefing beats none');
      expect(notifications.dailyCalls.single.exact, isFalse);
    });
  });

  group('DailyBriefingSettings.nextOccurrence', () {
    test('returns today when the time is still ahead', () {
      expect(
        settings(hour: 20).nextOccurrence(now),
        DateTime(2026, 1, 1, 20),
      );
    });

    test('rolls to tomorrow when the time has passed', () {
      expect(settings(hour: 7).nextOccurrence(now), DateTime(2026, 1, 2, 7));
    });

    test('treats the exact current minute as already past', () {
      expect(settings(hour: 12).nextOccurrence(now), DateTime(2026, 1, 2, 12));
    });
  });

  group('nextDailyOccurrence', () {
    setUpAll(tzdata.initializeTimeZones);

    test('schedules the next wall-clock occurrence, in the given zone', () {
      final kolkata = tz.getLocation('Asia/Kolkata');
      expect(
        nextDailyOccurrence(
          hour: 8,
          minute: 0,
          location: kolkata,
          // 12:00 UTC is 17:30 in Kolkata, so 08:00 has passed.
          now: DateTime.utc(2026, 1, 1, 12),
        ),
        tz.TZDateTime(kolkata, 2026, 1, 2, 8),
      );
      expect(
        nextDailyOccurrence(
          hour: 20,
          minute: 0,
          location: kolkata,
          now: DateTime.utc(2026, 1, 1, 12),
        ),
        tz.TZDateTime(kolkata, 2026, 1, 1, 20),
      );
    });
  });

  test('drops a leftover id in its own band that is not its alarm', () async {
    // Before the owner bands existed a reminder's notification id was its raw
    // 31-bit hash, and about half of those carry the bit that now means "briefing".
    // Such a reminder is re-armed under a new id in the reminder band, so the old
    // one has to be dropped or it delivers a second, identical notification at the
    // same instant — once, for every reminder that was armed during the upgrade.
    // This band belongs entirely to the briefing reconciler, so anything in it that
    // is not its own alarm is a leftover.
    const leftoverReminderId = 0x7fffffff;
    expect(
      notificationOwnerOf(leftoverReminderId),
      NotificationOwner.briefing,
    );

    final notifications = FakeReminderNotifications(
      scheduled: <int>{leftoverReminderId, BriefingReconciler.notificationId},
    );
    addTearDown(notifications.cancelAll);
    final reconciler = BriefingReconciler(
      notifications: notifications,
      now: () => now,
    );

    final result = await reconciler.reconcile(settings(enabled: true));

    expect(notifications.cancelled, <int>[leftoverReminderId]);
    expect(
      notifications.scheduled,
      <int>{BriefingReconciler.notificationId},
      reason: 'the briefing keeps its own alarm and only that',
    );
    expect(result.scheduled, isTrue);
    expect(result.cancelled, isTrue);
  });

  test('the briefing id cannot be cancelled as somebody else\'s leftover', () async {
    final notifications = FakeReminderNotifications(
      scheduled: <int>{BriefingReconciler.notificationId},
    );
    addTearDown(notifications.cancelAll);
    final reconciler = BriefingReconciler(
      notifications: notifications,
      now: () => now,
    );

    await reconciler.reconcile(settings(enabled: true, hour: 9, minute: 15));

    expect(notifications.cancelled, isEmpty);
    expect(
      notifications.dailyCalls.single.id,
      BriefingReconciler.notificationId,
    );
  });

  test('the briefing id lives in its own band, out of the reminders\' reach', () {
    // This test used to assert only that the briefing's id happened not to equal
    // one particular unrelated reminder id — while the id itself was derived
    // through the reminders' own hash function, inside the reminders' own id space.
    // That is incidental separation, and it is what the reminder reconciler
    // exploited: it cancelled every pending id it did not recognise, so the
    // briefing's alarm died on every reminder sync and came back on the next
    // briefing pass. Ownership is now carried by the id, so the property is
    // checkable rather than hoped for.
    expect(
      notificationOwnerOf(BriefingReconciler.notificationId),
      NotificationOwner.briefing,
    );
    expect(
      notificationOwnerOf(reminderNotificationId('nova.daily.briefing')),
      NotificationOwner.reminder,
    );
    // No reminder id can land in the briefing's band, whatever the string is, so
    // the two features cannot collide by construction.
    expect(
      BriefingReconciler.notificationId & NotificationOwner.bandMask,
      NotificationOwner.bandMask,
    );
    expect(
      reminderNotificationId(BriefingReconciler.stableId) &
          NotificationOwner.bandMask,
      0,
    );
  });
}
