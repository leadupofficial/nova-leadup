import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/voice/wake_word_service.dart';

/// A wake word is identified by its asset key in
/// `android/app/src/main/assets/wakeword/models.json` (`hey_nova`), and every
/// user-facing surface humanises it through [humanizeWakeWordName]. The same
/// function is implemented a second time in Kotlin
/// (`WakeWordService.humanizeWakeWordName`) because the notification shade cannot
/// call Dart, and the comment on each claims the two mirror each other.
///
/// They did not. Java's `\s` is ASCII-only while Dart's follows ECMAScript
/// (Unicode `Zs`, `\u2028`/`\u2029`, `\ufeff`), so `hey\u00a0nova` already rendered
/// as two words on this side and as one on the other. The Kotlin separator class
/// was widened to match this one; the table below is the contract both sides now
/// pin, and its Kotlin twin is
/// `WakeWordServiceTest.theTwoHumanisersAgreeOnTheSharedTable`.
///
/// A code point that is not a separator keeps the raw character inside the token, so
/// the token is only upper-cased on its first character. Rows 26 and 27 pin that:
/// neither a zero-width space (U+200B) nor NEL (U+0085) splits a name.
///
/// One divergence remains and is deliberately not pinned here because it cannot be
/// reconciled without shipping a case table: Java's first-character upper-casing uses
/// a newer Unicode version than Dart's. They agree on every ASCII, Latin-1 and
/// Greek/Cyrillic letter, and differ on 199 BMP code points whose case pairs were
/// added in later Unicode versions — Georgian Mtavruli (U+10D0-U+10FF),
/// Abkhaz (U+AB70-U+ABBF), Cherokee small (U+13F8-U+13FD) and a scattering of
/// Latin/Cyrillic extended letters. Neither can appear in a wake word asset key.
void main() {
  group('humanizeWakeWordName', () {
    for (final row in _sharedTable) {
      test(row.label, () {
        expect(
          humanizeWakeWordName(row.raw),
          row.expected,
          reason:
              'shared table row "${row.label}" '
              '(raw code units ${row.raw.codeUnits})',
        );
      });
    }

    test('the shipped asset key is humanised, not echoed', () {
      // `models.json` ships exactly one entry, named `hey_nova`.
      expect(humanizeWakeWordName('hey_nova'), 'Hey Nova');
    });
  });
}

/// The contract shared with the Kotlin implementation. Keep the rows and their
/// order identical to `SHARED_HUMANISER_TABLE` in
/// `android/app/src/test/java/com/leadup/nova/WakeWordServiceTest.kt`.
const List<({String label, String raw, String expected})> _sharedTable = [
  (label: 'the shipped asset key', raw: 'hey_nova', expected: 'Hey Nova'),
  (label: 'separators already spaced', raw: 'hey nova', expected: 'Hey Nova'),
  (
    label: 'hyphen with a capitalised word',
    raw: 'Hey-Nova',
    expected: 'Hey Nova',
  ),
  (
    label: 'a run of separators collapses',
    raw: 'hey__nova',
    expected: 'Hey Nova',
  ),
  (
    label: 'leading and trailing separators are dropped',
    raw: '_hey_nova_',
    expected: 'Hey Nova',
  ),
  (
    label: 'a mixed separator run collapses',
    raw: 'hey- nova',
    expected: 'Hey Nova',
  ),
  (
    label: 'surrounding spaces are dropped',
    raw: '  hey_nova  ',
    expected: 'Hey Nova',
  ),
  (
    label: 'already upper case is preserved',
    raw: 'HEY_NOVA',
    expected: 'HEY NOVA',
  ),
  (label: 'mixed case', raw: 'Hey_Nova', expected: 'Hey Nova'),
  (label: 'a single word', raw: 'alexa', expected: 'Alexa'),
  (label: 'a second typical key', raw: 'hey_jarvis', expected: 'Hey Jarvis'),
  (label: 'a trailing digit', raw: 'nova_2', expected: 'Nova 2'),
  (
    label: 'a digit inside a word is not a separator',
    raw: 'hey2nova',
    expected: 'Hey2nova',
  ),
  (
    label: 'a leading digit has no upper case',
    raw: '2hey_nova',
    expected: '2hey Nova',
  ),
  (label: 'a single character', raw: 'h', expected: 'H'),
  (label: 'the empty string', raw: '', expected: ''),
  (label: 'separators only', raw: '___', expected: ''),
  (label: 'a tab', raw: 'hey\tnova', expected: 'Hey Nova'),
  (label: 'a newline', raw: 'hey\nnova', expected: 'Hey Nova'),
  (
    label: 'a non-breaking space is a separator in both',
    raw: 'hey\u00a0nova',
    expected: 'Hey Nova',
  ),
  (
    label: 'an ideographic space is a separator in both',
    raw: 'hey\u3000nova',
    expected: 'Hey Nova',
  ),
  (
    label: 'an em space is a separator in both',
    raw: 'hey\u2003nova',
    expected: 'Hey Nova',
  ),
  (
    label: 'a line separator is a separator in both',
    raw: 'hey\u2028nova',
    expected: 'Hey Nova',
  ),
  (
    label: 'a narrow no-break space is a separator in both',
    raw: 'hey\u202fnova',
    expected: 'Hey Nova',
  ),
  (
    label: 'a zero-width no-break space is a separator in both',
    raw: 'hey\ufeffnova',
    expected: 'Hey Nova',
  ),
  (
    label: 'a repeated non-breaking space collapses',
    raw: 'wake\u00a0\u00a0word',
    expected: 'Wake Word',
  ),
  (
    label: 'a zero-width space is not a separator',
    raw: 'hey\u200bnova',
    expected: 'Hey\u200bnova',
  ),
  (
    label: 'NEL is not a separator',
    raw: 'hey\u0085nova',
    expected: 'Hey\u0085nova',
  ),
];
