import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';

/// `SCHEDULE_EXACT_ALARM` is not the whole story on Android 13+.
///
/// The permission being granted is necessary but not sufficient: the
/// `canScheduleExactAlarms()` app-op is what `AlarmManager` actually consults, and
/// only the user can enable it on the "Alarms & reminders" system screen. Measured
/// on Android 16, the app scheduled every reminder inexactly (`exact=false`) even
/// with the manifest permission granted — 3.5 to 7 minutes late on real hardware.
///
/// Two things follow, and both are pinned here:
///
///  * the answer must be **re-read**, not cached, because the user can grant the
///    access outside the app at any time — which is exactly what the method's own
///    doc comment promises and what the code did not do; and
///  * the user must be able to reach that screen from a user-initiated tap.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('flutter.baseflow.com/permissions/methods');

  /// `Permission.scheduleExactAlarm.value` from permission_handler.
  const scheduleExactAlarm = 34;

  /// `PermissionStatus` wire values, as permission_handler serialises them.
  const denied = 0;
  const granted = 1;
  const permanentlyDenied = 2;

  var status = denied;
  var statusReads = 0;
  final requested = <int>[];

  /// `Permission.notification` from permission_handler, and its answer. Separate
  /// from the exact-alarm fixtures: the two permissions are read through the same
  /// channel and must not share one value.
  const notification = 17;
  var notificationStatus = denied;

  setUp(() {
    status = denied;
    statusReads = 0;
    requested.clear();
    notificationStatus = denied;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      switch (call.method) {
        case 'checkPermissionStatus':
          // The channel carries one permission index per call, so the answer has
          // to be selected by it — otherwise the exact-alarm fixtures and the
          // notification fixtures would silently share one value.
          final which = call.arguments;
          if (which == notification) return notificationStatus;
          statusReads++;
          return status;
        case 'requestPermissions':
          final args = call.arguments;
          if (args is List) {
            requested.addAll(args.whereType<int>());
          }
          return <int, int>{scheduleExactAlarm: status};
        case 'shouldShowRequestPermissionRationale':
          return false;
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('a background denial is not cached, so a later grant takes effect', () async {
    final notifications = FlutterLocalReminderNotifications();

    // The reconciler's path: read-only, no prompting.
    expect(await notifications.ensureExactAlarmPermission(), isFalse);
    expect(statusReads, 1);

    // The user has now turned the access on in Android's "Alarms & reminders"
    // screen. The next sync must upgrade the reminders to exact alarms; caching the
    // denial meant it kept scheduling everything inexactly until the user happened
    // to tap something in the reminders screen.
    status = granted;
    expect(
      await notifications.ensureExactAlarmPermission(),
      isTrue,
      reason:
          'a denial from the background path must not be cached — the doc '
          'comment promises the grant "takes effect without restarting the app"',
    );
  });

  test('a grant is cached, so the status is not re-read on every sync', () async {
    status = granted;
    final notifications = FlutterLocalReminderNotifications();

    expect(await notifications.ensureExactAlarmPermission(), isTrue);
    expect(statusReads, 1);

    expect(await notifications.ensureExactAlarmPermission(), isTrue);
    expect(statusReads, 1, reason: 'a grant is stable; re-reading it is not needed');
  });

  test('the interactive path reaches Android with the exact-alarm request', () async {
    final notifications = FlutterLocalReminderNotifications();

    final allowed = await notifications.ensureExactAlarmPermission(
      interactive: true,
    );

    expect(allowed, isFalse);
    expect(
      requested,
      contains(scheduleExactAlarm),
      reason:
          'the tapped path is the only one allowed to open the system screen, and '
          'it must actually ask for the access',
    );
  });

  test('the background path never asks Android for anything', () async {
    final notifications = FlutterLocalReminderNotifications();

    expect(await notifications.ensureExactAlarmPermission(), isFalse);

    expect(
      requested,
      isEmpty,
      reason:
          'Play restricts SCHEDULE_EXACT_ALARM: the app may direct the user to the '
          'system screen, never throw them into it from a background reconcile',
    );
  });

  // ─── POST_NOTIFICATIONS ─────────────────────────────────────────────────────
  //
  // The reminder path never checked this permission. `SCHEDULE_EXACT_ALARM` being
  // granted and the alarm being armed in `dumpsys alarm` were both verified on the
  // OnePlus 9R, the reminder came due with the screen dozing, and Android posted
  // nothing — `dumpsys notification | grep pkg=com.leadup.nova` stayed empty
  // through 20s polling. Reading the permission is what lets the app say so.

  test('a denied POST_NOTIFICATIONS reads as blocked', () async {
    notificationStatus = denied;
    final notifications = FlutterLocalReminderNotifications();

    expect(
      await notifications.osPermissionGranted(),
      isFalse,
      reason: 'a denied runtime permission is why the user hears nothing',
    );
  });

  test('a granted POST_NOTIFICATIONS reads as allowed', () async {
    notificationStatus = granted;
    final notifications = FlutterLocalReminderNotifications();

    expect(await notifications.osPermissionGranted(), isTrue);
  });

  test('a permanently denied permission reads as blocked too', () async {
    // Revoking the permission in Android settings is the other way into this
    // state, and the copy has to appear then as well.
    notificationStatus = permanentlyDenied;
    final notifications = FlutterLocalReminderNotifications();

    expect(await notifications.osPermissionGranted(), isFalse);
  });

  test('an unreadable switch is not treated as blocked', () async {
    // The failure direction that matters: raising "notifications are off" on the
    // strength of a failed platform call would be a lie the user cannot act on.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      throw PlatformException(code: 'error', message: 'no bridge');
    });

    expect(await FlutterLocalReminderNotifications().osPermissionGranted(), isTrue);
  });

  test('reading the permission never prompts for it', () async {
    notificationStatus = denied;
    final notifications = FlutterLocalReminderNotifications();

    await notifications.osPermissionGranted();

    expect(
      requested,
      isEmpty,
      reason:
          'reconciliation runs in the background; it may know the answer but '
          'asking is the reminders screen\'s job, after its own disclosure',
    );
  });

  test('the settings route reaches Android and reports whether it opened', () async {
    final settings = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('nova/notification_settings'),
      (call) async {
        settings.add(call.method);
        return true;
      },
    );
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('nova/notification_settings'),
        null,
      );
    });

    expect(
      await FlutterLocalReminderNotifications().openNotificationSettings(),
      isTrue,
    );
    expect(
      settings,
      <String>['openNotificationSettings'],
      reason:
          'a permanently denied permission can only be re-granted in Android '
          'settings, so this route is the whole point of the warning card',
    );
  });
}
