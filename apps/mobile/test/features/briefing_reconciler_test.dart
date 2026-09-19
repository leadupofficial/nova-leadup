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

  test('the briefing id cannot collide with a reminder id', () {
    expect(
      BriefingReconciler.notificationId,
      isNot(reminderNotificationId('nova.daily.briefing.reminder')),
    );
    expect(
      BriefingReconciler.notificationId,
      reminderNotificationId(BriefingReconciler.stableId),
    );
  });
}
