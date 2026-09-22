import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

/// In-memory stand-in for the reminder scheduler, so reconciliation tests and
/// widget tests never touch a platform channel.
class FakeReminderNotifications implements ReminderNotifications {
  FakeReminderNotifications({
    this.exactAllowed = true,
    this.osAllowed = true,
    Set<int>? scheduled,
  }) : scheduled = <int>{...?scheduled};

  /// Whether the "OS" grants exact alarms.
  bool exactAllowed;

  /// Whether the "OS" will post this app's notifications at all. `false` is a
  /// denied `POST_NOTIFICATIONS` or Android's per-app notification switch off.
  bool osAllowed;

  /// The ids the "OS" currently holds.
  final Set<int> scheduled;

  /// Every schedule call, in order.
  ///
  /// `reminderId` is recorded because it is the notification's payload, and the
  /// payload is the only thing that makes a tap attributable to a reminder.
  final List<({int id, String reminderId, String body, DateTime when, bool exact})>
  scheduledCalls =
      <({int id, String reminderId, String body, DateTime when, bool exact})>[];

  /// Every daily-repeating schedule call, in order.
  final List<({int id, String body, int hour, int minute, bool exact})>
  dailyCalls = <({int id, String body, int hour, int minute, bool exact})>[];

  /// Every OS-level repeating schedule call, in order, with the repeat component
  /// the reconciler chose. A recurring reminder must land here and a one-shot
  /// must never do so, which is what the two lists are for.
  final List<
    ({
      int id,
      String reminderId,
      String body,
      DateTime firstOccurrence,
      ReminderRepeat repeat,
      bool exact,
    })
  >
  repeatingCalls =
      <
        ({
          int id,
          String reminderId,
          String body,
          DateTime firstOccurrence,
          ReminderRepeat repeat,
          bool exact,
        })
      >[];

  /// Every cancelled id, in order.
  final List<int> cancelled = <int>[];

  /// How many times the notification-permission state was read, and how many
  /// times the system settings screen was asked for.
  int osPermissionReads = 0;
  int settingsOpened = 0;

  int initializeCalls = 0;
  int permissionRequests = 0;
  int interactiveRequests = 0;

  /// Every notification posted immediately rather than scheduled — how a push
  /// that arrives while the app is open becomes visible to the user.
  final List<({int id, String title, String body})> shownImmediately =
      <({int id, String title, String body})>[];

  @override
  Future<void> initialize() async {
    initializeCalls++;
  }

  @override
  Future<void> showNow({
    required int id,
    required String title,
    required String body,
    String? payload,
  }) async {
    shownImmediately.add((id: id, title: title, body: body));
  }

  @override
  Future<bool> osPermissionGranted() async {
    osPermissionReads++;
    return osAllowed;
  }

  @override
  Future<bool> openNotificationSettings() async {
    settingsOpened++;
    return true;
  }

  @override
  Future<bool> ensureExactAlarmPermission({bool interactive = false}) async {
    // `interactiveRequests` is the number of calls that would have opened the system
    // "Alarms & reminders" screen. Tests assert it stays 0 on the background path.
    if (interactive) interactiveRequests++;
    permissionRequests++;
    return exactAllowed;
  }

  @override
  Future<Set<int>> scheduledIds(NotificationOwner owner) async =>
      // Scoped like the real seam: a reconciler asks for its own band, so a fake
      // that handed over another owner's ids would hide exactly the defect these
      // ids exist to prevent.
      scheduled.where((id) => notificationOwnerOf(id) == owner).toSet();

  @override
  Future<void> schedule({
    required int id,
    required String reminderId,
    required String title,
    required String body,
    required DateTime when,
    required bool exact,
  }) async {
    scheduled.add(id);
    scheduledCalls.add((
      id: id,
      reminderId: reminderId,
      body: body,
      when: when,
      exact: exact,
    ));
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
    scheduled.add(id);
    dailyCalls.add((id: id, body: body, hour: hour, minute: minute, exact: exact));
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
    // The OS holds one alarm per id, and this is the same id — which is what
    // makes a repeat pass replace the alarm instead of stacking a second one.
    scheduled.add(id);
    repeatingCalls.add((
      id: id,
      reminderId: reminderId,
      body: body,
      firstOccurrence: firstOccurrence,
      repeat: repeat,
      exact: exact,
    ));
  }

  /// The handler `onReminderOpened` registered, if any. Tests drive it directly to
  /// prove what a tap does without a platform channel.
  Future<void> Function(String reminderId)? openedHandler;

  /// How many times a handler was registered. Two registrations would mean the
  /// last one silently wins, which is worth detecting.
  int openedHandlerRegistrations = 0;

  @override
  void onReminderOpened(Future<void> Function(String reminderId) handler) {
    openedHandlerRegistrations++;
    openedHandler = handler;
  }

  @override
  Future<void> cancel(int id) async {
    scheduled.remove(id);
    cancelled.add(id);
  }

  /// Drops every id this fake holds. Tests call it from `tearDown` so no
  /// scheduled notification outlives the test that created it.
  void cancelAll() {
    scheduled.clear();
    scheduledCalls.clear();
    dailyCalls.clear();
    repeatingCalls.clear();
    cancelled.clear();
  }
}
