import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/features/reminders/reminder_recurrence.dart';

/// The client half of "remind me every Monday".
///
/// The server stores the rule and the phone has to turn it into the *next*
/// occurrence once the one it was created for is behind it — the row's
/// `trigger_at` is only the first time it goes off, and nothing server-side
/// advances it. This is the pure half of that, and it mirrors
/// `services/api/src/services/reminder-recurrence.ts` case for case, because the
/// two must agree about February.
///
/// The assertions are written against the local wall clock (`.toLocal()`), not
/// against absolute instants, so they hold in whichever zone the test machine
/// happens to be in — "every Monday at 09:00" is a wall-clock promise.
void main() {
  NovaRepeatRule rule(String text) {
    final parsed = NovaRepeatRule.tryParse(text);
    expect(parsed, isNotNull, reason: 'fixture rule $text must parse');
    return parsed!;
  }

  DateTime nextOf(NovaRepeatRule r, DateTime start, DateTime after) {
    final next = nextReminderOccurrence(rule: r, start: start, after: after);
    expect(next, isNotNull, reason: 'expected an occurrence for ${r.value}');
    return next!.toLocal();
  }

  group('NovaRepeatRule.tryParse', () {
    test('parses the three forms the server writes', () {
      expect(
        NovaRepeatRule.tryParse('FREQ=DAILY'),
        isA<NovaRepeatRule>()
            .having((r) => r.frequency, 'frequency', NovaRepeatFrequency.daily)
            .having((r) => r.interval, 'interval', 1),
      );
      expect(
        NovaRepeatRule.tryParse('FREQ=WEEKLY;BYDAY=MO'),
        isA<NovaRepeatRule>()
            .having((r) => r.frequency, 'frequency', NovaRepeatFrequency.weekly)
            .having((r) => r.weekday, 'weekday', DateTime.monday),
      );
      expect(
        NovaRepeatRule.tryParse('FREQ=MONTHLY;BYMONTHDAY=15'),
        isA<NovaRepeatRule>()
            .having((r) => r.frequency, 'frequency', NovaRepeatFrequency.monthly)
            .having((r) => r.dayOfMonth, 'dayOfMonth', 15),
      );
    });

    test('parses an interval, which the REST route can store even though the '
        'assistant does not offer it', () {
      final parsed = NovaRepeatRule.tryParse('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU');
      expect(parsed!.interval, 2);
      expect(parsed.weekday, DateTime.sunday);
    });

    test('is case-insensitive', () {
      expect(NovaRepeatRule.tryParse('freq=weekly;byday=mo')!.value, 'FREQ=WEEKLY;BYDAY=MO');
    });

    test('answers null for anything it cannot interpret, rather than throwing', () {
      // A rule this build does not understand must leave the reminder armed once,
      // not take a sync down. `null` is the safe direction: the reminder still
      // fires at its trigger, it just does not repeat.
      for (final raw in <Object?>[
        null,
        '',
        'every Monday',
        'FREQ=YEARLY',
        'FREQ=WEEKLY',
        'FREQ=DAILY;BYDAY=MO',
        'FREQ=MONTHLY;BYMONTHDAY=32',
      ]) {
        expect(NovaRepeatRule.tryParse(raw), isNull, reason: '$raw must not parse');
      }
    });
  });

  group('NovaReminder parses the server\'s repeatRule', () {
    test('reads `repeatRule` off a real payload', () {
      final reminder = NovaReminder.fromJson(<String, dynamic>{
        'id': 'aaaaaaaa-1111-4111-8111-111111111111',
        'title': 'Take the bins out',
        'triggerAt': '2027-03-01T03:30:00.000Z',
        'timezone': 'Asia/Kolkata',
        'repeatRule': 'FREQ=WEEKLY;BYDAY=MO',
        'dismissed': false,
      });

      expect(reminder.repeatRule, isNotNull);
      expect(reminder.repeatRule!.frequency, NovaRepeatFrequency.weekly);
      expect(reminder.repeatRule!.weekday, DateTime.monday);
    });

    test('leaves an uninterpretable rule as a one-shot instead of failing', () {
      final reminder = NovaReminder.fromJson(<String, dynamic>{
        'id': 'b',
        'title': 'Call the bank',
        'triggerAt': '2027-03-01T03:30:00.000Z',
        'repeatRule': 'whenever',
      });

      expect(reminder.repeatRule, isNull);
      expect(reminder.remindAt, isNotNull);
    });

    test('reads a one-shot reminder exactly as before', () {
      final reminder = NovaReminder.fromJson(<String, dynamic>{
        'id': 'c',
        'title': 'Call the bank',
        'triggerAt': '2027-03-01T03:30:00.000Z',
      });

      expect(reminder.repeatRule, isNull);
    });
  });

  group('nextReminderOccurrence', () {
    test('advances a daily rule to the same wall-clock time tomorrow', () {
      final start = DateTime(2026, 3, 2, 9);
      expect(nextOf(rule('FREQ=DAILY'), start, start), DateTime(2026, 3, 3, 9));
    });

    test('is strictly after: a rule landing exactly on `after` advances', () {
      // Returning `after` itself would re-arm the alarm in the past, and the
      // chain would stop after one occurrence.
      final start = DateTime(2026, 3, 2, 9);
      expect(nextOf(rule('FREQ=DAILY'), start, start), DateTime(2026, 3, 3, 9));
    });

    test('returns the first occurrence when asked before it begins', () {
      final start = DateTime(2026, 3, 2, 9);
      expect(nextOf(rule('FREQ=DAILY'), start, DateTime(2026, 2, 20)), start);
    });

    test('skips whole intervals instead of stepping a day at a time', () {
      final start = DateTime(2026, 1, 5, 9);
      expect(
        nextOf(rule('FREQ=DAILY;INTERVAL=3'), start, DateTime(2026, 1, 6)),
        DateTime(2026, 1, 8, 9),
      );
    });

    test('moves a weekly rule to its weekday across a month boundary', () {
      // Monday 26 January 2026 -> Monday 2 February 2026.
      final start = DateTime(2026, 1, 26, 9);
      expect(start.weekday, DateTime.monday, reason: 'the fixture must be a Monday');
      final next = nextOf(rule('FREQ=WEEKLY;BYDAY=MO'), start, DateTime(2026, 1, 27));
      expect(next, DateTime(2026, 2, 2, 9));
      expect(next.weekday, DateTime.monday);
    });

    test('holds a weekly rule at its weekday, not at "seven days later"', () {
      final start = DateTime(2026, 3, 2, 9); // Monday
      expect(nextOf(rule('FREQ=WEEKLY;BYDAY=MO'), start, DateTime(2026, 3, 3)), DateTime(2026, 3, 9, 9));
    });

    test('honours a two-week interval', () {
      final start = DateTime(2026, 1, 5, 9); // Monday
      expect(
        nextOf(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'), start, DateTime(2026, 1, 12)),
        DateTime(2026, 1, 19, 9),
      );
    });

    test('moves a monthly rule to the same day of the next month', () {
      final start = DateTime(2026, 1, 15, 9);
      expect(
        nextOf(rule('FREQ=MONTHLY;BYMONTHDAY=15'), start, DateTime(2026, 1, 20)),
        DateTime(2026, 2, 15, 9),
      );
    });

    test('skips February for a monthly rule on the 31st', () {
      // The decision, matched to the OS: Android's DAY_OF_MONTH_AND_TIME repeat
      // walks forward a day at a time until the day-of-month matches, so the phone
      // skips February for a 31st rule. Clamping here to 28 February would arm an
      // alarm the phone will never fire.
      final start = DateTime(2026, 1, 31, 9);
      final next = nextOf(rule('FREQ=MONTHLY;BYMONTHDAY=31'), start, DateTime(2026, 2, 1));
      expect(next.month, 3);
      expect(next.day, 31);
      expect(next.hour, 9);
    });

    test('skips February for the 29th in a non-leap year, and keeps it in a leap year', () {
      final nonLeap = nextOf(
        rule('FREQ=MONTHLY;BYMONTHDAY=29'),
        DateTime(2027, 1, 29, 9),
        DateTime(2027, 2, 1),
      );
      expect(nonLeap, DateTime(2027, 3, 29, 9));

      final leap = nextOf(
        rule('FREQ=MONTHLY;BYMONTHDAY=29'),
        DateTime(2028, 1, 29, 9),
        DateTime(2028, 2, 1),
      );
      expect(leap, DateTime(2028, 2, 29, 9));
    });

    test('honours a monthly interval across a year boundary', () {
      final start = DateTime(2026, 10, 10, 9);
      expect(
        nextOf(rule('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10'), start, DateTime(2026, 11, 1)),
        DateTime(2027, 1, 10, 9),
      );
    });

    test('preserves the time of day of an instant parsed from an ISO payload', () {
      // `_parseDate` already converts to local, so the hours the server sent are
      // the ones the user was shown. If this ever regressed to reading UTC fields,
      // a 09:00 reminder would be armed at 03:30 on a device in IST.
      final start = DateTime.parse('2026-03-02T03:30:00.000Z').toLocal();
      final next = nextOf(rule('FREQ=DAILY'), start, start);
      expect(next.hour, start.hour);
      expect(next.minute, start.minute);
      expect(
        next,
        DateTime(start.year, start.month, start.day + 1, start.hour, start.minute, start.second),
      );
    });
  });
}
