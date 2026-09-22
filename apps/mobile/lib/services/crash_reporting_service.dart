import 'dart:async';

import 'package:flutter/foundation.dart';

/// Receives crash reports. Implement this to plug in a real backend.
abstract interface class CrashReporterBackend {
  Future<void> initialize();

  Future<void> setCollectionEnabled(bool enabled);

  Future<void> setUserId(String? userId);

  Future<void> setCustomKey(String key, Object value);

  Future<void> log(String message);

  Future<void> recordError(
    Object error,
    StackTrace? stackTrace, {
    String? reason,
    bool fatal = false,
  });
}

/// Console-only backend used in debug builds and in tests.
class DebugConsoleCrashReporterBackend implements CrashReporterBackend {
  @override
  Future<void> initialize() async {}

  @override
  Future<void> setCollectionEnabled(bool enabled) async {}

  @override
  Future<void> setUserId(String? userId) async {}

  @override
  Future<void> setCustomKey(String key, Object value) async {}

  @override
  Future<void> log(String message) async => debugPrint('[Crashlytics breadcrumb] $message');

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stackTrace, {
    String? reason,
    bool fatal = false,
  }) async {
    debugPrint(
      '[Crashlytics error] fatal=$fatal reason=$reason error=$error\n$stackTrace',
    );
  }
}

/// Crash and error reporting facade.
///
/// This used to be a placeholder whose `recordError` only called `debugPrint`, and
/// nothing installed a global handler, so uncaught errors were never reported. It now
/// owns the global `FlutterError.onError` / `PlatformDispatcher.onError` hooks, keeps
/// an in-memory breadcrumb trail that is attached to every report, and delegates to a
/// pluggable [CrashReporterBackend].
///
/// **The committed Firebase config is real, not a placeholder.** This comment used to
/// claim `android/app/google-services.json` and `ios/Runner/GoogleService-Info.plist`
/// were templates full of `YOUR_…` values and that Crashlytics was therefore not in
/// play. That is false for Android: `google-services.json` has zero `YOUR_` values and
/// carries project `nova-leadup-stagging` with a live API key, `firebase_crashlytics`
/// is a dependency in `pubspec.yaml`, and `AndroidManifest.xml` sets
/// `firebase_crashlytics_collection_enabled` to true. **Crash reports are live in
/// release builds on Android.**
///
/// What is still inert is **iOS**: `ios/Runner/GoogleService-Info.plist` remains a
/// placeholder and is not referenced by `project.pbxproj`, so it is not bundled and
/// `FirebaseActivation.initialize()` falls back. Run `flutterfire configure` and add
/// the plist to the Runner Resources build phase to activate it there.
class CrashReportingService {
  static final CrashReportingService _instance = CrashReportingService._internal();

  factory CrashReportingService() => _instance;

  CrashReportingService._internal() : _backend = DebugConsoleCrashReporterBackend();

  /// Exposed for tests that need a clean instance.
  @visibleForTesting
  CrashReportingService.forTesting({CrashReporterBackend? backend})
      : _backend = backend ?? DebugConsoleCrashReporterBackend();

  /// The process-wide instance, with collection forced on.
  ///
  /// Normally `enabled` is `!kDebugMode`, so [log] and [recordError] are no-ops
  /// under `flutter test`. Startup's contract is that a bootstrap failure is
  /// *reported* and not swallowed, so its tests need the report to actually land
  /// somewhere they can read. This only flips the flag on the shared instance,
  /// which is exactly what bootstrap and the widget tree both hold.
  @visibleForTesting
  static CrashReportingService enabledForTesting() {
    final service = CrashReportingService();
    service._enabled = true;
    return service;
  }

  CrashReporterBackend _backend;

  bool _initialized = false;
  bool _enabled = !kDebugMode;
  String? _userId;
  final Map<String, Object> _customKeys = {};
  final List<String> _breadcrumbs = [];
  bool _handlersInstalled = false;

  static const int _maxBreadcrumbs = 64;

  bool get isInitialized => _initialized;
  bool get isEnabled => _enabled;
  String? get userId => _userId;

  /// Most recent breadcrumbs, oldest first.
  List<String> get breadcrumbs => List.unmodifiable(_breadcrumbs);

  /// [enabled] should reflect user consent for crash reporting.
  Future<void> initialize({bool enabled = true, CrashReporterBackend? backend}) async {
    if (_initialized) return;
    _initialized = true;
    _enabled = enabled;
    if (backend != null) _backend = backend;
    await _backend.initialize();
    await _backend.setCollectionEnabled(enabled);
  }

  Future<void> setEnabled(bool enabled) async {
    _enabled = enabled;
    await _backend.setCollectionEnabled(enabled);
  }

  Future<void> setUserId(String? userId) async {
    _userId = userId;
    if (!_enabled) return;
    await _backend.setUserId(userId);
  }

  Future<void> setCustomKey(String key, Object value) async {
    _customKeys[key] = value;
    if (!_enabled) return;
    await _backend.setCustomKey(key, value);
  }

  Future<void> log(String message) async {
    _breadcrumbs.add(message);
    if (_breadcrumbs.length > _maxBreadcrumbs) {
      _breadcrumbs.removeAt(0);
    }
    if (!_enabled) return;
    await _backend.log(message);
  }

  Future<void> recordError(
    Object error,
    StackTrace? stackTrace, {
    String? reason,
    bool fatal = false,
  }) async {
    // The breadcrumb trail is attached to every report so a crash has context even
    // when the backend does not support breadcrumbs natively.
    final enrichedReason = _breadcrumbs.isEmpty
        ? reason
        : '$reason\nbreadcrumbs: ${_breadcrumbs.join(" | ")}';

    if (!_enabled) return;

    try {
      await _backend.recordError(
        error,
        stackTrace,
        reason: enrichedReason,
        fatal: fatal,
      );
    } catch (reportingFailure) {
      // Reporting must never itself crash the app.
      debugPrint('[Crashlytics] Failed to record error: $reportingFailure');
    }
  }

  /// Installs the global error hooks. Safe to call more than once.
  ///
  /// Without this, an uncaught error in a Flutter callback or an async platform
  /// error is printed and dropped, and nothing is ever reported.
  void installGlobalHandlers() {
    if (_handlersInstalled) return;
    _handlersInstalled = true;

    final previousOnError = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails details) {
      // Keep the standard red-screen/console behaviour for developers.
      FlutterError.presentError(details);
      unawaited(
        recordError(
          details.exception,
          details.stack,
          reason: details.context?.toDescription() ?? 'FlutterError',
          fatal: false,
        ),
      );
      previousOnError?.call(details);
    };

    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      unawaited(
        recordError(error, stack, reason: 'Uncaught platform error', fatal: true),
      );
      // Returning true marks the error as handled so the app does not die.
      return true;
    };
  }
}
