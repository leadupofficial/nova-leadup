import 'package:flutter/foundation.dart';

/// The user's daily-briefing preference (master document §9.4).
///
/// §9.4 makes the morning briefing **opt-in**, so [enabled] defaults to `false`
/// and a fresh install schedules nothing and says nothing. The time is stored
/// as a wall-clock hour and minute rather than an instant: "08:00 every day"
/// survives travel and a daylight-saving change, an absolute timestamp does
/// not.
@immutable
class DailyBriefingSettings {
  const DailyBriefingSettings({
    this.enabled = false,
    this.hour = 8,
    this.minute = 0,
  });

  /// Off unless the user turned it on.
  final bool enabled;

  /// 0-23, device-local.
  final int hour;

  /// 0-59.
  final int minute;

  /// A fresh install. Deliberately silent.
  static const DailyBriefingSettings defaults = DailyBriefingSettings();

  /// `08:00`, for the settings row.
  String get label =>
      '${hour.toString().padLeft(2, '0')}:${minute.toString().padLeft(2, '0')}';

  /// The next occurrence of this time at or after [from], device-local.
  ///
  /// Pure, so the rollover rule (a time already past today belongs to tomorrow)
  /// is unit-testable without a clock or a platform channel.
  DateTime nextOccurrence(DateTime from) {
    final today = DateTime(from.year, from.month, from.day, hour, minute);
    return today.isAfter(from) ? today : today.add(const Duration(days: 1));
  }

  DailyBriefingSettings copyWith({bool? enabled, int? hour, int? minute}) {
    return DailyBriefingSettings(
      enabled: enabled ?? this.enabled,
      hour: hour ?? this.hour,
      minute: minute ?? this.minute,
    );
  }
}

/// What one reconciliation pass did, for logging and for tests.
@immutable
class BriefingReconciliation {
  const BriefingReconciliation({
    required this.scheduled,
    required this.cancelled,
    required this.exact,
    required this.nextAt,
  });

  /// Whether a repeating alarm is now armed.
  final bool scheduled;

  /// Whether an alarm that is no longer wanted was dropped.
  final bool cancelled;

  /// Whether the OS granted exact alarms. When false the alarm is inexact —
  /// a briefing a few minutes late is far better than no briefing.
  final bool exact;

  /// The next moment the in-app speaker will fire, or null when disabled.
  final DateTime? nextAt;

  static const BriefingReconciliation idle = BriefingReconciliation(
    scheduled: false,
    cancelled: false,
    exact: false,
    nextAt: null,
  );
}

/// Where the controller is in the fetch-and-speak cycle.
enum BriefingStatus { idle, loading, ready, speaking, failed }

/// The result of asking for a briefing to be read aloud.
enum BriefingSpeechOutcome {
  /// Handed to the device voice.
  spoken,

  /// The opt-in is off and the request was not user-initiated. Nothing happens.
  notOptedIn,

  /// The server returned no text.
  empty,

  /// The device has no voice for the briefing's language. The UI says so rather
  /// than failing silently or reading Tamil with an English voice.
  noVoice,

  /// The fetch or the synthesis failed; [DailyBriefingState.error] says why.
  failed,

  /// A fetch was already in flight.
  busy,
}
