import '../../core/api/models.dart';

/// When a repeating reminder next comes due, from the phone's point of view.
///
/// The server stores the rule and the *first* occurrence; nothing advances
/// `trigger_at` afterwards, because there is no server-side firer at all. So the
/// phone has to answer this question itself before it can arm anything: once the
/// Monday it was created for is behind it, the reminder's own row still names
/// that Monday.
///
/// This mirrors `services/api/src/services/reminder-recurrence.ts` case for case,
/// including the one that is a decision rather than arithmetic: **a monthly rule
/// on the 29th, 30th or 31st skips a month that has no such day.** Android's own
/// repeat component (`DateTimeComponents.dayOfMonthAndTime`) walks forward a day
/// at a time until the day of the month matches, so the phone would skip February
/// for a 31st rule whatever this function said; agreeing with it is what stops the
/// alarm and the reminder's displayed date from drifting apart.
///
/// Wall-clock arithmetic, deliberately. "Every Monday at 09:00" is a promise about
/// a wall clock, and a day is not always 24 hours: `DateTime(year, month, day + 1,
/// hour, minute)` is a calendar day, while adding `Duration(days: 1)` is exactly
/// 24 hours and lands an hour late the day after a DST change.
///
/// Returns null only when there is no occurrence to find, which for a rule the
/// caller has already validated cannot happen; the caller treats null as "leave
/// this reminder alone" rather than arming something at the wrong time.
DateTime? nextReminderOccurrence({
  required NovaRepeatRule rule,
  required DateTime start,
  required DateTime after,
}) {
  // `remindAt` is parsed with `_parseDate`, which already converts to local, but
  // a caller may hand over a UTC instant directly — and the wall-clock fields of
  // a UTC `DateTime` are the wrong ones for a rule about "Monday".
  final anchor = start.toLocal();
  final bound = after.toLocal();

  final startDay = _dayNumber(anchor);
  final boundDay = _dayNumber(bound);

  DateTime at(int dayNumber) => _wallClock(anchor, dayNumber);

  switch (rule.frequency) {
    case NovaRepeatFrequency.daily:
      // Jump whole intervals rather than walking: a rule anchored years ago must
      // not cost one iteration per day.
      final elapsed = boundDay - startDay;
      var step = elapsed > 0 ? elapsed ~/ rule.interval : 0;
      for (var attempt = 0; attempt < 4; attempt++, step++) {
        final candidate = at(startDay + step * rule.interval);
        if (candidate.isAfter(after)) return candidate;
      }
      return null;

    case NovaRepeatFrequency.weekly:
      final target = rule.weekday ?? DateTime.monday;
      final firstWeek = _weekIndex(startDay);
      // Start from whichever is later — the bound or the reminder's own first
      // occurrence. Starting from the bound alone would step a week at a time
      // through however long it is until a trigger set months ahead.
      final from = boundDay > startDay ? boundDay : startDay;
      var day = from + (target - _weekdayOf(from) + 7) % 7;
      // Then forward to a week the interval actually selects, counted from the
      // week the reminder started in.
      final offset = (_weekIndex(day) - firstWeek) % rule.interval;
      final aligned = offset < 0 ? offset + rule.interval : offset;
      if (aligned != 0) day += 7 * (rule.interval - aligned);

      for (var attempt = 0; attempt < 3; attempt++, day += 7 * rule.interval) {
        final candidate = at(day);
        if (candidate.isAfter(after) && !candidate.isBefore(start)) {
          return candidate;
        }
      }
      return null;

    case NovaRepeatFrequency.monthly:
      final startMonth = anchor.year * 12 + (anchor.month - 1);
      final boundMonth = bound.year * 12 + (bound.month - 1);
      final elapsedMonths = boundMonth - startMonth;
      var step = elapsedMonths > 0 ? elapsedMonths ~/ rule.interval : 0;
      final dayOfMonth = rule.dayOfMonth ?? 1;

      for (var attempt = 0; attempt < rule.interval + 3; attempt++, step++) {
        final monthIndex = startMonth + step * rule.interval;
        final year = monthIndex ~/ 12;
        final month = monthIndex % 12 + 1;
        // A month without that day has no occurrence in it at all.
        if (dayOfMonth > _daysInMonth(year, month)) continue;
        final candidate = DateTime(
          year,
          month,
          dayOfMonth,
          anchor.hour,
          anchor.minute,
          anchor.second,
        );
        if (candidate.isAfter(after) && !candidate.isBefore(start)) {
          return candidate;
        }
      }
      return null;
  }

  // Unreachable: every branch above returns. Spelled out because a `switch`
  // statement over an enum is not, to the analyzer, a total expression.
  // ignore: dead_code
  return null;
}

/// Days since the epoch of a local calendar date, as an integer.
int _dayNumber(DateTime date) =>
    DateTime.utc(date.year, date.month, date.day).millisecondsSinceEpoch ~/
    Duration.millisecondsPerDay;

/// 1 = Monday … 7 = Sunday, read from a day number.
int _weekdayOf(int dayNumber) => DateTime.fromMillisecondsSinceEpoch(
  dayNumber * Duration.millisecondsPerDay,
  isUtc: true,
).weekday;

/// Monday-based week index: the unit a `WEEKLY;INTERVAL=n` rule counts in.
int _weekIndex(int dayNumber) => (dayNumber + 3) ~/ 7;

/// The local wall-clock time [anchor] carries, on the calendar date [dayNumber].
DateTime _wallClock(DateTime anchor, int dayNumber) {
  final date = DateTime.fromMillisecondsSinceEpoch(
    dayNumber * Duration.millisecondsPerDay,
    isUtc: true,
  );
  return DateTime(
    date.year,
    date.month,
    date.day,
    anchor.hour,
    anchor.minute,
    anchor.second,
  );
}

int _daysInMonth(int year, int month) =>
    DateTime(year, month + 1, 0).day;
