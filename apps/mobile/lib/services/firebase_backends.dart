import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

import 'analytics_service.dart';
import 'crash_reporting_service.dart';

/// Result of a successful Firebase initialisation.
typedef FirebaseBackends = ({
  CrashReporterBackend crash,
  AnalyticsBackend analytics,
});

/// Boots Firebase once and hands back the concrete backends.
///
/// `CrashReportingService` and `AnalyticsService` were both built around a backend
/// interface precisely so this is a drop-in: they behave identically against the console
/// backends and against Firebase, so analytics and crash reporting were never blocked on
/// the credentials.
///
/// [initialize] never throws. If Firebase is unavailable — a build without
/// `google-services.json`, a platform without native support, or a device with no Play
/// services — it logs and returns `null`, and the caller keeps the console backends. That
/// means a misconfigured build degrades instead of crashing on launch, which is the
/// failure mode that makes Firebase painful to introduce.
class FirebaseActivation {
  static bool _ready = false;

  /// True once [initialize] has succeeded.
  static bool get isReady => _ready;

  /// Bounds each step below.
  ///
  /// The contract above says a failure must not stop startup — but "failure" was
  /// read as "throws", and the actual on-device defect was a *hang*:
  /// `Firebase.initializeApp()` neither completed nor threw, so neither the success
  /// log nor the failure log was ever printed, nothing returned, and `runApp` was
  /// never reached. A hang is now a failure too, and it degrades to the console
  /// backends exactly like a throw does.
  static const Duration stepTimeout = Duration(seconds: 5);

  static Future<FirebaseBackends?> initialize() async {
    try {
      if (Firebase.apps.isEmpty) {
        // No options are passed on purpose: on Android the values come from
        // android/app/google-services.json via the com.google.gms.google-services
        // Gradle plugin. Only web/desktop would need explicit FirebaseOptions.
        await Firebase.initializeApp().timeout(stepTimeout);
      }

      // Crashlytics must be told to collect; the Android manifest meta-data only sets
      // the default for debug builds.
      await FirebaseCrashlytics.instance
          .setCrashlyticsCollectionEnabled(!kDebugMode)
          .timeout(stepTimeout);
      await FirebaseAnalytics.instance
          .setAnalyticsCollectionEnabled(!kDebugMode)
          .timeout(stepTimeout);

      _ready = true;
      debugPrint('[Firebase] initialised (project ${Firebase.app().options.projectId})');

      return (
        crash: FirebaseCrashReporterBackend(),
        analytics: FirebaseAnalyticsBackend(),
      );
    } catch (error, stackTrace) {
      _ready = false;
      debugPrint(
        '[Firebase] initialisation failed or timed out; continuing with the console '
        'backends. $error\n$stackTrace',
      );
      return null;
    }
  }
}

/// Routes crash reports to Firebase Crashlytics.
class FirebaseCrashReporterBackend implements CrashReporterBackend {
  FirebaseCrashlytics get _crashlytics => FirebaseCrashlytics.instance;

  @override
  Future<void> initialize() async {
    // Nothing further: FirebaseActivation has already configured collection.
  }

  @override
  Future<void> setCollectionEnabled(bool enabled) =>
      _crashlytics.setCrashlyticsCollectionEnabled(enabled);

  @override
  Future<void> setUserId(String? userId) =>
      _crashlytics.setUserIdentifier(userId ?? '');

  @override
  Future<void> setCustomKey(String key, Object value) =>
      _crashlytics.setCustomKey(key, value);

  @override
  Future<void> log(String message) => _crashlytics.log(message);

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stackTrace, {
    String? reason,
    bool fatal = false,
  }) {
    return _crashlytics.recordError(
      error,
      stackTrace,
      reason: reason,
      fatal: fatal,
    );
  }
}

/// Routes events to Firebase Analytics.
class FirebaseAnalyticsBackend implements AnalyticsBackend {
  FirebaseAnalytics get _analytics => FirebaseAnalytics.instance;

  @override
  Future<void> initialize() async {
    // Nothing further: FirebaseActivation has already configured collection.
  }

  @override
  Future<void> setCollectionEnabled(bool enabled) =>
      _analytics.setAnalyticsCollectionEnabled(enabled);

  @override
  Future<void> setUserId(String? userId) => _analytics.setUserId(id: userId);

  @override
  Future<void> setUserProperty(String name, String? value) =>
      _analytics.setUserProperty(name: name, value: value);

  @override
  Future<void> logEvent(String name, {Map<String, Object?>? parameters}) {
    // Firestore Analytics accepts only non-null values, while AnalyticsService's
    // signature allows nullable ones for convenience.
    final sanitised = parameters == null
        ? null
        : <String, Object>{
            for (final entry in parameters.entries)
              if (entry.value != null) entry.key: entry.value as Object,
          };

    return _analytics.logEvent(
      name: name,
      parameters: (sanitised == null || sanitised.isEmpty) ? null : sanitised,
    );
  }
}
