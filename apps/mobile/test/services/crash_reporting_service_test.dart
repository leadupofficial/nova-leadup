import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/services/crash_reporting_service.dart';

import '../helpers/test_harness.dart';

/// The old CrashReportingService was a placeholder whose `recordError` only called
/// `debugPrint`, and nothing installed a global error handler. These tests pin the
/// behaviour that makes it usable in production.
void main() {
  test('does not forward reports while disabled, but still records breadcrumbs', () async {
    final backend = RecordingCrashBackend();
    final service = CrashReportingService.forTesting(backend: backend);
    await service.initialize(enabled: false);

    await service.log('starting up');
    await service.recordError(StateError('boom'), StackTrace.current, reason: 'test');

    expect(backend.errors, isEmpty);
    // Breadcrumbs are local diagnostics and stay available regardless of consent.
    expect(service.breadcrumbs, contains('starting up'));
  });

  test('forwards errors with reason and fatality when enabled', () async {
    final backend = RecordingCrashBackend();
    final service = CrashReportingService.forTesting(backend: backend);
    await service.initialize(enabled: true);

    await service.recordError(
      StateError('engine failed'),
      StackTrace.current,
      reason: 'wake_word',
      fatal: true,
    );

    expect(backend.errors, hasLength(1));
    expect(backend.reasons.single, contains('wake_word'));
    expect(backend.fatals.single, isTrue);
  });

  test('attaches the breadcrumb trail to each report', () async {
    final backend = RecordingCrashBackend();
    final service = CrashReportingService.forTesting(backend: backend);
    await service.initialize(enabled: true, backend: backend);

    await service.log('permission granted');
    await service.log('wake word started');
    await service.recordError(StateError('later failure'), null, reason: 'flow');

    final reason = backend.reasons.single!;
    expect(reason, contains('permission granted'));
    expect(reason, contains('wake word started'));
  });

  test('breadcrumbs are capped so a long session cannot grow unbounded', () async {
    final backend = RecordingCrashBackend();
    final service = CrashReportingService.forTesting(backend: backend);
    await service.initialize(enabled: true);

    for (var i = 0; i < 200; i++) {
      await service.log('breadcrumb $i');
    }

    expect(service.breadcrumbs.length, lessThanOrEqualTo(64));
    expect(service.breadcrumbs.last, 'breadcrumb 199');
  });

  test('setEnabled toggles forwarding', () async {
    final backend = RecordingCrashBackend();
    final service = CrashReportingService.forTesting(backend: backend);
    await service.initialize(enabled: false);

    await service.setEnabled(true);
    await service.recordError(StateError('now reported'), null);

    expect(backend.errors, hasLength(1));
  });

  test('a failing backend cannot crash the app', () async {
    final service = CrashReportingService.forTesting(backend: _ThrowingBackend());
    await service.initialize(enabled: true);

    // Must complete without throwing.
    await service.recordError(StateError('original'), null, reason: 'test');
  });

  test('setUserId is forwarded to the backend', () async {
    final backend = RecordingCrashBackend();
    final service = CrashReportingService.forTesting(backend: backend);
    await service.initialize(enabled: true);

    await service.setUserId('user-42');

    expect(service.userId, 'user-42');
    expect(backend.userId, 'user-42');
  });
}

class _ThrowingBackend implements CrashReporterBackend {
  @override
  Future<void> initialize() async {}

  @override
  Future<void> setCollectionEnabled(bool enabled) async {}

  @override
  Future<void> setUserId(String? userId) async {}

  @override
  Future<void> setCustomKey(String key, Object value) async {}

  @override
  Future<void> log(String message) async {}

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stackTrace, {
    String? reason,
    bool fatal = false,
  }) async {
    throw StateError('reporting backend is down');
  }
}
