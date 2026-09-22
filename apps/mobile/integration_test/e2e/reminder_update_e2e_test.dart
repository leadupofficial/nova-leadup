// The update path: an existing reminder is moved by asking, and the operator sees the new time.
//
// ## Why this file exists
//
// §56 steps 11 and 12 are *"user says: remind me again this evening"* and *"admin sees the updated
// reminder"*. Creating a reminder had been proven on the device (`task_creation_e2e_test.dart` does the
// same for a task), and **changing** one had not. The two are different code paths: an update needs the
// model to name an existing row to `update_reminder`, which only works because the grounding block
// emits `[id: …]` tags — a reminder is otherwise unaddressable from a natural instruction, and the tool
// would have nothing to target.
//
// ## What it asserts, and why not an exact instant
//
// The user's timezone is `Asia/Kolkata` while the server runs UTC, so "the day after tomorrow at 9am" is
// a local expression that the model converts. Asserting an exact UTC instant would be asserting the
// model's timezone arithmetic rather than the update, and would break on a DST or timezone change for
// reasons that have nothing to do with the platform.
//
// The assertion is therefore on the **change**, which is unambiguous: the reminder's `trigger_at` must
// move forward by at least a day when asked to move it two days out, the row must keep its id, and the
// new time must be in the future. That is what "the update happened as asked" means, and it cannot be
// satisfied by a no-op.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'e2e_support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('E2E reminder update (device)', () {
    testWidgets('asking NOVA to move a reminder moves it, and the id survives', (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      await wipeDeviceState();
      final account = await api.register(tag: 'movereminder');
      // ignore: avoid_print
      print('[e2e][move] account=${account.email} userId=${account.userId}');

      // Created through the API so the "before" is known exactly. The conversational creation path is
      // covered by the reminder acknowledgement run; what is under test here is the change.
      const String title = 'call the accountant about the quarterly filing';
      final DateTime originalFire = DateTime.now().toUtc().add(const Duration(hours: 2));
      final Map<String, dynamic> created = await api.createReminder(
        account.accessToken,
        title: title,
        triggerAt: originalFire,
      );
      final String reminderId = (created['id'] ?? created['reminderId'] ?? '').toString();
      // ignore: avoid_print
      print('[e2e][move] created reminder id=$reminderId at ${originalFire.toIso8601String()}');

      // Read it back before trusting the update: a create that did not land would make an unchanged
      // time look like a correct refusal to update.
      final List<Map<String, dynamic>> before = await api.listReminders(account.accessToken);
      final Map<String, dynamic> rowBefore = before.firstWhere(
        (Map<String, dynamic> row) => (row['id'] ?? '').toString() == reminderId,
        orElse: () => <String, dynamic>{},
      );
      expect(rowBefore, isNotEmpty, reason: 'the reminder was not created, so the update cannot be tested');
      final DateTime beforeAt = DateTime.parse((rowBefore['triggerAt'] ?? rowBefore['trigger_at']).toString());
      expect(
        beforeAt.difference(originalFire).inMinutes.abs() <= 2,
        isTrue,
        reason: 'the stored time does not match what was requested: $beforeAt vs $originalFire',
      );

      await seedSession(account);
      await launchRealApp(tester);
      await pumpFor(tester, const Duration(seconds: 8));

      final Finder converseTab = find.text('Converse');
      expect(converseTab, findsWidgets, reason: 'no Converse destination: ${visibleText(tester)}');
      await tester.tap(converseTab.first);
      await pumpFor(tester, const Duration(seconds: 3));

      final Finder startOne = find.text('Start one');
      if (startOne.evaluate().isNotEmpty) {
        await tester.tap(startOne.first);
        await pumpFor(tester, const Duration(seconds: 3));
      }

      final Finder composer = find.widgetWithText(TextField, 'Type a message…');
      expect(composer, findsOneWidget, reason: 'the composer is not on screen: ${visibleText(tester)}');

      // Two days out, at a time the model has to resolve in the user's zone. No digits in the reminder
      // title: the API's PII redactor rewrites letters-adjacent-to-digits, which cost a debugging round
      // in the reminder-creation test.
      const String instruction =
          'Move my reminder about the accountant to the day after tomorrow at nine in the morning. '
          'Do not ask me any follow-up questions.';

      final Set<String> beforeScreen = visibleText(tester).toSet();
      await tester.enterText(composer, instruction);
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      // ignore: avoid_print
      print('[e2e][move] sent the IME action');

      // The assistant's own turn, excluding the user's message and transcript chrome — the same shape
      // the other device tests use, for the same reason: a substring check on the whole screen can be
      // satisfied by the user's own text.
      const Set<String> chrome = <String>{'YOU', 'NOVA', 'THINKING', 'READY', 'Ready', 'Thinking…', 'Report'};
      List<String> assistantLines() => visibleText(tester)
          .where((String text) => !beforeScreen.contains(text))
          .where((String text) => !chrome.contains(text.trim()))
          .where((String text) => !text.contains('Move my reminder'))
          .where((String text) => text.trim().length > 2)
          .toList();

      await waitUntil(
        tester,
        () async => assistantLines().isNotEmpty,
        timeout: const Duration(seconds: 90),
        reason: 'no assistant turn rendered: ${visibleText(tester)}',
      );
      // ignore: avoid_print
      print('[e2e][move] assistant turn: ${assistantLines()}');

      // The store is the thing that matters; give the tool call a moment to commit after the reply.
      DateTime? afterAt;
      for (int attempt = 0; attempt < 20; attempt += 1) {
        final List<Map<String, dynamic>> after = await api.listReminders(account.accessToken);
        final Map<String, dynamic> rowAfter = after.firstWhere(
          (Map<String, dynamic> row) => (row['id'] ?? '').toString() == reminderId,
          orElse: () => <String, dynamic>{},
        );
        if (rowAfter.isNotEmpty) {
          final DateTime candidate = DateTime.parse((rowAfter['triggerAt'] ?? rowAfter['trigger_at']).toString());
          if (candidate.difference(beforeAt).inHours.abs() >= 12) {
            afterAt = candidate;
            break;
          }
        }
        await pumpFor(tester, const Duration(seconds: 1));
      }

      // ignore: avoid_print
      print('[e2e][move] before=${beforeAt.toIso8601String()} after=${afterAt?.toIso8601String()}');
      expect(
        afterAt,
        isNotNull,
        reason: 'the reminder was not moved. The model was asked to change it and the row still reads '
            '${beforeAt.toIso8601String()}',
      );

      // The properties that make it an update rather than a delete-and-recreate.
      final List<Map<String, dynamic>> finalRows = await api.listReminders(account.accessToken);
      expect(
        finalRows.any((Map<String, dynamic> row) => (row['id'] ?? '').toString() == reminderId),
        isTrue,
        reason: 'the reminder id changed — the update replaced the row instead of editing it',
      );
      expect(afterAt!.isAfter(DateTime.now().toUtc()), isTrue, reason: 'the new time is in the past');
      expect(
        afterAt.difference(beforeAt).inHours,
        greaterThanOrEqualTo(24),
        reason: 'moving a reminder two days out must move it at least a day',
      );

      // ignore: avoid_print
      print('[e2e][move] PASS account=${account.email} reminderId=$reminderId '
          'before=${beforeAt.toIso8601String()} after=${afterAt.toIso8601String()}');
    });
  });
}
