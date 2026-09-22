import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
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

  /// Whether the OS currently lets this app post notifications at all.
  ///
  /// This is **not** the app's own Profile → Notifications preference, which is a
  /// different thing and is consulted separately by the reconciler. This is the
  /// OS-level switch: `POST_NOTIFICATIONS` on Android 13+, and the system
  /// "notifications are off for this app" toggle that exists on every Android
  /// version.
  ///
  /// Why it has to be on this seam, read by the reconciler: a denied permission
  /// makes Android drop **every** scheduled notification at delivery time, while
  /// `AlarmManager` still holds the alarm and the reconciler still reports
  /// `scheduled: N`. Measured on the OnePlus 9R: the alarm was armed and verified
  /// in `dumpsys alarm`, the reminder came due, and
  /// `dumpsys notification | grep pkg=com.leadup.nova` stayed empty through
  /// polling every 20s. The user was told nothing, by the OS *or* by the app.
  ///
  /// Implementations must not throw. Notifications being unreadable is not
  /// evidence that they are blocked, so an error answers `true` — the failure
  /// direction that does not raise a false alarm.
  Future<bool> osPermissionGranted();

  /// Posts a notification immediately.
  ///
  /// Android does **not** show a system notification for a message that arrives
  /// while the app is in the foreground: FCM hands it to `onMessage` and the app
  /// is responsible for displaying it. Without this, a proactive nudge sent while
  /// the user had NOVA open was delivered, acknowledged by FCM, and then dropped
  /// on the floor — the one case where the user is most likely to see it.
  Future<void> showNow({
    required int id,
    required String title,
    required String body,
    String? payload,
  });

  /// Opens the system page where the user can turn this app's notifications back
  /// on. Returns whether a screen was actually opened.
  Future<bool> openNotificationSettings();

  /// Returns whether exact alarms are allowed.
  ///
  /// **This does not prompt unless [interactive] is true.** Android routes
  /// `SCHEDULE_EXACT_ALARM` to a special *Alarms & reminders* settings screen rather than
  /// a runtime dialog, and Play's restricted-permission policy requires the app to explain
  /// why before sending the user there. So the background reconcilers call this with the
  /// default (`false`) and simply degrade to inexact scheduling; the reminders screen calls
  /// it with `true` only after showing its own disclosure.
  ///
  /// Implementations must not throw; a refusal degrades the caller to inexact scheduling
  /// instead of failing the whole sync.
  Future<bool> ensureExactAlarmPermission({bool interactive = false});

  /// The ids [owner] currently has armed, used to find notifications whose
  /// reminder no longer exists.
  ///
  /// Scoped to a single owner deliberately, with no way to ask for "every pending
  /// id": the only thing a reconciler does with the answer is cancel what it does
  /// not recognise, and it must never cancel another feature's alarm. Asking for
  /// everything and filtering by hand is what let the reminder reconciler delete
  /// the daily briefing's alarm on every sync.
  Future<Set<int>> scheduledIds(NotificationOwner owner);

  /// Schedules (or replaces) the notification for [id] at [when].
  Future<void> schedule({
    required int id,
    required String reminderId,
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

  /// Schedules (or replaces) a notification that repeats, re-armed by the OS
  /// itself after each delivery.
  ///
  /// This is the same mechanism [scheduleDaily] already uses, generalised: a
  /// repeat that has to survive the app being killed cannot be a Dart timer,
  /// because the isolate is suspended and the timer simply does not run. Android
  /// hands the reschedule to the plugin's own manifest receiver, which runs with
  /// the app closed.
  ///
  /// [firstOccurrence] is the next time it should go off and must be in the
  /// future; [repeat] then says which wall-clock component the OS matches on
  /// afterwards. Repeating on the *same id* replaces the armed notification
  /// rather than stacking a second one, which is what makes reconciliation
  /// idempotent.
  Future<void> scheduleRepeating({
    required int id,
    required String reminderId,
    required String title,
    required String body,
    required DateTime firstOccurrence,
    required ReminderRepeat repeat,
    required bool exact,
  });

  /// Cancels the notification for [id]. Unknown ids are a no-op.
  Future<void> cancel(int id);

  /// Registers what happens when the user opens a reminder notification.
  ///
  /// This is the only delivery signal the platform offers. The alarm is armed by the
  /// OS and fires with the app closed, so the instant it fires is not observable from
  /// Dart at all; a tap is. The server records that as an *acknowledgement* rather
  /// than a delivery — see `POST /api/v1/reminders/:id/acknowledge`.
  ///
  /// [handler] receives the reminder's server id. It runs from a plugin callback that
  /// may fire before the app is authenticated (Android can cold-start the process for
  /// the tap), so it must not assume a session exists and must not throw: a failed
  /// report is retried by the next reconcile, whereas an exception here is dropped by
  /// the platform with no record.
  ///
  /// Registering twice replaces the handler; registering after [initialize] still
  /// takes effect, because the plugin's callback is a closure over the current handler.
  void onReminderOpened(Future<void> Function(String reminderId) handler);
}

/// The repeat components the OS can express, one per stored frequency.
///
/// Exposed to callers as this small enum rather than as the plugin's own
/// `DateTimeComponents`, so the reconciler and its tests never depend on the
/// notification plugin — and so the mapping below is the only place that has to
/// know which plugin enum means which rule.
enum ReminderRepeat {
  /// Every day at the same wall-clock time (`DateTimeComponents.time`).
  daily,

  /// Every week on the same weekday and time
  /// (`DateTimeComponents.dayOfWeekAndTime`).
  weekly,

  /// Every month on the same day of the month and time
  /// (`DateTimeComponents.dayOfMonthAndTime`). A month without that day is
  /// skipped, which is what the 31st does in February.
  monthly,
}

/// Which feature owns a scheduled notification.
///
/// Every notification the app schedules comes from one OS-level id space, and the
/// OS remembers only the number — so ownership has to live *inside* the number.
/// Each owner gets a disjoint high-bit band, and a reconciler may only ever cancel
/// ids that fall in its own band.
///
/// This exists because it did not. The reminder reconciler cancelled every pending
/// id it did not recognise, which included the daily briefing's alarm: the two
/// features shared the reminders' own hash function and a comment claimed "the two
/// features cannot collide" while nothing enforced it. The separation is now a
/// property of the id, not a hope about the values.
enum NotificationOwner {
  /// Reminder alarms, reconciled by `ReminderReconciler`.
  reminder(band: 0x00000000),

  /// The daily briefing's repeating alarm, reconciled by `BriefingReconciler`.
  briefing(band: 0x40000000);

  const NotificationOwner({required this.band});

  /// The high bits that name this owner. Every id in the band carries them.
  final int band;

  /// The bits inside a band an id may use: 30 of the 31 Android-safe bits.
  static const int payloadMask = 0x3fffffff;

  /// The single bit that separates the bands.
  static const int bandMask = 0x40000000;
}

/// A stable, Android-safe notification id for [stableId] inside [owner]'s band.
///
/// Deterministic on every platform (see [_fnv1a31]) and always inside
/// `[0, 0x7fffffff]`, which is the range Android accepts.
int notificationIdFor(NotificationOwner owner, String stableId) =>
    owner.band | (_fnv1a31(stableId) & NotificationOwner.payloadMask);

/// The owner of a notification id, read back out of the id itself.
NotificationOwner notificationOwnerOf(int id) =>
    (id & NotificationOwner.bandMask) == NotificationOwner.briefing.band
    ? NotificationOwner.briefing
    : NotificationOwner.reminder;

/// A stable, signed-32-bit notification id for a reminder's server id.
///
/// A reminder id is a UUID string and `String.hashCode` is not guaranteed to be
/// stable across runs, which would make "cancel the notification whose reminder
/// was deleted" unreliable after a restart. This is 31-bit FNV-1a, then 30 bits
/// once the owner band has taken its bit: deterministic on every platform and
/// always inside the range Android accepts.
///
/// Two of one user's reminders *can* land on the same id — the space is finite and
/// the ids are arbitrary. That used to merge their notifications silently;
/// `ReminderReconciler` now detects it, keeps the reminder that is due first and
/// reports the rest, so the loss is visible rather than invisible.
int reminderNotificationId(String reminderId) =>
    notificationIdFor(NotificationOwner.reminder, reminderId);

/// 31-bit FNV-1a over the string's code units.
int _fnv1a31(String value) {
  var hash = 0x811c9dc5;
  for (final unit in value.codeUnits) {
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

/// The Android side of "put this app's notifications back on".
///
/// A tiny seam of its own rather than a route through the notification-listener
/// channel in `features/notifications/`: that channel answers about *Notification
/// Access* (`ACTION_NOTIFICATION_LISTENER_SETTINGS`), which is a different grant
/// from this app's own notification permission, and this file must not depend on
/// a feature it does not own. Unit tests substitute a fake.
abstract interface class ReminderNotificationSettings {
  /// Opens the per-app notification settings screen. Answers whether a screen
  /// actually opened.
  Future<bool> openNotificationSettings();
}

/// The real channel, answered by `NovaNotificationSettings` in Kotlin.
class MethodChannelReminderNotificationSettings
    implements ReminderNotificationSettings {
  const MethodChannelReminderNotificationSettings();

  static const MethodChannel _channel = MethodChannel(
    'nova/notification_settings',
  );

  @override
  Future<bool> openNotificationSettings() async {
    final opened = await _channel.invokeMethod<bool>(
      'openNotificationSettings',
    );
    return opened ?? false;
  }
}

/// The real scheduler, backed by `flutter_local_notifications`.
///
/// Android shows the notification itself, which is what survives the app being
/// closed. Speaking at the same instant is handled separately by
/// `ReminderSyncController`, which can only do it while the process is alive.
class FlutterLocalReminderNotifications implements ReminderNotifications {
  FlutterLocalReminderNotifications({
    FlutterLocalNotificationsPlugin? plugin,
    ReminderNotificationSettings? platform,
  })  : _plugin = plugin ?? FlutterLocalNotificationsPlugin(),
        _platform = platform ?? const MethodChannelReminderNotificationSettings();

  /// Android channel. The reminder text travels as the notification body.
  static const String channelId = 'nova_reminders';
  static const String channelName = 'Reminders';
  static const String channelDescription =
      'Reminders you asked NOVA to keep.';

  /// The existing notification icon used by the Firebase messages, so the
  /// status-bar icon is a proper silhouette rather than the launcher bitmap.
  static const String _icon = 'ic_notification';

  final FlutterLocalNotificationsPlugin _plugin;
  final ReminderNotificationSettings _platform;
  Future<void>? _initializing;
  bool? _exactAllowed;

  /// What to do when the user opens a reminder notification.
  ///
  /// Held in a field rather than captured by value in [initialize] so that
  /// registering a handler after the plugin is initialised still takes effect —
  /// otherwise the order of app start-up would decide whether a tap is reported,
  /// and a cold start from the notification would silently drop it.
  Future<void> Function(String reminderId)? _onOpened;

  @override
  void onReminderOpened(Future<void> Function(String reminderId) handler) {
    _onOpened = handler;
  }

  @override
  Future<void> initialize() => _initializing ??= _initialize();

  Future<void> _initialize() async {
    tzdata.initializeTimeZones();
    tz.setLocalLocation(_closestLocalLocation());

    const settings = InitializationSettings(
      android: AndroidInitializationSettings(_icon),
    );
    try {
      await _plugin.initialize(
        settings: settings,
        // Without this the tap did nothing at all: no navigation, no record. The
        // notification was the only reminder channel that works with the app closed,
        // and opening it left no trace anywhere — which is why the Admin Control
        // Center could not report a single acknowledged reminder.
        onDidReceiveNotificationResponse: _handleResponse,
      );
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
  Future<bool> osPermissionGranted() async {
    // Only Android gates notifications behind a runtime permission *and* an
    // OS-level per-app switch. Elsewhere the platform has no such switch to read,
    // so the answer is "not blocked" rather than a guess in the other direction.
    if (defaultTargetPlatform != TargetPlatform.android) return true;
    try {
      final status = await ph.Permission.notification.status;
      // `permission_handler_android` answers this from
      // `NotificationManagerCompat.areNotificationsEnabled()` below Android 13 and
      // from `POST_NOTIFICATIONS` on 13+, so one read covers both the runtime
      // permission and the settings toggle.
      return status.isGranted || status.isLimited || status.isProvisional;
    } catch (error) {
      // An unreadable switch is not a blocked one. Raising the "notifications are
      // off" card on the strength of a failed platform call would be a lie the user
      // cannot act on.
      debugPrint('[ReminderNotifications] notification permission read failed: $error');
      return true;
    }
  }

  @override
  Future<bool> openNotificationSettings() async {
    try {
      // The one route code that opens Android's per-app notification page. On iOS
      // this returns false, and the caller falls back to the app's own settings
      // page rather than claiming to have done something.
      return await _platform.openNotificationSettings();
    } catch (error) {
      debugPrint('[ReminderNotifications] could not open notification settings: $error');
      return false;
    }
  }

  @override
  Future<bool> ensureExactAlarmPermission({bool interactive = false}) async {
    // A *grant* is remembered; a refusal is not.
    //
    // Only the user can turn Android's `canScheduleExactAlarms()` app-op on, and
    // they do it on a system screen the app never observes. Caching the refusal
    // therefore meant every later pass kept scheduling inexactly — measured 3.5 to
    // 7 minutes late — until something happened to tap the reminders screen, even
    // though the user had granted the access. The read is one cheap platform call,
    // and re-reading it is exactly what lets a grant "take effect without
    // restarting the app", as this method's contract promises.
    if (interactive) _exactAllowed = null;
    if (_exactAllowed == true) return true;
    try {
      var status = await ph.Permission.scheduleExactAlarm.status;
      var allowed =
          status.isGranted || status.isLimited || status.isProvisional;

      if (!allowed && !interactive) {
        // Background path (the reminder/briefing reconcilers). Android routes this
        // permission to the "Alarms & reminders" *system settings* screen, so
        // requesting it here would throw the user out of the app unprompted — which
        // Play's restricted-permission policy explicitly forbids. Callers degrade to
        // inexact scheduling instead; the reminders screen offers the prompted path.
        return false;
      }

      if (!allowed) {
        // Reached only from a user tap that already showed the in-app disclosure
        // naming exact alarms and warning that a system screen is about to open.
        // That request is what opens `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`.
        status = await ph.Permission.scheduleExactAlarm.request();
        allowed = status.isGranted || status.isLimited || status.isProvisional;
      }

      if (allowed) _exactAllowed = true;
      return allowed;
    } catch (error) {
      debugPrint('[ReminderNotifications] exact alarm check failed: $error');
      // Refusal is not an error: the caller falls back to inexact scheduling. Not
      // cached, for the same reason a denial is not.
      return false;
    }
  }

  @override
  Future<Set<int>> scheduledIds(NotificationOwner owner) async {
    await initialize();
    try {
      final pending = await _plugin.pendingNotificationRequests();
      return pending
          .map((request) => request.id)
          .where((id) => notificationOwnerOf(id) == owner)
          .toSet();
    } catch (error) {
      debugPrint('[ReminderNotifications] could not list pending: $error');
      // An empty answer means "nothing of mine is armed", so the reconciler cancels
      // nothing. A stale alarm may survive, which is the safe direction: the
      // alternative — guessing that an unreadable list means the reminders are gone
      // — deletes alarms the user asked for.
      return <int>{};
    }
  }

  @override
  Future<void> schedule({
    required int id,
    required String reminderId,
    required String title,
    required String body,
    required DateTime when,
    required bool exact,
  }) async {
    await initialize();
    await _plugin.zonedSchedule(
      id: id,
      title: title,
      body: body,
      // `TZDateTime.from` preserves the instant; the location only decides how
      // it is written down. Using `tz.local` (set in [initialize]) keeps the
      // serialised wall-clock time matching the device.
      scheduledDate: tz.TZDateTime.from(when, tz.local),
      notificationDetails: _details(body),
      androidScheduleMode: exact
          ? AndroidScheduleMode.exactAllowWhileIdle
          : AndroidScheduleMode.inexactAllowWhileIdle,
      payload: reminderId,
    );
  }

  @override
  Future<void> scheduleRepeating({
    required int id,
    required String reminderId,
    required String title,
    required String body,
    required DateTime firstOccurrence,
    required ReminderRepeat repeat,
    required bool exact,
  }) async {
    await initialize();
    await _plugin.zonedSchedule(
      id: id,
      title: title,
      body: body,
      // The first occurrence is an absolute instant, so it is armed exactly as a
      // one-shot would be. What makes it repeat is `matchDateTimeComponents`
      // below: after the OS delivers it, the plugin's own receiver computes the
      // next date matching those components and re-arms the alarm — with no Dart
      // isolate involved, so it survives the app being killed.
      scheduledDate: tz.TZDateTime.from(firstOccurrence, tz.local),
      notificationDetails: _details(body),
      androidScheduleMode: exact
          ? AndroidScheduleMode.exactAllowWhileIdle
          : AndroidScheduleMode.inexactAllowWhileIdle,
      matchDateTimeComponents: switch (repeat) {
        ReminderRepeat.daily => DateTimeComponents.time,
        ReminderRepeat.weekly => DateTimeComponents.dayOfWeekAndTime,
        // Not `dateAndTime`, which would match the same day *and month* — a
        // yearly reminder. `dayOfMonthAndTime` is the monthly one, and it walks
        // forward a day at a time until the day of the month matches, so a rule
        // on the 31st skips February by itself.
        ReminderRepeat.monthly => DateTimeComponents.dayOfMonthAndTime,
      },
      // Carried on every repeat too, so a tap on the *n*th occurrence is
      // attributed the same way as the first.
      payload: reminderId,
    );
  }

  @override
  Future<void> cancel(int id) async {
    await initialize();
    await _plugin.cancel(id: id);
  }

  /// Turns a notification tap into a reminder acknowledgement.
  ///
  /// The payload is the reminder's server id, written by [schedule] /
  /// [scheduleRepeating]. A payload that is absent or empty means the notification
  /// came from something else, and is ignored rather than guessed at.
  ///
  /// Nothing here may throw. The plugin invokes this from a platform callback, so an
  /// exception escapes to the platform and the tap is lost with no record — the exact
  /// failure this callback exists to remove. A failed report is retried by
  /// `ReminderSyncController` on its next reconcile.
  void _handleResponse(NotificationResponse response) {
    final reminderId = response.payload;
    if (reminderId == null || reminderId.isEmpty) return;
    final handler = _onOpened;
    if (handler == null) {
      debugPrint(
        '[ReminderNotifications] notification opened before a handler was '
        'registered; the acknowledgement for $reminderId was dropped',
      );
      return;
    }
    // Deliberately not awaited: this is a synchronous callback and the plugin does
    // not await it. The error is caught so it cannot become an unhandled rejection.
    handler(reminderId).catchError((Object error) {
      debugPrint('[ReminderNotifications] could not report the acknowledgement: $error');
    });
  }

  @override
  Future<void> showNow({
    required int id,
    required String title,
    required String body,
    String? payload,
  }) async {
    await initialize();
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: _details(body),
      payload: payload,
    );
  }

  /// The Android details every reminder notification shares.
  ///
  /// One builder rather than the same fourteen lines in three places: the
  /// channel, the importance and the big-text style are what make a reminder
  /// readable on a lock screen, and a schedule path that quietly missed one would
  /// be invisible until a notification arrived looking wrong.
  NotificationDetails _details(String body) => NotificationDetails(
    android: AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: channelDescription,
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
      styleInformation: BigTextStyleInformation(body),
    ),
  );

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
      notificationDetails: _details(body),
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

/// Whether exact alarms are currently allowed, read **without prompting**.
///
/// This is what the reminders screen renders its "turn on exact alarms" card from.
/// The card's button is the only thing that calls
/// [ReminderNotifications.ensureExactAlarmPermission] with `interactive: true`, and it
/// does so after showing its own disclosure — which is what Play's restricted-permission
/// policy requires for `SCHEDULE_EXACT_ALARM`.
final exactAlarmAllowedProvider = FutureProvider<bool>((ref) {
  return ref.watch(reminderNotificationsProvider).ensureExactAlarmPermission();
});
