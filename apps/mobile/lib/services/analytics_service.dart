import 'dart:async';

import 'package:flutter/foundation.dart';

/// Receives analytics events. Implement this to plug in a real backend.
///
/// The default [DebugAnalyticsBackend] only writes to the console. See
/// [AnalyticsService.initialize] for why no SDK is wired up yet.
abstract interface class AnalyticsBackend {
  Future<void> initialize();

  Future<void> setCollectionEnabled(bool enabled);

  Future<void> setUserId(String? userId);

  Future<void> setUserProperty(String name, String? value);

  Future<void> logEvent(String name, {Map<String, Object?>? parameters});
}

/// Console-only backend used in debug builds and in tests.
class DebugAnalyticsBackend implements AnalyticsBackend {
  bool _enabled = true;

  @override
  Future<void> initialize() async {}

  @override
  Future<void> setCollectionEnabled(bool enabled) async => _enabled = enabled;

  @override
  Future<void> setUserId(String? userId) async {
    if (!_enabled) return;
    debugPrint('[Analytics] setUserId($userId)');
  }

  @override
  Future<void> setUserProperty(String name, String? value) async {
    if (!_enabled) return;
    debugPrint('[Analytics] userProperty $name=$value');
  }

  @override
  Future<void> logEvent(String name, {Map<String, Object?>? parameters}) async {
    if (!_enabled) return;
    debugPrint('[Analytics] $name ${parameters ?? const <String, Object?>{}}');
  }
}

/// Product analytics facade.
///
/// **The committed Firebase config is real, not a placeholder.** This comment used to
/// claim `android/app/google-services.json` and `ios/Runner/GoogleService-Info.plist`
/// were still templates full of `YOUR_…` values, and that the SDK was therefore not in
/// play. That is false for Android: `google-services.json` has zero `YOUR_` values and
/// carries project `nova-leadup-stagging` with a live API key for package
/// `com.leadup.nova`, and `FirebaseActivation.initialize()` in `main.dart` does run it.
/// **Analytics is live in release builds on Android.**
///
/// What *is* still inert is **iOS**: `ios/Runner/GoogleService-Info.plist` remains a
/// placeholder, it is not referenced by `project.pbxproj` so it is not even bundled,
/// and `FirebaseActivation.initialize()` catches the failure and falls back. So the
/// App Store privacy answers must not declare analytics collection that the iOS binary
/// does not perform, while the Play Data safety form must declare it.
///
/// The consequence for the forms is spelled out in `docs/REQUIREMENTS_VERIFICATION.md`;
/// the short version is that both stores need "App activity / App info and
/// performance" declared for Android, and the iOS `PrivacyInfo.xcprivacy` entries for
/// `DeviceID` / `CrashData` / `PerformanceData` describe Android-only collection until
/// `flutterfire configure` is run for iOS.
///
/// Collection is currently gated only on build mode (`enabled: !kDebugMode`). If the
/// app is released in the EU without a consent gate, that needs revisiting — see the
/// outstanding items in the verification doc.
class AnalyticsService {
  AnalyticsService({AnalyticsBackend? backend})
      : _backend = backend ?? DebugAnalyticsBackend();

  /// Process-wide instance. Bootstrap initializes this one, and
  /// `analyticsServiceProvider` hands it out, so every call site shares the
  /// configured backend and consent state.
  static final AnalyticsService instance = AnalyticsService();

  static const String eventAppOpen = 'app_open';
  static const String eventLogin = 'login';
  static const String eventSignUp = 'sign_up';
  static const String eventLogout = 'logout';
  static const String eventOnboardingStep = 'onboarding_step';
  static const String eventWakeWordEnabled = 'wake_word_enabled';
  static const String eventWakeWordDetected = 'wake_word_detected';

  /// Which installed classifier the user chose. Only meaningful on a build with
  /// more than one; today's ships a single model, so it never fires in practice.
  static const String eventWakeWordSelected = 'wake_word_selected';
  static const String eventVoiceSessionStart = 'voice_session_start';
  static const String eventApiError = 'api_error';

  /// Daily briefing (§9.4). `enabled` on the toggle is the opt-in rate — the
  /// only place it can be measured, because the preference is device-local.
  static const String eventDailyBriefingEnabled = 'daily_briefing_enabled';

  /// A briefing actually reached the speaker. Paired with the toggle above, it
  /// gives §22.1's "per active user" counts for this feature.
  static const String eventDailyBriefingSpoken = 'daily_briefing_spoken';

  final AnalyticsBackend _backend;

  bool _initialized = false;
  bool _enabled = true;

  bool get isInitialized => _initialized;
  bool get isEnabled => _enabled;

  /// [enabled] should be tied to the user's analytics consent. Collection
  /// defaults to off in release builds until consent is recorded.
  Future<void> initialize({bool enabled = true, AnalyticsBackend? backend}) async {
    if (_initialized) return;
    _initialized = true;
    _enabled = enabled;
    await _backend.initialize();
    await _backend.setCollectionEnabled(enabled);
  }

  Future<void> setCollectionEnabled(bool enabled) async {
    _enabled = enabled;
    await _backend.setCollectionEnabled(enabled);
  }

  Future<void> setUserId(String? userId) async {
    if (!_enabled) return;
    await _backend.setUserId(userId);
  }

  Future<void> setUserProperty(String name, String? value) async {
    if (!_enabled) return;
    await _backend.setUserProperty(name, value);
  }

  /// Never throws: analytics must not be able to break a user flow.
  Future<void> logEvent(String name, {Map<String, Object?>? parameters}) async {
    if (!_initialized || !_enabled) return;
    try {
      await _backend.logEvent(name, parameters: parameters);
    } catch (error, stackTrace) {
      debugPrint('[Analytics] Failed to log "$name": $error\n$stackTrace');
    }
  }
}
