import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../reminders/notification_delivery_cache.dart';
import '../reminders/reminder_notifications.dart';
import 'briefing_models.dart';

/// Brings the OS's daily-briefing alarm in line with the user's preference.
///
/// Deliberately the same shape as `ReminderReconciler`: reconciliation, not
/// arm-once. Any of a reinstall, an expired token, a cleared app cache or a
/// changed time leaves the OS holding either nothing or the wrong alarm, so
/// every reconcile pass compares what is armed against what is wanted and
/// cancels or re-arms it.
///
/// The id is stable and lives in `NotificationOwner.briefing`'s own band, so a
/// repeat pass replaces the alarm instead of duplicating it and the two features
/// cannot collide — a property of the id now, rather than a comment. It used to be
/// derived through the reminders' own hash, which is exactly why the reminder
/// reconciler was able to cancel this alarm on every reminder sync.
///
/// What the alarm can do, honestly: Android owns the scheduled notification and
/// shows it with the app closed. Nothing in `flutter_local_notifications` calls
/// back into Dart when a scheduled notification is *delivered*, so speaking the
/// briefing at that instant only works while the process is alive — which is
/// what `DailyBriefingController`'s timer covers, exactly as `ReminderSync`
/// does for reminders.
class BriefingReconciler {
  BriefingReconciler({
    required this.notifications,
    DateTime Function()? now,
    bool Function()? deliveryEnabled,
  })  : _now = now ?? DateTime.now,
        _deliveryEnabled = deliveryEnabled ?? (() => true);

  /// The same gate the reminder reconciler uses: `notificationDeliveryEnabledProvider`.
  ///
  /// The briefing is delivered as a scheduled *notification*, so "Device
  /// notifications" off means it must not arrive either. Without this the two
  /// reconcilers disagreed — the reminder pass would cancel every armed id, and this
  /// one would immediately re-arm the briefing.
  final bool Function() _deliveryEnabled;

  /// The stable string the notification id is derived from.
  static const String stableId = 'nova.daily.briefing';

  static const String notificationTitle = 'NOVA daily briefing';
  static const String notificationBody =
      'Your briefing is ready. Open NOVA to hear it.';

  /// The id the OS holds. Derived, not random, so it survives a restart, and
  /// banded to this owner so no other reconciler can reach it.
  static int get notificationId =>
      notificationIdFor(NotificationOwner.briefing, stableId);

  final ReminderNotifications notifications;
  final DateTime Function() _now;

  Future<BriefingReconciliation> reconcile(
    DailyBriefingSettings settings,
  ) async {
    await notifications.initialize();
    final held = await notifications.scheduledIds(NotificationOwner.briefing);

    // The band is this reconciler's whole domain, and the only id it ever wants in
    // it is `notificationId` — so anything else there is a leftover and is dropped.
    //
    // It is not hypothetical: before the bands existed a reminder's id was its raw
    // 31-bit hash, and about half of those carry the bit that now means "briefing".
    // Such a reminder is re-armed under its own id in the reminder band, so leaving
    // the old one alive would deliver a second, identical notification at the same
    // instant, once, for every reminder that was already armed during the upgrade.
    var orphaned = 0;
    for (final id in held) {
      if (id == notificationId) continue;
      await notifications.cancel(id);
      orphaned++;
    }

    if (!settings.enabled || !_deliveryEnabled()) {
      // Nothing wanted: drop an alarm left over from a previous install or a
      // previous setting, and leave the exact-alarm permission alone. A user
      // who never turns this on must never see the "Alarms & reminders" screen.
      final hadAlarm = held.contains(notificationId);
      if (hadAlarm) await notifications.cancel(notificationId);
      if (orphaned == 0 && !hadAlarm) return BriefingReconciliation.idle;
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
      cancelled: orphaned > 0,
      exact: exact,
      nextAt: settings.nextOccurrence(_now()),
    );
  }
}

final briefingReconcilerProvider = Provider<BriefingReconciler>((ref) {
  return BriefingReconciler(
    notifications: ref.watch(reminderNotificationsProvider),
    // Read at call time, not at construction — see the reminder reconciler.
    deliveryEnabled: () => ref.read(notificationDeliveryEnabledProvider),
  );
});
