import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../app/providers.dart';

/// A local mirror of "does the user want notifications delivered to this device?".
///
/// Profile → Notifications offers **Device notifications** and **In-app
/// notifications**. Both are stored on the account through
/// `PATCH /api/v1/settings/preferences`, and until this file existed nothing consulted
/// them: reminders are armed by a *local* alarm, and the reconciler scheduled one
/// regardless of the switch, so turning notifications off did not stop a reminder
/// arriving.
///
/// The mirror exists because reconciliation runs from a synchronous provider and is
/// also driven by connectivity changes, so it cannot await a network round trip before
/// deciding whether to cancel an alarm that is about to fire. The cached value is
/// written whenever the sheet saves, and read on the way into the reconciler.
///
/// The default is **enabled**: an account that has never opened the sheet, or a device
/// whose cache was cleared by a reinstall, must not silently stop delivering reminders.
extension NotificationDeliveryPreference on SharedPreferences {
  static const String key = 'nova_notification_delivery_enabled';

  /// True unless the user has explicitly turned device and in-app notifications off.
  ///
  /// *Both* must be off to stop delivery: they are separate channels, and a user who
  /// keeps in-app notifications on still expects to be told about a reminder.
  bool get notificationDeliveryEnabled => getBool(key) ?? true;
}

/// Persists the choice, called from every path that can change it.
///
/// Reminder: a new caller of `saveNotificationPrefs` that forgets this leaves the gate
/// reading its old value for the rest of the session. The two callers today are the
/// Notifications sheet and the final onboarding step.
Future<void> cacheNotificationDelivery(
  SharedPreferences prefs, {
  required bool push,
  required bool inApp,
}) async {
  await prefs.setBool(
    NotificationDeliveryPreference.key,
    push || inApp,
  );
}

/// Removes the cached answer.
///
/// Called on sign-out. Without it the value is device-scoped, so a second account on the
/// same device inherits the first account's off-state and has its reminders silently
/// suppressed — the same class of cross-account leak the persona flush guards against.
Future<void> clearNotificationDeliveryCache(SharedPreferences prefs) async {
  await prefs.remove(NotificationDeliveryPreference.key);
}

/// What the reconcilers read. Synchronous by design — see the class doc.
///
/// A [Notifier], not a plain `Provider<bool>`, and that matters. A `Provider` is
/// created once and its value cached for the session (Riverpod's `Provider` defaults to
/// `isAutoDispose = false`), and `sharedPreferencesProvider` never changes, so a plain
/// provider would compute the bool on the first read and return that answer forever.
/// The reconcilers use `ref.read`, which does not subscribe, so a later write to
/// SharedPreferences would never reach them: turning **Device notifications** off in
/// Profile would not cancel the alarms already armed until the process restarted. The
/// notifier is invalidated by the writer instead.
class NotificationDeliveryEnabled extends Notifier<bool> {
  @override
  bool build() => ref.watch(sharedPreferencesProvider).notificationDeliveryEnabled;
}

final notificationDeliveryEnabledProvider =
    NotifierProvider<NotificationDeliveryEnabled, bool>(
  NotificationDeliveryEnabled.new,
);
