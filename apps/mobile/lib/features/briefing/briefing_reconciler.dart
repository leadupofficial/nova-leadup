import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../reminders/reminder_notifications.dart';
import 'briefing_models.dart';

/// Brings the OS's daily-briefing alarm in line with the user's preference.
///
/// Deliberately the same shape as `ReminderReconciler`: reconciliation, not
/// arm-once. Any of a reinstall, an expired token, a cleared app cache or a
/// changed time leaves the OS holding either nothing or the wrong alarm, so
/// every reconcile pass compares what is armed against what is wanted and
/// cancels or re-arms it. The id is a constant derived through the reminders'
/// own hash, so a repeat pass replaces the alarm instead of duplicating it and
/// the two features cannot collide.
///
/// What the alarm can do, honestly: Android owns the scheduled notification and
/// shows it with the app closed. Nothing in `flutter_local_notifications` calls
/// back into Dart when a scheduled notification is *delivered*, so speaking the
/// briefing at that instant only works while the process is alive — which is
/// what `DailyBriefingController`'s timer covers, exactly as `ReminderSync`
/// does for reminders.
class BriefingReconciler {
  BriefingReconciler({required this.notifications, DateTime Function()? now})
    : _now = now ?? DateTime.now;

  /// The stable string the notification id is derived from.
  static const String stableId = 'nova.daily.briefing';

  static const String notificationTitle = 'NOVA daily briefing';
  static const String notificationBody =
      'Your briefing is ready. Open NOVA to hear it.';

  /// The id the OS holds. Derived, not random, so it survives a restart.
  static int get notificationId => reminderNotificationId(stableId);

  final ReminderNotifications notifications;
  final DateTime Function() _now;

  Future<BriefingReconciliation> reconcile(
    DailyBriefingSettings settings,
  ) async {
    await notifications.initialize();
    final held = await notifications.scheduledIds();

    if (!settings.enabled) {
      // Nothing wanted: drop an alarm left over from a previous install or a
      // previous setting, and leave the exact-alarm permission alone. A user
      // who never turns this on must never see the "Alarms & reminders" screen.
      if (!held.contains(notificationId)) return BriefingReconciliation.idle;
      await notifications.cancel(notificationId);
      return const BriefingReconciliation(
        scheduled: false,
        cancelled: true,
        exact: false,
        nextAt: null,
      );
    }

    final exact = await notifications.ensureExactAlarmPermission();
    await notifications.scheduleDaily(
      id: notificationId,
      title: notificationTitle,
      body: notificationBody,
      hour: settings.hour,
      minute: settings.minute,
      exact: exact,
    );

    return BriefingReconciliation(
      scheduled: true,
      cancelled: false,
      exact: exact,
      nextAt: settings.nextOccurrence(_now()),
    );
  }
}

final briefingReconcilerProvider = Provider<BriefingReconciler>((ref) {
  return BriefingReconciler(
    notifications: ref.watch(reminderNotificationsProvider),
  );
});
