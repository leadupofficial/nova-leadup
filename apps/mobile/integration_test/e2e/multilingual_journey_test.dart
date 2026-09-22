// A real person, on a real handset, speaking each Indian language NOVA claims.
//
// ## Why this file exists
//
// Every other multilingual check in this repository talks to the API directly.
// That proves the pipeline and proves nothing about the app: the shipped client
// sets the language, chooses the provider and renders the reply, and until this
// test none of those three had been exercised together on hardware for a single
// language other than Tamil.
//
// So this boots the **real** application (`bootstrapDependencies()`, the same
// entry point `main()` uses) on the handset, signs in a real account against the
// real API, and *types* — through the composer, with the same IME action a
// person's keyboard sends, because `adb shell input` cannot press that action
// and cannot type a single Devanagari character.
//
// ## What it asserts, and why these assertions
//
// The question a user asks is not "was the reply in the right script". It is
// "did the thing I asked for get done". So the load-bearing assertion is the
// **reminder count on the server**, read back over HTTP between turns: one more
// per turn, in every language. The script check rides alongside it because a
// reply in the wrong language is the difference between a product and a demo.
//
// Measured before the fixes this test was written to lock down: the invented-time
// guard (`services/api/src/services/stated-time.ts`) knew only English and Tamil
// clock-time wording, so `create_reminder` failed on every Hindi, Telugu, Kannada
// and Bengali turn — three times each, to the iteration cap — while the reply
// still came back in the right language, which is exactly the shape of failure a
// reply-only test would have called a pass.

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_mobile/config/api_config.dart';

import 'e2e_support.dart';

/// One language, one thing a person would actually say to it.
class LanguageCase {
  const LanguageCase(this.label, this.request, this.expectScript);

  final String label;
  final String request;

  /// Substring that must appear in NOVA's reply, or null when the language is a
  /// mixed one where either script is a legitimate answer.
  final String? expectScript;
}

const List<LanguageCase> kCases = <LanguageCase>[
  LanguageCase('Tamil', 'நாளைக்கு காலை எட்டு மணிக்கு மாத்திரை போட ரிமைண்டர் வை', 'Tamil'),
  LanguageCase('Hindi', 'कल सुबह आठ बजे दवा लेने का रिमाइंडर लगा दो', 'Devanagari'),
  LanguageCase('Telugu', 'రేపు ఉదయం ఎనిమిది గంటలకు మందు వేసుకోవడానికి రిమైండర్ పెట్టు', 'Telugu'),
  LanguageCase('Kannada', 'ನಾಳೆ ಬೆಳಿಗ್ಗೆ ಎಂಟು ಗಂಟೆಗೆ ಔಷಧಿ ತೆಗೆದುಕೊಳ್ಳಲು ರಿಮೈಂಡರ್ ಹಾಕು', 'Kannada'),
  LanguageCase('Bengali', 'আগামীকাল সকাল আটটায় ওষুধ খাওয়ার একটা রিমাইন্ডার সেট করো', 'Bengali'),
  LanguageCase('Malayalam', 'നാളെ രാവിലെ എട്ട് മണിക്ക് മരുന്ന് കഴിക്കാൻ ഒരു റിമൈൻഡർ വെക്കൂ', 'Malayalam'),
  LanguageCase('Marathi', 'उद्या सकाळी आठ वाजता औषध घेण्याचे रिमाइंडर लाव', 'Devanagari'),
  // The mixed varieties: the answer may legitimately be either script, since
  // "match the mix" is the instruction, so only the outcome is asserted.
  LanguageCase('Tanglish', 'Naalai kaalai 8 manikku tablet poda reminder set pannu', null),
  LanguageCase('Hinglish', 'Kal subah 8 baje dawa lene ka reminder laga do', null),
];

/// Which script a string is mostly written in, for the assertion message and the
/// PASS/FAIL line. Ranges are the Unicode blocks of the scripts involved.
String scriptOf(String text) {
  const Map<String, List<int>> ranges = <String, List<int>>{
    'Tamil': <int>[0x0B80, 0x0BFF],
    'Devanagari': <int>[0x0900, 0x097F],
    'Telugu': <int>[0x0C00, 0x0C7F],
    'Kannada': <int>[0x0C80, 0x0CFF],
    'Bengali': <int>[0x0980, 0x09FF],
    'Malayalam': <int>[0x0D00, 0x0D7F],
  };
  final Map<String, int> counts = <String, int>{};
  for (final int rune in text.runes) {
    for (final MapEntry<String, List<int>> entry in ranges.entries) {
      if (rune >= entry.value[0] && rune <= entry.value[1]) {
        counts[entry.key] = (counts[entry.key] ?? 0) + 1;
      }
    }
  }
  if (counts.isEmpty) return 'Latin/none';
  return counts.entries.reduce((a, b) => a.value >= b.value ? a : b).key;
}

