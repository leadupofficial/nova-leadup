import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/features/reminders/reminder_sync.dart';

/// N-03 / N-04 — in-app reminder speech.
///
/// Two defects lived in the same handful of lines, and both are about the same
/// thing: a Dart timer is not a promise about the wall clock.
///
///  * `_armSpeaking` armed at most eight timers and nothing ever re-armed the
///    rest, so an app left open simply never spoke the ninth reminder — a silent
///    drop, with no notification that anything had been dropped.
///  * nothing checked how late a timer had fired. Dart timers do not run while
///    the isolate is suspended, so on resume every timer that had come due while
///    the app was backgrounded fired at once, and a reminder that fell due an hour
///    ago was still announced as though it were happening now.
///
/// Real timers and short delays are used on purpose: the point of the second
/// defect is the gap between "when the timer was asked for" and "when it ran", and
/// a fake clock that collapses that gap would not reproduce it.
void main() {
  NovaReminder reminder(String id, DateTime at) =>
      NovaReminder(id: id, title: 'Call $id', remindAt: at);

  test('speaks every reminder, not only the first eight', () async {
    final spoken = <String>[];
    final scheduler = ReminderSpeechScheduler(
      (reminder) async => spoken.add(reminder.id),
    );
    addTearDown(scheduler.cancel);

    final base = DateTime.now();
    scheduler.arm(<NovaReminder>[
      for (var i = 1; i <= 10; i++)
        reminder('r$i', base.add(Duration(milliseconds: 25 * i))),
    ]);

    await Future<void>.delayed(const Duration(milliseconds: 600));

    expect(
      spoken,
      <String>['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'],
      reason:
          'a cap on armed timers must not become a cap on what is ever spoken',
    );
  });

  test('does not announce a reminder whose moment is long past', () async {
    var offset = Duration.zero;
    final spoken = <String>[];
    final scheduler = ReminderSpeechScheduler(
      (reminder) async => spoken.add(reminder.id),
      now: () => DateTime.now().add(offset),
    );
    addTearDown(scheduler.cancel);

    scheduler.arm(<NovaReminder>[
      reminder('stale', DateTime.now().add(const Duration(milliseconds: 30))),
    ]);

    // The process was suspended: the timer is only delivered now, half an hour
    // after the moment it was armed for. Speaking it here would tell the user the
    // reminder is happening now, which is not true.
    offset = const Duration(minutes: 30);
    await Future<void>.delayed(const Duration(milliseconds: 250));

    expect(spoken, isEmpty);
  });

  test('still speaks a reminder that is only a little late', () async {
    var offset = Duration.zero;
    final spoken = <String>[];
    final scheduler = ReminderSpeechScheduler(
      (reminder) async => spoken.add(reminder.id),
      now: () => DateTime.now().add(offset),
    );
    addTearDown(scheduler.cancel);

    scheduler.arm(<NovaReminder>[
      reminder('slightly-late', DateTime.now().add(const Duration(milliseconds: 30))),
    ]);

    // A brief backgrounding — the bound must not throw away a reminder that is
    // seconds late, or speech would only ever work with the app in the foreground.
    offset = const Duration(seconds: 20);
    await Future<void>.delayed(const Duration(milliseconds: 250));

    expect(spoken, <String>['slightly-late']);
  });

  test('arming again replaces the window instead of stacking alarms', () async {
    final spoken = <String>[];
    final scheduler = ReminderSpeechScheduler(
      (reminder) async => spoken.add(reminder.id),
    );
    addTearDown(scheduler.cancel);

    final at = DateTime.now().add(const Duration(milliseconds: 150));
    scheduler.arm(<NovaReminder>[reminder('a', at)]);
    scheduler.arm(<NovaReminder>[reminder('a', at)]);

    await Future<void>.delayed(const Duration(milliseconds: 400));

    expect(spoken, <String>['a'], reason: 'a repeated sync must not speak twice');
  });

  test('a dismissed or untimed reminder is never armed', () async {
    final spoken = <String>[];
    final scheduler = ReminderSpeechScheduler(
      (reminder) async => spoken.add(reminder.id),
    );
    addTearDown(scheduler.cancel);

    final at = DateTime.now().add(const Duration(milliseconds: 20));
    scheduler.arm(<NovaReminder>[
      NovaReminder(id: 'dismissed', title: 'x', remindAt: at, dismissed: true),
      const NovaReminder(id: 'no-time', title: 'y'),
      reminder('kept', at),
    ]);

    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(spoken, <String>['kept']);
  });
}
