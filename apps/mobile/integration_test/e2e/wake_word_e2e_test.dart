// Requirement 1 & 2 — the custom wake word, on the real device.
//
// What this suite deliberately does NOT do is inject `FakeWakeWordPlatform`. The
// whole point is to reach the Kotlin `WakeWordService` through the real
// `nova/wake_word` channel and observe what the phone actually does.

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'e2e_support.dart';

const MethodChannel _channel = MethodChannel('nova/wake_word');

Future<Map<String, dynamic>> availability() async {
  final raw = await _channel.invokeMethod<dynamic>('availability');
  return Map<String, dynamic>.from(raw as Map<dynamic, dynamic>);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('E2E wake word (device)', () {
    testWidgets('the native service reports the real installed model', (WidgetTester tester) async {
      assertApiConfigured();

      final Map<String, dynamic> report = await availability();
      // ignore: avoid_print
      print('[e2e][wakeword] availability = $report');

      expect(report['available'], isTrue,
          reason: 'the native service refused to report the wake word as available: $report');
      expect(
        (report['models'] as List<dynamic>?)?.isNotEmpty,
        isTrue,
        reason: 'no wake word model is installed in the APK: $report',
      );
      expect(report['selected'], isNotNull,
          reason: 'a model is installed but the service named no effective selection');
    });

    testWidgets(
      'the home status card does not claim to be listening while the wake word is off',
      (WidgetTester tester) async {
        assertApiConfigured();
        final api = E2eApi();
        addTearDown(api.close);

        // A brand-new device state: onboarding complete, signed in, and the wake
        // word never enabled. `nova_wake_word_enabled` is absent, so the controller
        // builds with `enabled == false` and never calls `start()`.
        await wipeDeviceState();
        final account = await api.register(tag: 'wakehonest');
        await seedSession(account);

        await launchRealApp(tester);
        await pumpFor(tester, const Duration(seconds: 8));

        final List<String> text = visibleText(tester);
        // ignore: avoid_print
        print('[e2e][wakeword] disabled-state screen: $text');

        final bool serviceRunning = await _channel.invokeMethod<bool>('isRunning') ?? false;
        // ignore: avoid_print
        print('[e2e][wakeword] isRunning while wake word is off: $serviceRunning');
        expect(serviceRunning, isFalse,
            reason: 'the service was running although the user never enabled the wake word');

        // The defect this asserts against: the Status card renders
        // `WakeWordAvailability.userMessage`, which answers "Listening for X." on
        // every device that merely HAS a model installed — whether or not anything
        // is listening. The user never turned the feature on, so the app must not
        // tell them it is listening.
        final List<String> claims = text
            .where((String line) => line.toLowerCase().contains('listening for'))
            .toList();
        expect(
          claims,
          isEmpty,
          reason: 'the app claims to be listening while the wake word is switched off: '
              '$claims — full screen: $text',
        );
      },
    );

    testWidgets('starting the wake word really runs the foreground service', (WidgetTester tester) async {
      assertApiConfigured();

      expect(await _channel.invokeMethod<bool>('isRunning'), isFalse,
          reason: 'the service was already running before this test started it');

      final bool started = await _channel.invokeMethod<bool>('start') ?? false;
      expect(started, isTrue, reason: 'the native start() call refused');

      // `start()` only asks; the service comes up asynchronously.
      await waitUntil(
        tester,
        () async => (await _channel.invokeMethod<bool>('isRunning')) ?? false,
        timeout: const Duration(seconds: 30),
        reason: 'the foreground service never reported itself as running after start()',
      );

      expect(await _channel.invokeMethod<bool>('isRunning'), isTrue);

      final bool stopped = await _channel.invokeMethod<bool>('stop') ?? false;
      expect(stopped, isTrue);
      await waitUntil(
        tester,
        () async => ((await _channel.invokeMethod<bool>('isRunning')) ?? true) == false,
        timeout: const Duration(seconds: 20),
        reason: 'the service kept running after stop()',
      );
    });
  });
}