/// Transient status lines that are not the assistant's answer.
bool _isPlaceholder(String text) {
  final String t = text.trim();
  return t == 'Thinking…' ||
      t == 'Thinking...' ||
      t == 'Thinking' ||
      t == 'Listening…' ||
      t == 'Listening...' ||
      t == 'Sending…' ||
      t == 'Ready' ||
      t == 'Tap to talk' ||
      t.isEmpty;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a person holds a conversation in each Indian language and each one sets its reminder',
      (WidgetTester tester) async {
    assertApiConfigured();
    final E2eApi api = E2eApi();
    addTearDown(api.close);
    final Dio dio = Dio(BaseOptions(baseUrl: ApiConfig.baseUrl));

    await wipeDeviceState();
    final E2eAccount account =
        (await tester.runAsync<E2eAccount>(() => api.register(tag: 'multilingual')))!;
    // ignore: avoid_print
    print('[multilingual] account=${account.email} userId=${account.userId}');
    await seedSession(account);
    dio.options.headers['Authorization'] = 'Bearer ${account.accessToken}';

    Future<int> reminderCount() async {
      final Response<Map<String, dynamic>> r =
          await dio.get<Map<String, dynamic>>('/api/v1/reminders');
      final Object? data = r.data?['data'] ?? r.data;
      final Object? list = (data is Map) ? data['reminders'] : null;
      return (list is List) ? list.length : -1;
    }

    await launchRealApp(tester);
    await pumpFor(tester, const Duration(seconds: 8));

    expect(
      visibleText(tester).any((String t) => t.contains('NOVA') || t.contains('Good')),
      isTrue,
      reason: 'the app never reached a signed-in surface: ${visibleText(tester)}',
    );

    final Finder converseTab = find.text('Converse');
    expect(converseTab, findsWidgets, reason: 'no Converse destination');
    await tester.tap(converseTab.first);
    await pumpFor(tester, const Duration(seconds: 3));

    final Finder startOne = find.text('Start one');
    if (startOne.evaluate().isNotEmpty) {
      await tester.tap(startOne.first);
      await pumpFor(tester, const Duration(seconds: 3));
    }

    final List<String> report = <String>[];
    int failures = 0;
    int created = 0;

    for (final LanguageCase c in kCases) {
      final Finder composer = find.widgetWithText(TextField, 'Type a message…');
      expect(composer, findsOneWidget,
          reason: 'no composer before the ${c.label} turn: ${visibleText(tester)}');

      // Real HTTP has to run outside the widget-test fake-async zone, or the
      // await never completes: the socket reply is delivered by the real event
      // loop while the binding is pumping a fake clock. The first version of
      // this test called `reminderCount()` directly and deadlocked on its first
      // turn with the handset parked on the splash screen for half an hour.
      final int before = (await tester.runAsync<int>(reminderCount))!;

      // Focus first. The first run of this test typed into the composer without
      // tapping it, and after the first turn the field no longer held focus, so
      // the IME action went nowhere and eight of the nine turns were never sent
      // — the reminder count moved once and the replies were never even asked
      // for. A person taps the box before typing; so does this.
      await tester.tap(composer);
      await pumpFor(tester, const Duration(milliseconds: 400));
      await tester.enterText(composer, c.request);
      await pumpFor(tester, const Duration(milliseconds: 400));
      // The IME action, i.e. the same channel a real keyboard's send key uses.
      await tester.testTextInput.receiveAction(TextInputAction.send);

      // Wait for the *answer*, not merely for something new to appear. The
      // first run stopped at the first fresh line, which was the "Thinking…"
      // placeholder, and reported a Latin-script "reply" for every language
      // including the five that cannot answer in Latin script at all.
      String reply = '';
      final DateTime deadline = DateTime.now().add(const Duration(seconds: 90));
      while (DateTime.now().isBefore(deadline)) {
        await tester.pump(const Duration(milliseconds: 250));
        final List<String> fresh = visibleText(tester)
            .where((String t) => t.trim() != c.request.trim() && !_isPlaceholder(t))
            .toList();
        if (c.expectScript != null) {
          // The language is the wait condition: NOVA answering in Bengali is the
          // event this turn is about.
          final Iterable<String> inScript =
              fresh.where((String t) => scriptOf(t) == c.expectScript);
          if (inScript.isNotEmpty) {
            reply = inScript.last;
            break;
          }
        } else if (fresh.isNotEmpty) {
          reply = fresh.last;
          break;
        }
      }
      // Give the turn a moment to finish painting so the dump below is complete.
      await pumpFor(tester, const Duration(milliseconds: 500));

      // ignore: avoid_print
      print('[multilingual] ${c.label} screen after turn: ${visibleText(tester)}');

      final int after = (await tester.runAsync<int>(reminderCount))!;
      final bool didCreate = after > before;
      if (didCreate) created++;
      final String script = scriptOf(reply);

      // The outcome assertion: the thing the person asked for exists.
      if (!didCreate) failures++;
      // The language assertion, only where one script is the right answer.
      final bool scriptOk = c.expectScript == null || script == c.expectScript ||
          (c.expectScript == 'Devanagari' && script == 'Devanagari');
      if (!scriptOk) failures++;

      final String line = '${c.label.padRight(10)} reminders $before->$after '
          '${didCreate ? "CREATED" : "NOT CREATED"}  reply=${script.padRight(12)} '
          'expected=${c.expectScript ?? "either"}  ok=${didCreate && scriptOk}';
      report.add(line);
      // ignore: avoid_print
      print('[multilingual] $line');
      // ignore: avoid_print
      print('[multilingual]   reply was: ${reply.replaceAll("\n", " ").trim()}');
    }

    // ignore: avoid_print
    print('[multilingual] ===== SUMMARY =====');
    for (final String line in report) {
      // ignore: avoid_print
      print('[multilingual] $line');
    }
    // ignore: avoid_print
    print('[multilingual] created=$created/${kCases.length} failures=$failures');

    expect(
      created,
      kCases.length,
      reason: 'a spoken request in one of these languages did not create the '
          'reminder it asked for:\n${report.join("\n")}',
    );
    expect(failures, 0, reason: 'language or outcome failures:\n${report.join("\n")}');
  }, timeout: const Timeout(Duration(minutes: 20)));
}
