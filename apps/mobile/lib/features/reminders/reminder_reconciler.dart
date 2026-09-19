import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import 'reminder_notifications.dart';

/// What one reconciliation pass did, for logging and for tests.
@immutable
class ReminderReconciliation {
  const ReminderReconciliation({
    required this.scheduled,
    required this.cancelled,
    required this.exact,
  });

  /// Notifications written for reminders that are still in the future.
  final int scheduled;

  /// Notifications dropped because their reminder is gone, dismissed or past.
  final int cancelled;

  /// Whether the OS granted exact alarms. When false the scheduled notifications
  /// are inexact — late by a few minutes is far better than never.
  final bool exact;
}

/// Brings the OS's scheduled notifications back in line with the server's list.
///
/// Scheduling is deliberately not a one-shot at creation. A reminder can be
/// created on another device, edited, snoozed or deleted, and a reinstall or an
/// expired token loses every local alarm while the rows still exist server-side.
/// So every time reminders are fetched, the full list is compared against what
/// the OS currently holds:
///
///  * a future, non-dismissed reminder gets (or replaces) a notification;
///  * anything the OS holds that is no longer wanted is cancelled.
///
/// Re-running is safe: the id is derived from the reminder's server id, so a
/// repeat pass replaces a notification instead of duplicating it.
class ReminderReconciler {
  ReminderReconciler({
    required this.notifications,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final ReminderNotifications notifications;
  final DateTime Function() _now;

  Future<ReminderReconciliation> reconcile(
    Iterable<NovaReminder> reminders,
  ) async {
    await notifications.initialize();

    final now = _now();
    final wanted = <int, NovaReminder>{};
    for (final reminder in reminders) {
      // Dismissed is the server's disable flag, and a reminder with no time
      // cannot be scheduled at all.
      if (reminder.dismissed) continue;
      final at = reminder.remindAt;
      if (at == null || !at.isAfter(now)) continue;
      wanted[reminderNotificationId(reminder.id)] = reminder;
    }

    final held = await notifications.scheduledIds();
    var cancelled = 0;
    for (final id in held) {
      if (wanted.containsKey(id)) continue;
      await notifications.cancel(id);
      cancelled++;
    }

    if (wanted.isEmpty) {
      // Nothing to arm, so the exact-alarm permission is not requested: a user
      // with no reminders should never see the "Alarms & reminders" screen.
      return ReminderReconciliation(
        scheduled: 0,
        cancelled: cancelled,
        exact: false,
      );
    }

    final exact = await notifications.ensureExactAlarmPermission();
    var scheduled = 0;
    for (final entry in wanted.entries) {
      final reminder = entry.value;
      await notifications.schedule(
        id: entry.key,
        title: 'NOVA reminder',
        // The body is the reminder text, so the notification alone is useful
        // when the app is not running to speak it.
        body: reminder.title,
        when: reminder.remindAt!,
        exact: exact,
      );
      scheduled++;
    }

    return ReminderReconciliation(
      scheduled: scheduled,
      cancelled: cancelled,
      exact: exact,
    );
  }
}

final reminderReconcilerProvider = Provider<ReminderReconciler>((ref) {
  return ReminderReconciler(
    notifications: ref.watch(reminderNotificationsProvider),
  );
});
