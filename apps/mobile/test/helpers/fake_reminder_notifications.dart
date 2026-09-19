import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

/// In-memory stand-in for the reminder scheduler, so reconciliation tests and
/// widget tests never touch a platform channel.
class FakeReminderNotifications implements ReminderNotifications {
  FakeReminderNotifications({this.exactAllowed = true, Set<int>? scheduled})
    : scheduled = <int>{...?scheduled};

  /// Whether the "OS" grants exact alarms.
  bool exactAllowed;

  /// The ids the "OS" currently holds.
  final Set<int> scheduled;

  /// Every schedule call, in order.
  final List<({int id, String body, DateTime when, bool exact})> scheduledCalls =
      <({int id, String body, DateTime when, bool exact})>[];

  /// Every cancelled id, in order.
  final List<int> cancelled = <int>[];

  int initializeCalls = 0;
  int permissionRequests = 0;

  @override
  Future<void> initialize() async {
    initializeCalls++;
  }

  @override
  Future<bool> ensureExactAlarmPermission() async {
    permissionRequests++;
    return exactAllowed;
  }

  @override
  Future<Set<int>> scheduledIds() async => <int>{...scheduled};

  @override
  Future<void> schedule({
    required int id,
    required String title,
    required String body,
    required DateTime when,
    required bool exact,
  }) async {
    scheduled.add(id);
    scheduledCalls.add((id: id, body: body, when: when, exact: exact));
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
    cancelled.clear();
  }
}
