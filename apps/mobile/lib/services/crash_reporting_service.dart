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
/// **Why no Firebase Crashlytics SDK is wired up yet.** The committed
/// `android/app/google-services.json` and `ios/Runner/GoogleService-Info.plist` are
/// placeholders (`YOUR_FIREBASE_PROJECT_ID`, `YOUR_ANDROID_API_KEY`, ...). Adding
/// `firebase_crashlytics` against that config fails the Android build via the
/// `google-services` plugin. To activate it:
///
/// ```bash
/// cd apps/mobile
/// dart pub global activate flutterfire_cli
/// flutterfire configure --project=nova-leadup-stagging
/// # then: flutter pub add firebase_core firebase_crashlytics
/// ```
///
/// and pass a `FirebaseCrashReporterBackend()` to [initialize].
class CrashReportingService {
  static final CrashReportingService _instance = CrashReportingService._internal();

  factory CrashReportingService() => _instance;

  CrashReportingService._internal() : _backend = DebugConsoleCrashReporterBackend();

  /// Exposed for tests that need a clean instance.
  @visibleForTesting
  CrashReportingService.forTesting({CrashReporterBackend? backend})
      : _backend = backend ?? DebugConsoleCrashReporterBackend();

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
