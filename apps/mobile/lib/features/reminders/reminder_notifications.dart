import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// The seam over `flutter_local_notifications` for reminder alarms.
///
/// Everything the reconciler needs is a method here, so unit tests can prove
/// scheduling logic without touching a platform channel: the fake simply records
/// calls. The real implementation is [FlutterLocalReminderNotifications].
abstract interface class ReminderNotifications {
  /// One-time plugin and timezone-database setup. Idempotent.
  Future<void> initialize();

  /// Asks for `Permission.scheduleExactAlarm`, returning whether exact alarms
  /// are allowed. Implementations must not throw; a refusal degrades the caller
  /// to inexact scheduling instead of failing the whole sync.
  Future<bool> ensureExactAlarmPermission();

  /// The ids the OS currently holds, used to find notifications whose reminder
  /// no longer exists.
  Future<Set<int>> scheduledIds();

  /// Schedules (or replaces) the notification for [id] at [when].
  Future<void> schedule({
    required int id,
    required String title,
    required String body,
    required DateTime when,
    required bool exact,
  });

  /// Schedules (or replaces) a notification that repeats every day at
  /// `[hour]:[minute]` device-local time.
  ///
  /// This is the daily briefing's alarm (§9.4). It lives on this seam rather
  /// than in a second wrapper so the app has exactly one
  /// `FlutterLocalNotificationsPlugin`, one timezone database and one
  /// exact-alarm permission check — the two features cannot drift on the parts
  /// that are easy to get subtly wrong.
  Future<void> scheduleDaily({
    required int id,
    required String title,
    required String body,
    required int hour,
    required int minute,
    required bool exact,
  });

  /// Cancels the notification for [id]. Unknown ids are a no-op.
  Future<void> cancel(int id);
}

/// A stable, signed-32-bit notification id for a reminder's server id.
///
/// A reminder id is a UUID string and `String.hashCode` is not guaranteed to be
/// stable across runs, which would make "cancel the notification whose reminder
/// was deleted" unreliable after a restart. This is 31-bit FNV-1a: deterministic
/// on every platform and always inside the range Android accepts. A collision
/// between two of one user's reminders would merge their notifications, which is
/// vanishingly unlikely and never produces a wrong alarm time.
int reminderNotificationId(String reminderId) {
  var hash = 0x811c9dc5;
  for (final unit in reminderId.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0x7fffffff;
  }
  return hash;
}

/// The next occurrence of `[hour]:[minute]` in [location], today or tomorrow.
///
/// Pure, so the daily-scheduling rule is unit-testable without a platform
/// channel. A time that has already passed today rolls to tomorrow: scheduling
/// it in the past would fire the notification immediately and then repeat a day
/// late.
tz.TZDateTime nextDailyOccurrence({
  required int hour,
  required int minute,
  required tz.Location location,
  DateTime? now,
}) {
  final current = now == null
      ? tz.TZDateTime.now(location)
      : tz.TZDateTime.from(now, location);
  final scheduled = tz.TZDateTime(
    location,
    current.year,
    current.month,
    current.day,
    hour,
    minute,
  );
  return scheduled.isAfter(current)
      ? scheduled
      : scheduled.add(const Duration(days: 1));
}

/// The real scheduler, backed by `flutter_local_notifications`.
///
/// Android shows the notification itself, which is what survives the app being
/// closed. Speaking at the same instant is handled separately by
/// `ReminderSyncController`, which can only do it while the process is alive.
class FlutterLocalReminderNotifications implements ReminderNotifications {
  FlutterLocalReminderNotifications({FlutterLocalNotificationsPlugin? plugin})
    : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  /// Android channel. The reminder text travels as the notification body.
  static const String channelId = 'nova_reminders';
  static const String channelName = 'Reminders';
  static const String channelDescription =
      'Reminders you asked NOVA to keep.';

  /// The existing notification icon used by the Firebase messages, so the
  /// status-bar icon is a proper silhouette rather than the launcher bitmap.
  static const String _icon = 'ic_notification';

  final FlutterLocalNotificationsPlugin _plugin;
  Future<void>? _initializing;
  bool? _exactAllowed;

  @override
  Future<void> initialize() => _initializing ??= _initialize();

  Future<void> _initialize() async {
    tzdata.initializeTimeZones();
    tz.setLocalLocation(_closestLocalLocation());

    const settings = InitializationSettings(
      android: AndroidInitializationSettings(_icon),
    );
    try {
      await _plugin.initialize(settings: settings);
      // Create the channel up front rather than letting the first notification
      // create it implicitly: the user can then find and tune "Reminders" in
      // Android's notification settings before the first one arrives.
      await _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.createNotificationChannel(
            const AndroidNotificationChannel(
              channelId,
              channelName,
              description: channelDescription,
              importance: Importance.high,
            ),
          );
    } catch (error) {
      // A refused or unavailable channel must not take the app down; scheduling
      // will report its own failure later.
      debugPrint('[ReminderNotifications] initialize failed: $error');
    }
  }

