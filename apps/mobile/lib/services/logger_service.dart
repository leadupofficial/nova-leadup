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
  final CrashReportingService _crashReporter = CrashReportingService();

  bool get isInitialized => _initialized;
  bool get isEnabled => _enabled;

  static void resetForTesting() {
    _instance = LoggerService._internal();
    _instance._initialized = false;
    _instance._enabled = true;
  }

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
  }

  void setEnabled(bool enabled) {
    _enabled = enabled;
  }

  void _guard() {
    if (!_initialized) {
      throw StateError('LoggerService must be initialized before logging');
    }
  }

  void v(String tag, String message) {
    _guard();
    if (!_enabled) return;
    debugPrint('[VERBOSE][$tag] $message');
  }

  void d(String tag, String message) {
    _guard();
    if (!_enabled) return;
    debugPrint('[DEBUG][$tag] $message');
  }

  void i(String tag, String message) {
    _guard();
    if (!_enabled) return;
    debugPrint('[INFO][$tag] $message');
  }

  void w(String tag, String message) {
    _guard();
    if (!_enabled) return;
    debugPrint('[WARN][$tag] $message');
  }

  void e(String tag, String message, [dynamic error, StackTrace? stackTrace]) {
    _guard();
    // Errors are always logged even when general logging is disabled
    debugPrint('[ERROR][$tag] $message ${error != null ? "- $error" : ""}');
    if (stackTrace != null) {
      debugPrint('$stackTrace');
    }

    // Forward to crash reporting service
    _crashReporter.recordError(
      error ?? message,
      stackTrace ?? StackTrace.current,
      reason: '[$tag] $message',
      fatal: false,
    );
  }
}
