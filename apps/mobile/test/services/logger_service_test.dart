import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/services/logger_service.dart';

void main() {
  tearDown(() {
    LoggerService.resetForTesting();
  });

  group('LoggerService singleton', () {
    test('returns same instance on repeated calls', () {
      final a = LoggerService();
      final b = LoggerService();
      expect(identical(a, b), isTrue);
    });

    test('isInitialized is false before initialize', () {
      final service = LoggerService();
      expect(service.isInitialized, isFalse);
    });
  });

  group('LoggerService.initialize', () {
    test('sets initialized to true', () async {
      final service = LoggerService();
      expect(service.isInitialized, isFalse);
      await service.initialize();
      expect(service.isInitialized, isTrue);
    });

    test('initialize is idempotent', () async {
      final service = LoggerService();
      await service.initialize();
      await service.initialize();
      expect(service.isInitialized, isTrue);
    });
  });

  group('LoggerService._guard', () {
    test('throws StateError before initialize', () {
      final service = LoggerService();
      expect(() => service.v('tag', 'msg'), throwsStateError);
      expect(() => service.d('tag', 'msg'), throwsStateError);
      expect(() => service.i('tag', 'msg'), throwsStateError);
      expect(() => service.w('tag', 'msg'), throwsStateError);
      expect(() => service.e('tag', 'msg'), throwsStateError);
    });

    test('does not throw after initialize', () async {
      final service = LoggerService();
      await service.initialize();
      expect(() => service.v('tag', 'msg'), returnsNormally);
      expect(() => service.d('tag', 'msg'), returnsNormally);
      expect(() => service.i('tag', 'msg'), returnsNormally);
      expect(() => service.w('tag', 'msg'), returnsNormally);
      expect(() => service.e('tag', 'msg'), returnsNormally);
    });
  });

  group('LoggerService log levels', () {
    setUp(() async => LoggerService().initialize());

    test('v calls underlying Logger.v without throwing', () {
      LoggerService().setEnabled(true);
      expect(() => LoggerService().v('tag', 'verbose'), returnsNormally);
    });

    test('d calls underlying Logger.d without throwing', () {
      LoggerService().setEnabled(true);
      expect(() => LoggerService().d('tag', 'debug'), returnsNormally);
    });

    test('i calls underlying Logger.i without throwing', () {
      LoggerService().setEnabled(true);
      expect(() => LoggerService().i('tag', 'info'), returnsNormally);
    });

    test('w calls underlying Logger.w without throwing', () {
      LoggerService().setEnabled(true);
      expect(() => LoggerService().w('tag', 'warn'), returnsNormally);
    });

    test('e calls underlying Logger.e without throwing', () {
      LoggerService().setEnabled(true);
      expect(() => LoggerService().e('tag', 'error'), returnsNormally);
    });

    test('e works even when logging is disabled (error always logs)', () {
      LoggerService().setEnabled(false);
      expect(() => LoggerService().e('tag', 'error'), returnsNormally);
    });

    test('i does not crash when logging is disabled', () {
      LoggerService().setEnabled(false);
      expect(() => LoggerService().i('tag', 'info'), returnsNormally);
    });

    test('passes error object through to underlying logger', () {
      LoggerService().setEnabled(true);
      final ex = Exception('boom');
      expect(() => LoggerService().e('tag', 'msg', ex), returnsNormally);
    });
  });
}