  @override
  Future<bool> ensureExactAlarmPermission() async {
    final cached = _exactAllowed;
    if (cached != null) return cached;
    try {
      var status = await ph.Permission.scheduleExactAlarm.status;
      if (!status.isGranted && !status.isLimited && !status.isProvisional) {
        // Asked once per process. Android sends this to the "Alarms &
        // reminders" settings screen, so re-asking on every reminder refresh
        // would be hostile rather than helpful.
        status = await ph.Permission.scheduleExactAlarm.request();
      }
      final allowed =
          status.isGranted || status.isLimited || status.isProvisional;
      _exactAllowed = allowed;
      return allowed;
    } catch (error) {
      debugPrint('[ReminderNotifications] exact alarm check failed: $error');
      // Refusal is not an error: the caller falls back to inexact scheduling.
      _exactAllowed = false;
      return false;
    }
  }

  @override
  Future<Set<int>> scheduledIds() async {
    await initialize();
    try {
      final pending = await _plugin.pendingNotificationRequests();
      return pending.map((request) => request.id).toSet();
    } catch (error) {
      debugPrint('[ReminderNotifications] could not list pending: $error');
      return <int>{};
    }
  }

  @override
  Future<void> schedule({
    required int id,
    required String title,
    required String body,
    required DateTime when,
    required bool exact,
  }) async {
    await initialize();
    final details = AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: channelDescription,
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
      styleInformation: BigTextStyleInformation(body),
    );
    await _plugin.zonedSchedule(
      id: id,
      title: title,
      body: body,
      // `TZDateTime.from` preserves the instant; the location only decides how
      // it is written down. Using `tz.local` (set in [initialize]) keeps the
      // serialised wall-clock time matching the device.
      scheduledDate: tz.TZDateTime.from(when, tz.local),
      notificationDetails: NotificationDetails(android: details),
      androidScheduleMode: exact
          ? AndroidScheduleMode.exactAllowWhileIdle
          : AndroidScheduleMode.inexactAllowWhileIdle,
    );
  }

  @override
  Future<void> cancel(int id) async {
    await initialize();
    await _plugin.cancel(id: id);
  }

  @override
  Future<void> scheduleDaily({
    required int id,
    required String title,
    required String body,
    required int hour,
    required int minute,
    required bool exact,
  }) async {
    await initialize();
    final details = AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: channelDescription,
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
      styleInformation: BigTextStyleInformation(body),
    );
    await _plugin.zonedSchedule(
      id: id,
      title: title,
      body: body,
      // The first occurrence, then `matchDateTimeComponents` repeats it daily at
      // the same wall-clock time. Scheduling today's already-passed time without
      // the rollover would fire immediately once and then never again.
      scheduledDate: nextDailyOccurrence(
        hour: hour,
        minute: minute,
        location: tz.local,
      ),
      notificationDetails: NotificationDetails(android: details),
      androidScheduleMode: exact
          ? AndroidScheduleMode.exactAllowWhileIdle
          : AndroidScheduleMode.inexactAllowWhileIdle,
      matchDateTimeComponents: DateTimeComponents.time,
    );
  }

  /// The first IANA zone whose current UTC offset matches the device's.
  ///
  /// Flutter has no dependency-free way to read the device's IANA zone name
  /// (`DateTime.timeZoneName` is an abbreviation such as `IST`, which `ZoneId.of`
  /// may not resolve). Because one-shot schedules are absolute instants and
  /// [schedule] uses `TZDateTime.from`, the choice only affects how the time is
  /// serialised, so an offset match is sufficient. UTC is the documented
  /// fallback, and Android resolves it correctly.
  tz.Location _closestLocalLocation() {
    try {
      final offset = DateTime.now().timeZoneOffset;
      for (final location in tz.timeZoneDatabase.locations.values) {
        if (tz.TZDateTime.now(location).timeZoneOffset == offset) {
          return location;
        }
      }
    } catch (error) {
      debugPrint('[ReminderNotifications] timezone lookup failed: $error');
    }
    return tz.UTC;
  }
}

/// The app-wide reminder scheduler. Overridden with a fake in tests so nothing
/// touches a platform channel.
final reminderNotificationsProvider = Provider<ReminderNotifications>((ref) {
  return FlutterLocalReminderNotifications();
});
