// The typed-message path: device → API → AI → device, on the real app.
//
// ## Why this file exists
//
// §56 step 6 of the acceptance test asks the console to show a user's **AI request** alongside the
// user, task and reminder. The reminder half had been proven end to end on the emulator; the AI half
// had not, and the reason was mechanical: the Converse screen submits through the keyboard's IME
// *send* action (`textInputAction: TextInputAction.send`, `onSubmitted`), which `adb shell input`
// cannot press — `KEYCODE_ENTER` inserts a newline in that multiline field. Driving the app from the
// shell therefore could not reach this code path at all.
//
// A Flutter test on the device can: `tester.testTextInput.receiveAction(TextInputAction.send)` is
// the IME action, delivered through the same channel the keyboard uses. Nothing else is faked — this
// boots the **real** app through `bootstrapDependencies()`, over `adb reverse`, against the real API,
// which calls the real provider. The reply that comes back is the AI's.
//
// ## What it proves, and what it does not
//
// It proves the typed-message round trip works on a device image and that the transcript renders the
// assistant's answer. It does **not** prove anything about voice capture, wake word or the overlay,
// and it runs on an emulator rather than physical hardware — the distinction §20 of the production
// report keeps making.
//
// The marker string is printed so the operator-side check can find this exact conversation from the
// console afterwards; the assertion here is the device half of that chain.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'e2e_support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('E2E converse (device)', () {
    testWidgets('a typed message reaches the AI and its answer renders', (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      await wipeDeviceState();
      final account = await api.register(tag: 'converse');
      // Printed so the console-side check can locate this account's conversation without guessing.
      // ignore: avoid_print
      print('[e2e][converse] account=${account.email} userId=${account.userId}');

      await seedSession(account);
      await launchRealApp(tester);
      await pumpFor(tester, const Duration(seconds: 8));

      // The home surface, so a failure below is attributable to the next step rather than to boot.
      expect(
        visibleText(tester).any((String text) => text.contains('NOVA') || text.contains('Good')),
        isTrue,
        reason: 'the app did not reach a signed-in surface: ${visibleText(tester)}',
      );

      // Open Converse from the bottom navigation.
      final Finder converseTab = find.text('Converse');
      expect(converseTab, findsWidgets, reason: 'no Converse destination: ${visibleText(tester)}');
      await tester.tap(converseTab.first);
      await pumpFor(tester, const Duration(seconds: 3));

      // "Start one" is the empty-state button; the composer is behind it.
      final Finder startOne = find.text('Start one');
      if (startOne.evaluate().isNotEmpty) {
        await tester.tap(startOne.first);
        await pumpFor(tester, const Duration(seconds: 3));
      }

      final Finder composer = find.widgetWithText(TextField, 'Type a message…');
      expect(
        composer,
        findsOneWidget,
        reason: 'the composer is not on screen: ${visibleText(tester)}',
      );

      // A marker the operator side can search for, and a reply the model can produce without a tool
      // call — this test is about the round trip, not about tool use.
      //
      // **Two rejected versions of this assertion, both of which passed without observation.**
      //
      // The first asked the model for "ACK" and then waited for a visible `ACK` — which the user's own
      // message satisfied instantly, so the test passed while the screen still read "Thinking…". The
      // second asked for a token like `ZZQ78170` and waited for that, and it also matched the user's
      // message; worse, the token was an uppercase-then-digits shape that the API's PII redactor
      // rewrites to `[REDACTED]`, so the model never even saw it. The transcript showed `NOVA` followed
      // by `[REDACTED]`, which is the redaction working exactly as designed on a "random" test value.
      //
      // So the reply token is a plain word that matches no redaction pattern, and the assertion is
      // structural rather than textual: capture what is on screen *before* sending, then wait for a
      // text that was not there before and is not the user's own message.
      final String marker = 'e2e-marker-${DateTime.now().millisecondsSinceEpoch}';
      const String replyWord = 'serendipity';
      final String prompt = 'Reply with the single word $replyWord and nothing else. (log ref $marker)';
      // ignore: avoid_print
      print('[e2e][converse] sending: $prompt');

      // What is on screen before the turn, so "something new arrived" is decidable.
      final Set<String> before = visibleText(tester).toSet();

      await tester.enterText(composer, prompt);
      await tester.pump();

      // **The step `adb` could not perform.** This is the IME action the on-screen keyboard sends,
      // delivered through the same channel, so `onSubmitted` runs exactly as it does for a person.
      await tester.testTextInput.receiveAction(TextInputAction.send);
      // ignore: avoid_print
      print('[e2e][converse] sent the IME action');

      // The user's own message renders immediately; that alone does not prove the network call.
      await waitFor(
        tester,
        find.textContaining(marker),
        timeout: const Duration(seconds: 10),
        reason: 'the sent message never appeared in the transcript',
      );

      // A new, non-prompt line that is not the thinking indicator — visible only once the API has
      // reached the provider and returned. Generous timeout: this is a real model call, not a fixture.
      // Chrome that appears with the transcript and is not the assistant's answer. Named explicitly:
      // the previous version accepted any new line and matched the `YOU` label, so it "found the
      // reply" the instant the user's own message rendered — the third variant of the same mistake.
      const Set<String> chrome = <String>{
        'YOU',
        'NOVA',
        'THINKING',
        'READY',
        'Ready',
        'Thinking…',
        'Report',
      };
      List<String> newLines() => visibleText(tester)
          .where((String text) => !before.contains(text) && !text.contains(marker))
          .where((String text) => !chrome.contains(text.trim()))
          .where((String text) => !text.contains('Thinking') && !text.contains('THINKING'))
          .where((String text) => text.trim().length > 2)
          .toList();

      await waitUntil(
        tester,
        () async => newLines().isNotEmpty,
        timeout: const Duration(seconds: 90),
        reason: 'no assistant turn rendered: ${visibleText(tester)}',
      );

      final List<String> transcript = visibleText(tester);
      final List<String> assistantLines = newLines();
      // ignore: avoid_print
      print('[e2e][converse] assistant turn: $assistantLines');
      // ignore: avoid_print
      print('[e2e][converse] full transcript: $transcript');

      expect(
        transcript.any((String text) => text.contains(marker)),
        isTrue,
        reason: 'the transcript lost the user message after the reply arrived',
      );
      // The word was asked for by the prompt and is checked case-insensitively against the assistant's
      // own turn only, so the user's message cannot satisfy it.
      expect(
        assistantLines.any((String text) => text.toLowerCase().contains(replyWord)),
        isTrue,
        reason: 'the assistant turn did not contain the requested word: $assistantLines',
      );

      // ignore: avoid_print
      print('[e2e][converse] PASS account=${account.email} marker=$marker replyWord=$replyWord');
    });
  });
}
