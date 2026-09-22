import 'dart:async';
import 'package:flutter/foundation.dart';
import 'crash_reporting_service.dart';

/// Centralized LoggerService with log levels and Crashlytics integration.
class LoggerService {
  static LoggerService _instance = LoggerService._internal();

  factory LoggerService() => _instance;

  LoggerService._internal();

  bool _initialized = false;
  bool _enabled = true;
  bool _initializing = false;
  final CrashReportingService _crashReporter = CrashReportingService();
  final List<Function()> _pendingLogs = [];

  bool get isInitialized => _initialized;
  bool get isEnabled => _enabled;

  static void resetForTesting() {
    _instance = LoggerService._internal();
    _instance._initialized = false;
    _instance._enabled = true;
  }

  Future<void> initialize() async {
    if (_initialized) return;
    if (_initializing) {
      // Wait for the in-flight initialization to finish.
      while (!_initialized) {
        await Future.delayed(const Duration(milliseconds: 10));
      }
      return;
    }
    _initializing = true;
    _initialized = true;
    _flushPending();
  }

  void setEnabled(bool enabled) {
    _enabled = enabled;
  }

  void _guard() {
    if (!_initialized) {
      // Fall back to debugPrint so the error-reporting path never becomes a crash source.
      debugPrint('[LoggerService] not initialized — falling back to debugPrint');
    }
  }

  void _enqueue(void Function() logFn) {
    if (!_initialized) {
      _pendingLogs.add(logFn);
    } else {
      logFn();
    }
  }

  void _flushPending() {
    for (final fn in _pendingLogs) {
      fn();
    }
    _pendingLogs.clear();
  }

  void v(String tag, String message) {
    _guard();
    if (!_enabled) return;
    _enqueue(() => debugPrint('[VERBOSE][$tag] $message'));
  }

  void d(String tag, String message) {
    _guard();
    if (!_enabled) return;
    _enqueue(() => debugPrint('[DEBUG][$tag] $message'));
  }

  void i(String tag, String message) {
    _guard();
    if (!_enabled) return;
    _enqueue(() => debugPrint('[INFO][$tag] $message'));
  }

  void w(String tag, String message) {
    _guard();
    if (!_enabled) return;
    _enqueue(() => debugPrint('[WARN][$tag] $message'));
  }

  void e(String tag, String message, [dynamic error, StackTrace? stackTrace]) {
    _guard();
    // Errors are always logged even when general logging is disabled
    _enqueue(() {
      debugPrint('[ERROR][$tag] $message ${error != null ? "- $error" : ""}');
      if (stackTrace != null) {
        debugPrint('$stackTrace');
      }
    });

    // Forward to crash reporting service — never throw from the error-reporting path.
    if (_crashReporter.isInitialized) {
      try {
        _crashReporter.recordError(
          error ?? message,
          stackTrace ?? StackTrace.current,
          reason: '[$tag] $message',
          fatal: false,
        );
      } catch (_) {
        // Reporting must never itself crash the app.
      }
    }
  }
}
