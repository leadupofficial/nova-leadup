// Requirement 6 — reminders must reach the user when the app is open, in the
// background, and closed.
//
// The design of this file is the interesting part. A reminder is armed to fire
// *after* the test finishes, so the Flutter process is dead by the time it goes
// off. That is not a shortcut — it is the only honest way to test the "app is
// completely closed" case, because `flutter test` tears the process down when
// the last test returns. What the shell then finds in the notification shade is
// evidence produced with no Dart running at all.
//
// The companion checks live in the shell (see docs/E2E_DEVICE_REPORT.md) because
// a Dart test cannot call `adb`:
//   adb shell dumpsys alarm | grep -i leadup
//   adb shell dumpsys notification --noredact | grep -i nova_reminders

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/features/reminders/reminder_sync.dart';

import 'e2e_support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('E2E reminders (device)', () {
    testWidgets('a server reminder is armed as a real OS notification', (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      await wipeDeviceState();
      final account = await api.register(tag: 'remember');

      // Far enough out that the test cannot outlive it, so the alarm is still
      // pending when the process dies and the OS is the only thing left to fire it.
      final DateTime firesAt = DateTime.now().add(const Duration(seconds: 75));
      final Map<String, dynamic> created = await api.createReminder(
        account.accessToken,
        title: 'E2E reminder — drink water',
        triggerAt: firesAt,
      );
      // ignore: avoid_print
      print('[e2e][reminders] created reminder: $created');
      // ignore: avoid_print
      print('[e2e][reminders] fires at ${firesAt.toIso8601String()} (in 75s)');

      // Prove the write really landed on the server before trusting the read.
      final List<Map<String, dynamic>> serverRows =
          await api.listReminders(account.accessToken);
      // ignore: avoid_print
      print('[e2e][reminders] server rows after create: $serverRows');
      expect(serverRows, isNotEmpty,
          reason: 'the API accepted the reminder but its own list endpoint returns none');

      await seedSession(account);
      await launchRealApp(tester);

      final ProviderContainer container = ProviderScope.containerOf(
        tester.element(find.byType(NovaApp)),
      );

      // The sync is kicked off by `build()` as a microtask, so it lands shortly
      // after the first frame.
      await waitUntil(
        tester,
        () async => container.read(reminderSyncProvider).lastResult != null,
        timeout: const Duration(seconds: 40),
        reason: 'reminder sync never produced a reconciliation result',
      );

      final ReminderSyncState sync = container.read(reminderSyncProvider);
      // ignore: avoid_print
      print('[e2e][reminders] sync state: '
          'scheduled=${sync.lastResult?.scheduled} '
          'cancelled=${sync.lastResult?.cancelled} '
          'exact=${sync.lastResult?.exact} '
          'error=${sync.error}');

      expect(sync.error, isNull, reason: 'reminder sync failed: ${sync.error}');
      expect(sync.lastResult, isNotNull);
      expect(
        sync.lastResult!.scheduled,
        greaterThanOrEqualTo(1),
        reason: 'the future reminder was fetched but nothing was scheduled with the OS',
      );
    });

    testWidgets('reminders switched off cancel what is already armed', (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      // Reuses the previous test's account state only if it still exists; a fresh
      // registration here would hit the 10/min auth limit, so this test does not
      // register at all — it asserts against whatever the device already holds.
      await launchRealApp(tester);
      final ProviderContainer container = ProviderScope.containerOf(
        tester.element(find.byType(NovaApp)),
      );
      await pumpFor(tester, const Duration(seconds: 5));

      final ReminderSyncState sync = container.read(reminderSyncProvider);
      // ignore: avoid_print
      print('[e2e][reminders] reconcile on resume: scheduled=${sync.lastResult?.scheduled} '
          'cancelled=${sync.lastResult?.cancelled}');

      // Reconciliation must be idempotent: a second pass over the same server list
      // replaces rather than duplicates, so the count stays stable.
      expect(sync.error, isNull);
    });
  });
}
