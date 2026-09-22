import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import 'notification_delivery_cache.dart';
import 'reminder_notifications.dart';
import 'reminder_recurrence.dart';

/// What one reconciliation pass did, for logging and for tests.
@immutable
class ReminderReconciliation {
  const ReminderReconciliation({
    required this.scheduled,
    required this.cancelled,
    required this.exact,
    this.notificationsBlocked = false,
    this.incomplete = false,
    this.collisions = 0,
    this.notRepeating = 0,
  });

  /// Notifications written for reminders that are still in the future.
  final int scheduled;

  /// Notifications dropped because their reminder is gone, dismissed or past.
  final int cancelled;

  /// Whether the OS granted exact alarms. When false the scheduled notifications
  /// are inexact — late by a few minutes is far better than never.
  ///
  /// `scheduled > 0 && !exact` is the only combination that is evidence the user is
  /// actually being served late; a pass that armed nothing never consults the
  /// permission and reports `false` regardless.
  final bool exact;

  /// Whether the OS itself is refusing to post this app's notifications —
  /// `POST_NOTIFICATIONS` denied on Android 13+, or the per-app notification
  /// switch turned off in Android settings.
  ///
  /// This is the flag for the defect this class could not see. The reconciler
  /// would arm `scheduled: N` alarms, exhaustively verified in `dumpsys alarm`,
  /// and Android would deliver **none** of them and tell nobody: on the OnePlus
  /// 9R the reminder came due inside a doze and
  /// `dumpsys notification | grep pkg=com.leadup.nova` stayed empty through
  /// polling every 20s. A denied permission is not a scheduling problem — the
  /// alarm fires and the notification is discarded at post time — so `scheduled`
  /// stays truthful while the user hears nothing.
  ///
  /// It is deliberately *not* the same thing as the Profile → Notifications
  /// preference ([_deliveryEnabled]): that is the user's choice about this
  /// account, this is the OS's state on this device. A user can have one without
  /// the other, and each needs its own explanation.
  ///
  /// `scheduled > 0` is not part of the test, unlike [exact]: the permission is
  /// readable whether or not anything is due, and blocking it is worth saying
  /// even on a pass that armed nothing.
  final bool notificationsBlocked;

  /// True when the list this pass ran against was *not* the account's whole list —
  /// a page failed to load, or the page bound was reached. Cancellation by absence
  /// is suppressed in that case, because a reminder that is merely on a page nobody
  /// fetched is not a reminder that was deleted.
  final bool incomplete;

  /// How many reminders lost their alarm because two of them hashed to the same
  /// notification id. Non-zero is a real (if unlikely) loss, reported rather than
  /// silently merged.
  final int collisions;

  /// How many reminders repeat at an interval the OS cannot express — anything
  /// other than every day, every week or every month.
  ///
  /// `flutter_local_notifications` has no interval component: `time`,
  /// `dayOfWeekAndTime` and `dayOfMonthAndTime` each repeat at their own fixed
  /// frequency. Such a reminder is therefore armed as its **next single
  /// occurrence**, which is the strongest thing the OS can do without firing at
  /// the wrong time — so it goes off once, and the occurrence after that is armed
  /// by the next sync. That is a real limitation, and this is how it is reported
  /// rather than being hidden behind a repeat the device is not performing.
  ///
  /// The assistant does not create rules like this (see
  /// `readRepeatRule` in `services/api/src/services/assistant-tool-executor.ts`);
  /// the REST route can, which is why the reconciler still has to handle one.
  final int notRepeating;
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
///  * anything the OS holds *in this reconciler's own id band* that is no longer
///    wanted is cancelled.
///
/// Re-running is safe: the id is derived from the reminder's server id, so a
/// repeat pass replaces a notification instead of duplicating it.
///
/// Both halves of that contract were broken in the same place. `listReminders()`
/// fetched a single page of 50 with no cursor, so reminder 51 and beyond were
/// absent from [reminders] and the pass below deleted their alarms — on every
/// sync, silently. And the cancellation loop ran over *every* pending id, which
/// included the daily briefing's alarm. Cancellation is now scoped to
/// `NotificationOwner.reminder` and is refused outright when [reminders] is not
/// known to be the whole list.
class ReminderReconciler {
  ReminderReconciler({
    required this.notifications,
    DateTime Function()? now,
    bool Function()? deliveryEnabled,
  })  : _now = now ?? DateTime.now,
        _deliveryEnabled = deliveryEnabled ?? (() => true);

