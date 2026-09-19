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
/// **Why there is no Firebase Analytics SDK here yet.** The committed
/// `android/app/google-services.json` and `ios/Runner/GoogleService-Info.plist`
/// are still placeholders (`YOUR_FIREBASE_PROJECT_ID`, `YOUR_ANDROID_API_KEY`, ...).
/// Adding `firebase_analytics` on top of an invalid config makes the Android
/// `google-services` plugin fail the build and `Firebase.initializeApp()` throw at
/// runtime. So the SDK is deliberately behind this backend seam.
///
/// To activate Firebase Analytics:
///
/// ```bash
/// cd apps/mobile
/// dart pub global activate flutterfire_cli
/// flutterfire configure --project=nova-leadup-stagging
/// # then: flutter pub add firebase_core firebase_analytics
/// ```
///
/// and pass a `FirebaseAnalyticsBackend()` to [initialize]. Nothing else in the app
/// needs to change: every call site already goes through this facade.
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
