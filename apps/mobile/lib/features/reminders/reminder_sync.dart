import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/models.dart';
import '../../core/api/nova_api.dart' show NovaApiException, novaApiProvider;
import '../../core/voice/device_tts.dart';
import '../auth/auth_controller.dart';
import 'reminder_notifications.dart';
import 'reminder_reconciler.dart';
import 'reminder_recurrence.dart';

/// Result of the most recent reminder sync.
@immutable
class ReminderSyncState {
  const ReminderSyncState({this.syncing = false, this.lastResult, this.error});

  final bool syncing;
  final ReminderReconciliation? lastResult;
  final String? error;

  ReminderSyncState copyWith({
    bool? syncing,
    ReminderReconciliation? lastResult,
    String? error,
    bool clearError = false,
  }) {
    return ReminderSyncState(
      syncing: syncing ?? this.syncing,
      lastResult: lastResult ?? this.lastResult,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// Keeps the OS's reminder alarms in step with the server, and speaks reminders
/// while the app process is alive.
///
/// Why the two halves are separate: a scheduled notification is shown by Android
/// itself, so it fires with the app closed. Nothing in `flutter_local_notifications`
/// calls back into Dart when a scheduled notification is *delivered* — the
/// background isolate callback only runs when the user taps it — so "speak at the
/// exact moment, with the app dead" is not achievable from Dart. What is
/// achievable is:
///
///  * the notification carries the reminder text, so the user always sees it;
///  * a Dart timer speaks it when the process happens to be running, which
///    covers the app being open or recently backgrounded.
class ReminderSyncController extends Notifier<ReminderSyncState> {
  /// Arms the in-app speech timers. Extracted so the rules it lives by — how many
  /// timers may be in flight and how late is too late to speak — are unit-testable
  /// without a Riverpod container or a TTS engine.
  late final ReminderSpeechScheduler _speaker = ReminderSpeechScheduler(_speak);

  bool _syncing = false;

  @override
  ReminderSyncState build() {
    final authenticated = ref.watch(
      authStateProvider.select((state) => state.isAuthenticated),
    );

    ref.onDispose(_speaker.cancel);

    // Register the tap handler unconditionally, not only when authenticated: Android
    // can cold-start the process from the notification, and the provider may be built
    // before sign-in completes. The handler tolerates a missing session, so registering
    // it early is strictly better than dropping the tap that launched the app.
    ref.read(reminderNotificationsProvider).onReminderOpened(reportOpened);

    if (authenticated) {
      // Deferred: `sync` writes state, which is illegal while `build` is still
      // running.
      unawaited(Future<void>.microtask(sync));
    } else {
      // Signing out must not leave a timer that would talk over the login screen.
      _speaker.cancel();
    }

    return const ReminderSyncState();
  }

  /// Fetches the server's reminders, reconciles the OS notifications against
  /// them, and arms the in-app speech timers.
  ///
  /// Safe to call repeatedly and concurrently: a second call while one is in
  /// flight is ignored.
  Future<void> sync() async {
    if (_syncing) return;
    _syncing = true;
    try {
      if (!ref.read(authStateProvider).isAuthenticated) return;

      state = state.copyWith(syncing: true, clearError: true);
      // Every page, and `complete` travels with it: the reconciler cancels an
      // alarm only when it knows the list it holds is the account's whole list.
      final listing = await ref.read(novaApiProvider).listAllReminders();
      if (!ref.mounted) return;

      final result = await ref
          .read(reminderReconcilerProvider)
          .reconcile(listing.reminders, complete: listing.complete);
      if (!ref.mounted) return;

      _speaker.arm(listing.reminders);
      state = ReminderSyncState(lastResult: result);
    } catch (error) {
      if (!ref.mounted) return;
      state = ReminderSyncState(error: _message(error));
    } finally {
      _syncing = false;
    }
  }

  /// Reports that the user opened a reminder's notification.
  ///
  /// This is the app half of `reminders.triggered_at`: without it the Admin Control
  /// Center could not distinguish a reminder the user actually saw from one that
  /// quietly came due, because the OS fires the alarm with the app closed and nothing
  /// in Dart observes the firing itself.
  ///
  /// Deliberately tolerant of every failure. A tap can cold-start the process, so
  /// there may be no session yet; a dropped report costs one acknowledgement rather
  /// than anything the user perceives. It never rethrows, because the callback it is
  /// invoked from is a platform-channel handler and an exception there is discarded
  /// with no record.
  Future<void> reportOpened(String reminderId) async {
    if (reminderId.isEmpty) return;
    try {
      await ref.read(novaApiProvider).acknowledgeReminder(reminderId);
    } catch (error) {
      debugPrint('[ReminderSync] could not report the acknowledgement: $error');
      return;
    }
    // The local list now disagrees with the server about `triggeredAt`, so refresh it.
    // A failure here is the ordinary sync failure and already has its own reporting.
    await sync();
  }

  // ── In-app speaking ─────────────────────────────────────────────────────────

  Future<void> _speak(NovaReminder reminder) async {
    final text = reminder.title.trim();
    if (text.isEmpty) return;
    try {
      final tts = ref.read(deviceTtsProvider);
      final policy = ref.read(onboardingServiceProvider).getLanguagePolicy();
      final tag = resolveDeviceLanguageTag(
        languagePolicy: policy,
        text: text,
      );
      if (tag != null && !await tts.canSpeak(tag)) {
        // The reminder has already fired, so falling back to the device default
        // voice is better than silence.
        await tts.speak(text);
      } else {
        await tts.speak(text, languageTag: tag);
      }
    } catch (error) {
      debugPrint('[ReminderSync] could not speak the reminder: $error');
    }
  }
}

/// The speaking half of reminder sync: arms a timer per upcoming reminder and
/// speaks it when the moment arrives.
///
/// Deliberately separate from [ReminderSyncController]: the rules below are the
/// ones that were wrong and are invisible to a widget or provider test, because a
/// Dart timer does not fire while the isolate is suspended.
class ReminderSpeechScheduler {
  ReminderSpeechScheduler(
    this._speak, {
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// How many timers may be armed at once.
  ///
  /// A window rather than a cap on what is ever spoken: each timer that fires arms
  /// the next reminder, so a list longer than the window is worked through instead
  /// of silently truncated. Long-range timers rarely survive to their deadline
  /// anyway; every sync re-arms the window.
  static const int maxConcurrentTimers = 8;

  /// How late a timer may fire and still be worth speaking.
  ///
  /// Dart timers do not run while the isolate is suspended, so on resume every
  /// timer that came due while the app was backgrounded fires at once. Beyond this
  /// bound the moment has passed — the OS notification already told the user, and
  /// announcing "take the pills" an hour after the fact is not a reminder, it is
  /// noise claiming to be current. Small lateness still speaks: the alternative
  /// would be speech that only ever works in the foreground.
  static const Duration maxLateness = Duration(minutes: 2);

  final Future<void> Function(NovaReminder reminder) _speak;
  final DateTime Function() _now;

  /// Timers currently armed, and the reminders still waiting for one — each with
  /// the instant it should be spoken at.
  ///
  /// The instant travels with the reminder because it is not always `remindAt`:
  /// a repeating reminder's stored trigger is only the first time it went off, so
  /// what it should be spoken at is the next occurrence of its rule — the same
  /// instant the OS alarm was armed for.
  final List<Timer> _timers = <Timer>[];
  final List<({NovaReminder reminder, DateTime at})> _queue =
      <({NovaReminder reminder, DateTime at})>[];

  /// Bumped by every [arm] and [cancel]. A callback that resumes after an `await`
  /// checks it, so a re-arm cannot be dragged back into the previous pass's queue.
  int _generation = 0;

  /// Arms timers for the reminders that are still ahead of [now], soonest first.
  ///
  /// Anything already past is left alone: the OS notification has fired and is
  /// what the user sees.
  void arm(Iterable<NovaReminder> reminders) {
    cancel();
    final now = _now();
    final upcoming = <({NovaReminder reminder, DateTime at})>[];
    for (final reminder in reminders) {
      if (reminder.dismissed) continue;
      final start = reminder.remindAt;
      if (start == null) continue;

      final rule = reminder.repeatRule;
      final at = rule == null
          ? start
          : nextReminderOccurrence(rule: rule, start: start, after: now);
      if (at == null || !at.isAfter(now)) continue;
      upcoming.add((reminder: reminder, at: at));
    }
    upcoming.sort((a, b) => a.at.compareTo(b.at));
    _queue
      ..clear()
      ..addAll(upcoming);
    _fillWindow();
  }

  /// Arms timers for the head of the queue until the window is full.
  ///
  /// Called again after each timer fires, which is what makes the eighth reminder
  /// the end of the first batch rather than the end of what is ever spoken.
  void _fillWindow() {
    while (_timers.length < maxConcurrentTimers && _queue.isNotEmpty) {
      final entry = _queue.removeAt(0);
      final delay = entry.at.difference(_now());
      final generation = _generation;
      late final Timer timer;
      timer = Timer(
        delay.isNegative ? Duration.zero : delay,
        () {
          _timers.remove(timer);
          unawaited(_fire(entry, generation));
        },
      );
      _timers.add(timer);
    }
  }

  Future<void> _fire(
    ({NovaReminder reminder, DateTime at}) entry,
    int generation,
  ) async {
    final late = _now().difference(entry.at);
    if (late > maxLateness) {
      // The isolate was suspended past the point where this was still current.
      debugPrint(
        '[ReminderSync] skipped a reminder that came due ${late.inMinutes}m ago',
      );
    } else {
      await _speak(entry.reminder);
    }
    if (generation != _generation) return;
    _fillWindow();
  }

  void cancel() {
    _generation++;
    for (final timer in _timers) {
      timer.cancel();
    }
    _timers.clear();
    _queue.clear();
  }
}

String _message(Object error) => error is NovaApiException
    ? error.message
    : error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');

final reminderSyncProvider =
    NotifierProvider<ReminderSyncController, ReminderSyncState>(
      ReminderSyncController.new,
    );