  final ReminderNotifications notifications;
  final DateTime Function() _now;

  /// Whether the user still wants notifications delivered to this device.
  ///
  /// Profile → Notifications offers "Device notifications" and "In-app
  /// notifications", which are stored on the account and — until this existed —
  /// consulted by nothing, so switching them off did not stop a reminder arriving.
  /// The preference reaches here through a locally cached copy (see
  /// `notification_delivery_cache.dart`) because reconciliation runs from a sync
  /// provider and must not depend on a network round trip to decide whether to
  /// cancel an alarm.
  ///
  /// Defaults to enabled so every existing caller and test keeps working.
  final bool Function() _deliveryEnabled;

  /// [complete] says whether [reminders] is the account's whole list. It defaults
  /// to `true` so a caller that hands over a list it built itself — a test, or a
  /// future local source — keeps the old behaviour, but a caller that fetched over
  /// the network must pass what pagination actually achieved.
  Future<ReminderReconciliation> reconcile(
    Iterable<NovaReminder> reminders, {
    bool complete = true,
  }) async {
    await notifications.initialize();

    // Read once, up front, and report it on every exit path below.
    //
    // Read-only and never prompting: this runs from a sync provider, on load, on
    // change and on resume, so it may *know* the answer but must not ask for it.
    // The reminders screen owns the asking. `osPermissionGranted` answers `true`
    // when it cannot tell, so an unreadable switch never raises a false warning.
    final osBlocked = !await notifications.osPermissionGranted();

    final now = _now();
    final wanted = <int, _WantedReminder>{};
    var collisions = 0;
    var notRepeating = 0;
    for (final reminder in reminders) {
      // Dismissed is the server's disable flag, and a reminder with no time
      // cannot be scheduled at all.
      if (reminder.dismissed) continue;
      final start = reminder.remindAt;
      if (start == null) continue;

      final rule = reminder.repeatRule;
      final DateTime at;
      final bool repeats;
      if (rule == null) {
        // Unchanged: a one-shot in the past has already fired and is left alone.
        if (!start.isAfter(now)) continue;
        at = start;
        repeats = false;
      } else {
        // A recurring reminder is armed at its next occurrence, not at its stored
        // trigger: `trigger_at` is only the *first* time it went off, nothing
        // server-side advances it, and arming the old instant would either fire
        // immediately or never. The rule also decides the weekday the OS will
        // repeat on, so a trigger that does not sit on the rule's day is rolled
        // forward to one that does.
        final next = nextReminderOccurrence(rule: rule, start: start, after: now);
        if (next == null) continue;
        at = next;
        // Every day, every week and every month are the three components the OS
        // can repeat on its own; an interval is not one of them.
        repeats = rule.interval == 1;
      }
      if (rule != null && !repeats) notRepeating++;

      final id = reminderNotificationId(reminder.id);
      final existing = wanted[id];
      if (existing != null && existing.reminder.id != reminder.id) {
        // Two different reminders hashed into the same 30-bit id, and the OS can
        // hold only one alarm per id. Keep the one that is due first — the sooner
        // alarm is the one worth having — and count the loss so it is visible
        // instead of one reminder quietly overwriting the other.
        collisions++;
        if (existing.at.isAfter(at)) {
          wanted[id] = _WantedReminder(reminder: reminder, at: at, repeats: repeats);
        }
        continue;
      }
      wanted[id] = _WantedReminder(reminder: reminder, at: at, repeats: repeats);
    }
    if (collisions > 0) {
      // The one failure mode class this whole file exists to make impossible is a
      // silent loss, so a collision is loud even though it is very unlikely.
      debugPrint(
        '[ReminderReconciler] $collisions reminder(s) share a notification id and '
        'cannot all be armed',
      );
    }

    // Only ever the ids in this reconciler's own band: the daily briefing schedules
    // through the same plugin and is not this reconciler's to delete.
    final held = await notifications.scheduledIds(NotificationOwner.reminder);

    // Notifications switched off means *everything* armed is cancelled, not
    // merely nothing new scheduled — otherwise an alarm set before the user turned the
    // switch off would still fire, which is the bug this exists to prevent. This is an
    // explicit preference rather than an inference from an absent reminder, so it is
    // the one cancellation that does not depend on the list being complete.
    if (!_deliveryEnabled()) {
      for (final id in held) {
        await notifications.cancel(id);
      }
      return ReminderReconciliation(
        scheduled: 0,
        cancelled: held.length,
        exact: false,
        notificationsBlocked: osBlocked,
        incomplete: !complete,
        collisions: collisions,
        notRepeating: notRepeating,
      );
    }

    var cancelled = 0;
    if (complete) {
      for (final id in held) {
        if (wanted.containsKey(id)) continue;
        await notifications.cancel(id);
        cancelled++;
      }
    } else {
      // A page failed or the bound was reached, so "not in the list" does not mean
      // "deleted". Nothing is cancelled here; the next complete pass will clear up
      // whatever really is gone.
      debugPrint(
        '[ReminderReconciler] the reminder list is incomplete; skipping '
        'cancellation so no alarm is deleted on the strength of a partial fetch',
      );
    }

    if (wanted.isEmpty) {
      // Nothing to arm, so the exact-alarm permission is not requested: a user
      // with no reminders should never see the "Alarms & reminders" screen.
      return ReminderReconciliation(
        scheduled: 0,
        cancelled: cancelled,
        exact: false,
        notificationsBlocked: osBlocked,
        incomplete: !complete,
        collisions: collisions,
        notRepeating: notRepeating,
      );
    }

    final exact = await notifications.ensureExactAlarmPermission();
    var scheduled = 0;
    for (final entry in wanted.entries) {
      final reminder = entry.value.reminder;
      if (entry.value.repeats) {
        await notifications.scheduleRepeating(
          id: entry.key,
          reminderId: reminder.id,
          title: 'NOVA reminder',
          body: reminder.title,
          firstOccurrence: entry.value.at,
          repeat: _repeatFor(reminder.repeatRule!.frequency),
          exact: exact,
        );
      } else {
        await notifications.schedule(
          id: entry.key,
          // The server id travels as the notification payload so that opening the
          // notification can be attributed to this reminder — which is what makes
          // `POST /reminders/:id/acknowledge` possible at all. The notification id is
          // a 30-bit hash of it and cannot be turned back into a UUID.
          reminderId: reminder.id,
          title: 'NOVA reminder',
          // The body is the reminder text, so the notification alone is useful
          // when the app is not running to speak it.
          body: reminder.title,
          when: entry.value.at,
          exact: exact,
        );
      }
      scheduled++;
    }

    return ReminderReconciliation(
      scheduled: scheduled,
      cancelled: cancelled,
      exact: exact,
      notificationsBlocked: osBlocked,
      incomplete: !complete,
      collisions: collisions,
      notRepeating: notRepeating,
    );
  }
}

/// One reminder to arm, and the instant it should next go off.
///
/// The resolved instant travels with the reminder because it is not necessarily
/// `remindAt`: for a recurring reminder it is the next occurrence of the rule,
/// which is what the OS repeat is anchored on. A record rather than a second map,
/// so the two can never drift apart.
@immutable
class _WantedReminder {
  const _WantedReminder({
    required this.reminder,
    required this.at,
    required this.repeats,
  });

  final NovaReminder reminder;
  final DateTime at;

  /// Whether the OS can repeat this on its own (see
  /// [ReminderReconciliation.notRepeating]).
  final bool repeats;
}

ReminderRepeat _repeatFor(NovaRepeatFrequency frequency) => switch (frequency) {
  NovaRepeatFrequency.daily => ReminderRepeat.daily,
  NovaRepeatFrequency.weekly => ReminderRepeat.weekly,
  NovaRepeatFrequency.monthly => ReminderRepeat.monthly,
};

final reminderReconcilerProvider = Provider<ReminderReconciler>((ref) {
  // `ref.read` inside the callback, not `ref.watch` at construction: the reconciler is
  // built once, and the answer must be current at the moment it runs rather than
  // whatever it was when the provider was first read.
  return ReminderReconciler(
    notifications: ref.watch(reminderNotificationsProvider),
    deliveryEnabled: () =>
        ref.read(notificationDeliveryEnabledProvider),
  );
});
