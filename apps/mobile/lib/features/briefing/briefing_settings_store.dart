import 'package:shared_preferences/shared_preferences.dart';

import 'briefing_models.dart';

/// The only place the daily briefing reads or writes persistent state.
///
/// Exactly three values are stored, and none of them is briefing text:
///
///  * [enabledKey] — the opt-in, `false` on a fresh install (§9.4);
///  * [hourKey] and [minuteKey] — the time of day.
///
/// Briefing text is fetched from the server when the time arrives and is never
/// written to disk. There is no key for it and no API here that accepts one.
class BriefingSettingsStore {
  BriefingSettingsStore(this._prefs);

  /// The opt-in. Absent means off, which is what makes a new install silent.
  static const String enabledKey = 'nova_daily_briefing_enabled';

  /// Wall-clock hour, 0-23.
  static const String hourKey = 'nova_daily_briefing_hour';

  /// Wall-clock minute, 0-59.
  static const String minuteKey = 'nova_daily_briefing_minute';

  /// Every key this feature owns, so a test can assert nothing else was written.
  static const List<String> allKeys = <String>[enabledKey, hourKey, minuteKey];

  static const int defaultHour = 8;
  static const int defaultMinute = 0;

  final SharedPreferences _prefs;

  /// Reads the stored settings, clamped into range.
  ///
  /// A hand-edited or restored preferences file could hold `99` for the hour;
  /// clamping here means the schedule is always constructible rather than
  /// throwing at the point the alarm is armed.
  DailyBriefingSettings read() {
    return DailyBriefingSettings(
      enabled: _prefs.getBool(enabledKey) ?? false,
      hour: (_prefs.getInt(hourKey) ?? defaultHour).clamp(0, 23),
      minute: (_prefs.getInt(minuteKey) ?? defaultMinute).clamp(0, 59),
    );
  }

  /// Persists the settings. Writes only keys in [allKeys].
  Future<void> write(DailyBriefingSettings settings) async {
    await _prefs.setBool(enabledKey, settings.enabled);
    await _prefs.setInt(hourKey, settings.hour);
    await _prefs.setInt(minuteKey, settings.minute);
  }
}
