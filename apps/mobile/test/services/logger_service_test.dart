import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/services/logger_service.dart';

void main() {
  /// Everything `debugPrint` writes while the capturing callback is installed.
  ///
  /// The pre-`initialize()` contract is observable only through `debugPrint`: the
  /// fallback warning goes there, and so does the flush that `initialize()` performs.
  late List<String> printed;
  late DebugPrintCallback originalDebugPrint;

  setUp(() {
    printed = <String>[];
    originalDebugPrint = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) printed.add(message);
    };
  });

  tearDown(() {
    debugPrint = originalDebugPrint;
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
    // This test used to assert `throwsStateError`, which is what the service did
    // *before* the guard was deliberately changed: a log call made before
    // `initialize()` now falls back to `debugPrint` and buffers the line, so the
    // error-reporting path never becomes a crash source. The implementation is the
    // intended behaviour, so the stale assertion is the defect — not the code. What
    // follows is what the guard is actually documented to do.
    test('warns and buffers instead of throwing before initialize', () async {
      final service = LoggerService();
      expect(service.isInitialized, isFalse);

      // Nothing throws, at any level. `e` is included because errors are the calls
      // most likely to be made early, from a crash handler.
      expect(() => service.v('tag', 'verbose'), returnsNormally);
      expect(() => service.d('tag', 'debug'), returnsNormally);
      expect(() => service.i('tag', 'info'), returnsNormally);
      expect(() => service.w('tag', 'warn'), returnsNormally);
      expect(() => service.e('tag', 'error'), returnsNormally);

      // The fallback really ran, once per call, and said why.
      expect(
        printed.where(
          (line) => line.contains('not initialized — falling back to debugPrint'),
        ),
        hasLength(5),
      );
      // ...and the log lines themselves are not emitted yet: they are buffered, so a
      // pre-initialize call cannot interleave with a half-built reporter.
      expect(printed.where((line) => line.startsWith('[VERBOSE]')), isEmpty);
      expect(printed.where((line) => line.startsWith('[ERROR]')), isEmpty);

      await service.initialize();

      // Buffered, not lost: `initialize()` flushes every pre-init line.
      expect(printed, contains('[VERBOSE][tag] verbose'));
      expect(printed, contains('[DEBUG][tag] debug'));
      expect(printed, contains('[INFO][tag] info'));
      expect(printed, contains('[WARN][tag] warn'));
      expect(
        printed.any((line) => line.startsWith('[ERROR][tag] error')),
        isTrue,
        reason: 'the pre-initialize error line was buffered and must be flushed',
      );
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
