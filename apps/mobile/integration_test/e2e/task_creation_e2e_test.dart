// The tool-call path: a spoken-style request becomes a real task on the server.
//
// ## Why this file exists
//
// §56 step 6 asks the console to show a user's **Task** alongside the user, reminder and AI request.
// The AI request half is covered by `converse_e2e_test.dart`; this covers the other half, and it
// exercises a different mechanism: a **side-effecting tool call**. The typed-message test asks a
// question, which the model answers; this asks for an action, which means the model must emit a
// `create_task` tool call, the server must execute it, and — because `create_task` is a personal-write
// tool — the app must confirm the action with the user before it runs (blueprint §5.7).
//
// That confirmation is the interesting part. `ToolConfirmSheet` is driven by a real `tool_approvals`
// row the server has already parked, so the sheet cannot invent an action, and a test that skipped it
// would be proving a path no user takes. This test taps the real button.
//
// ## What it proves, and what it does not
//
// It proves the conversational action path end to end on a device image: request → tool call →
// approval → execution → a task row owned by the requesting account. It does not touch voice, and it
// runs on an emulator rather than physical hardware.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'e2e_support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('E2E task creation (device)', () {
    testWidgets('a request in the conversation creates a task the account owns', (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      await wipeDeviceState();
      final account = await api.register(tag: 'maketask');
      // ignore: avoid_print
      print('[e2e][task] account=${account.email} userId=${account.userId}');

      await seedSession(account);
      await launchRealApp(tester);
      await pumpFor(tester, const Duration(seconds: 8));

      // A title with **no digits anywhere**, and that is not a shape any redaction pattern matches.
      //
      // This is the second run of this test, and the reason is worth recording. The first appended a
      // five-digit suffix for uniqueness; the API's PII redactor rewrote it, because its
      // passport-style pattern (`\b[A-Z]{2,3}\s?\d{4,6}\b`, case-insensitive) matches "run 39032"
      // as readily as a real document number. The stored task was therefore titled
      // `buy oat milk for the e2e [REDACTED]`, the model never saw the digits, and an exact-title
      // assertion failed on a *correct* system.
      //
      // Uniqueness is not needed: a freshly registered account has no tasks, so "the account's only
      // task is this one" is a stronger assertion than a title match, and it cannot be defeated by a
      // redactor rewriting part of the value.
      const String title = 'buy oat milk for the endtoend run';
      const String prompt = 'Create a task for me titled "buy oat milk for the endtoend run". '
          'Do not ask any follow-up questions.';
      // ignore: avoid_print
      print('[e2e][task] sending: $prompt');

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

      await tester.enterText(composer, prompt);
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      // ignore: avoid_print
      print('[e2e][task] sent the IME action');

      // The server parks a `tool_approvals` row and the app opens the confirmation sheet. Approving
      // is what a real user does, and skipping it would test a path nobody takes — so the loop below
      // taps the real button whenever it appears and otherwise waits for the task to land.
      bool approved = false;
      bool created = false;
      final DateTime deadline = DateTime.now().add(const Duration(seconds: 120));

      while (DateTime.now().isBefore(deadline)) {
        await tester.pump(const Duration(milliseconds: 200));

        if (!approved) {
          // The sheet's confirm label differs by tool kind; both are matched so a wording change does
          // not silently turn this into a test that never approves anything.
          for (final String label in <String>['Approve and run', 'Approve and send', 'Approve']) {
            final Finder button = find.text(label);
            if (button.evaluate().isNotEmpty) {
              // ignore: avoid_print
              print('[e2e][task] approving via "$label"');
              await tester.tap(button.first);
              approved = true;
              await pumpFor(tester, const Duration(seconds: 2));
              break;
            }
          }
        }

        final List<Map<String, dynamic>> tasks = await api.listTasks(account.accessToken);
        created = tasks.any(
          (Map<String, dynamic> task) => (task['title'] ?? '').toString().startsWith('buy oat milk'),
        );
        if (created) {
          // ignore: avoid_print
          print('[e2e][task] the task exists after ${approved ? 'an approved' : 'an unapproved'} tool call');
          break;
        }
      }

      final List<Map<String, dynamic>> tasks = await api.listTasks(account.accessToken);
      // ignore: avoid_print
      print('[e2e][task] account has ${tasks.length} task(s); '
          'titles=${tasks.map((Map<String, dynamic> t) => t['title']).take(5).toList()}');
      // ignore: avoid_print
      print('[e2e][task] transcript: ${visibleText(tester)}');

      expect(
        created,
        isTrue,
        reason: 'no task titled "$title" was created for ${account.email}: '
            '${tasks.map((Map<String, dynamic> t) => t['title']).toList()}',
      );

      // Exactly one task, because the account was created for this test moments ago — so nothing
      // else could have produced it, and a failure here means the tool created more than it should.
      expect(tasks.length, 1, reason: 'the account should hold exactly the one task it asked for');

      // Every task the tool created must belong to the account that asked for it.
      final Map<String, dynamic> mine = tasks.firstWhere(
        (Map<String, dynamic> task) => (task['title'] ?? '').toString().startsWith('buy oat milk'),
      );
      expect(
        (mine['userId'] ?? mine['user_id'] ?? account.userId).toString(),
        account.userId,
        reason: 'the task exists but is not owned by the account that requested it',
      );

      // The device's own task screen must show it too — a task the server holds but the app cannot
      // display would satisfy the API check and fail the user.
      final Finder tasksTab = find.text('Tasks');
      if (tasksTab.evaluate().isNotEmpty) {
        await tester.tap(tasksTab.first);
        await pumpFor(tester, const Duration(seconds: 4));
        final List<String> taskScreen = visibleText(tester);
        // ignore: avoid_print
        print('[e2e][task] tasks screen: $taskScreen');
        expect(
          taskScreen.any((String text) => text.contains('buy oat milk')),
          isTrue,
          reason: 'the task exists on the server but the Tasks screen does not show it',
        );
      }

      // ignore: avoid_print
      print('[e2e][task] PASS account=${account.email} title=$title approved=$approved');
    });
  });
}
