import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/models.dart';
import '../../core/api/nova_api.dart' show NovaApiException, novaApiProvider;
import '../../core/voice/device_tts.dart';
import '../auth/auth_controller.dart';
import 'reminder_reconciler.dart';

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
  /// A bound on the in-app speech timers. Long-range timers rarely survive to
  /// their deadline anyway; every sync re-arms the next batch.
  static const int maxSpeechTimers = 8;

  final List<Timer> _timers = <Timer>[];
  bool _syncing = false;

  @override
  ReminderSyncState build() {
    final authenticated = ref.watch(
      authStateProvider.select((state) => state.isAuthenticated),
    );

    ref.onDispose(_cancelTimers);

    if (authenticated) {
      // Deferred: `sync` writes state, which is illegal while `build` is still
      // running.
      unawaited(Future<void>.microtask(sync));
    } else {
      // Signing out must not leave a timer that would talk over the login screen.
      _cancelTimers();
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
      final reminders = await ref.read(novaApiProvider).listReminders();
      if (!ref.mounted) return;

      final result = await ref
          .read(reminderReconcilerProvider)
          .reconcile(reminders);
      if (!ref.mounted) return;

      _armSpeaking(reminders);
      state = ReminderSyncState(lastResult: result);
    } catch (error) {
      if (!ref.mounted) return;
      state = ReminderSyncState(error: _message(error));
    } finally {
      _syncing = false;
    }
  }

  // ── In-app speaking ─────────────────────────────────────────────────────────

  void _armSpeaking(List<NovaReminder> reminders) {
    _cancelTimers();
    final now = DateTime.now();
    final upcoming = reminders
        .where(
          (reminder) =>
              !reminder.dismissed &&
              reminder.remindAt != null &&
              reminder.remindAt!.isAfter(now),
        )
        .toList()
      ..sort((a, b) => a.remindAt!.compareTo(b.remindAt!));

    for (final reminder in upcoming.take(maxSpeechTimers)) {
      final delay = reminder.remindAt!.difference(DateTime.now());
      _timers.add(
        Timer(
          delay.isNegative ? Duration.zero : delay,
          () => unawaited(_speak(reminder)),
        ),
      );
    }
  }

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

  void _cancelTimers() {
    for (final timer in _timers) {
      timer.cancel();
    }
    _timers.clear();
  }
}

String _message(Object error) => error is NovaApiException
    ? error.message
    : error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');

final reminderSyncProvider =
    NotifierProvider<ReminderSyncController, ReminderSyncState>(
      ReminderSyncController.new,
    );
