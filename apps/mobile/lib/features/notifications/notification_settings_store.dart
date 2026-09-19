import 'package:shared_preferences/shared_preferences.dart';

import 'notification_app_catalogue.dart';
import 'notification_models.dart';

/// The only place the notification assistant reads or writes persistent state.
///
/// ## What is stored, and what is never stored
///
/// Exactly five values are written, and none of them is notification text:
///
///  * [enabledKey] — the master toggle (false on a fresh install);
///  * [allowedPackagesKey] — the packages the user ticked;
///  * [blockedPackagesKey] — extra packages the user blocked;
///  * [summarizeHighPriorityKey] — §5.21 rule 3;
///  * [readAloudKey] — §5.21 rule 4 / §9.3 opt-in.
///
/// There is no key for a title, a body, a sender or an excerpt, and no API on
/// this class accepts one. Notification text lives only in the controller's
/// in-memory inbox and is gone when the process is.
///
/// ## The Kotlin mirror
///
/// `shared_preferences` persists to `FlutterSharedPreferences` and prefixes
/// every key with `flutter.`, and
/// `NovaNotificationListenerService.kt` reads these same keys so the native
/// filter can run while the Flutter engine is dead. A test asserts the two
/// sides agree on the names.
class NotificationSettingsStore {
  NotificationSettingsStore(this._prefs);

  /// Master toggle. Off unless the user turned it on.
  static const String enabledKey = 'nova_notification_assistant_enabled';

  /// Ticked packages.
  static const String allowedPackagesKey = 'nova_notification_allowed_packages';

  /// Extra blocked packages.
  static const String blockedPackagesKey = 'nova_notification_blocked_packages';

  /// §5.21 "Summarize only high-priority work notifications".
  static const String summarizeHighPriorityKey =
      'nova_notification_summarize_high_priority';

  /// §5.21 "Read notifications aloud". Never sufficient on its own — the
  /// per-session confirmation in the controller is not persisted and cannot be
  /// turned off.
  static const String readAloudKey = 'nova_notification_read_aloud_enabled';

  /// Every key this feature owns. Used by tests to assert that nothing else
  /// was written.
  static const List<String> allKeys = <String>[
    enabledKey,
    allowedPackagesKey,
    blockedPackagesKey,
    summarizeHighPriorityKey,
    readAloudKey,
  ];

  final SharedPreferences _prefs;

  /// Reads the stored settings, sanitised.
  ///
  /// The allowlist is filtered against the blocklist on the way out, so a stale
  /// entry for a banking or authenticator app — from a restored backup, an
  /// older build, or a hand-edited preferences file — cannot survive a restart
  /// even though the settings screen would never have created it.
  NotificationGuardSettings read() {
    final allowed = (_prefs.getStringList(allowedPackagesKey) ?? const <String>[])
        .where((String packageName) {
          return blockedCategoryFor(packageName) == null;
        })
        .toSet();

    return NotificationGuardSettings(
      enabled: _prefs.getBool(enabledKey) ?? false,
      allowedPackages: allowed,
      blockedPackages:
          (_prefs.getStringList(blockedPackagesKey) ?? const <String>[]).toSet(),
      summarizeHighPriorityOnly:
          _prefs.getBool(summarizeHighPriorityKey) ?? true,
      readAloudEnabled: _prefs.getBool(readAloudKey) ?? false,
    );
  }

  /// Persists the settings. Writes only keys in [allKeys].
  Future<void> write(NotificationGuardSettings settings) async {
    await _prefs.setBool(enabledKey, settings.enabled);
    await _prefs.setStringList(
      allowedPackagesKey,
      settings.allowedPackages.toList(growable: false),
    );
    await _prefs.setStringList(
      blockedPackagesKey,
      settings.blockedPackages.toList(growable: false),
    );
    await _prefs.setBool(
      summarizeHighPriorityKey,
      settings.summarizeHighPriorityOnly,
    );
    await _prefs.setBool(readAloudKey, settings.readAloudEnabled);
  }

  /// Turns everything off and forgets the allowlist. Used by "Turn off and
  /// clear", and by the controller when notification access is revoked behind
  /// the app's back.
  Future<void> clear() async {
    await _prefs.setBool(enabledKey, false);
    await _prefs.setBool(readAloudKey, false);
    await _prefs.setStringList(allowedPackagesKey, const <String>[]);
    await _prefs.setStringList(blockedPackagesKey, const <String>[]);
  }
}
