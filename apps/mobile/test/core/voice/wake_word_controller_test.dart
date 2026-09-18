import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/voice/wake_word_controller.dart';
import 'package:nova_mobile/core/voice/wake_word_service.dart';

import '../../helpers/test_harness.dart';

void main() {
  test('reports support and re-arms when the user had it enabled', () async {
    final deps = await createTestDependencies(
      preferences: <String, Object>{WakeWordController.enabledPreferenceKey: true},
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    // Reading the provider starts the async availability probe.
    expect(container.read(wakeWordStateProvider).enabled, isTrue);
    await pumpEventQueue();

    final state = container.read(wakeWordStateProvider);
    expect(state.isSupported, isTrue);
    expect(state.enabled, isTrue);
    expect(state.listening, isTrue);
    expect(deps.wakeWordPlatform.startCalls, 1);
  });

  test('does not start the microphone when the preference is off', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    expect(deps.wakeWordPlatform.startCalls, 0);
    expect(container.read(wakeWordStateProvider).listening, isFalse);
  });

  test('refuses to enable, and reverts the preference, when no model is installed', () async {
    final deps = await createTestDependencies(
      wakeWordAvailability: const WakeWordAvailability(
        available: false,
        reason: 'no_wake_word_model',
      ),
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    await container.read(wakeWordStateProvider.notifier).setEnabled(true);
    await pumpEventQueue();

    final state = container.read(wakeWordStateProvider);
    expect(state.enabled, isFalse);
    expect(state.isSupported, isFalse);
    expect(state.error, isNotNull);
    expect(deps.wakeWordPlatform.startCalls, 0);
    // The preference must not survive, or the toggle would look on after a restart
    // while nothing is actually listening.
    expect(
      deps.preferences.getBool(WakeWordController.enabledPreferenceKey),
      isFalse,
    );
  });

  test('enabling persists the preference that BootReceiver reads', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    await container.read(wakeWordStateProvider.notifier).setEnabled(true);
    await pumpEventQueue();

    expect(
      deps.preferences.getBool(WakeWordController.enabledPreferenceKey),
      isTrue,
    );
    expect(deps.wakeWordPlatform.startCalls, 1);
    expect(container.read(wakeWordStateProvider).listening, isTrue);

    await container.read(wakeWordStateProvider.notifier).setEnabled(false);
    await pumpEventQueue();

    expect(
      deps.preferences.getBool(WakeWordController.enabledPreferenceKey),
      isFalse,
    );
    expect(deps.wakeWordPlatform.stopCalls, 1);
    expect(container.read(wakeWordStateProvider).listening, isFalse);
  });

  test('a detection updates the orb and is reported to analytics', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    deps.wakeWordPlatform.emit(
      WakeWordDetected(name: 'hey_jarvis', score: 0.93, at: DateTime.now()),
    );
    await pumpEventQueue();

    final state = container.read(wakeWordStateProvider);
    expect(state.lastDetection?.name, 'hey_jarvis');
    expect(state.lastDetection?.score, 0.93);
    expect(
      deps.analyticsBackend.events,
      contains('wake_word_detected'),
    );
    expect(
      deps.crashBackend.breadcrumbs,
      contains('Wake word detected: hey_jarvis'),
    );
  });

  test('a native permission failure is surfaced as an actionable message', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    deps.wakeWordPlatform.emit(
      const WakeWordFailure(code: 'permission_denied', message: 'RECORD_AUDIO not granted'),
    );
    await pumpEventQueue();

    final state = container.read(wakeWordStateProvider);
    expect(state.error, contains('microphone and notification access'));
    expect(state.listening, isFalse);
  });

  test('arm() restarts listening when the service was killed', () async {
    final deps = await createTestDependencies(
      preferences: <String, Object>{WakeWordController.enabledPreferenceKey: true},
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();
    expect(container.read(wakeWordStateProvider).listening, isTrue);
    final callsAfterInit = deps.wakeWordPlatform.startCalls;

    // Simulate the OS killing the foreground service: it reports stopped, and the
    // native side no longer reports itself as running.
    deps.wakeWordPlatform.running = false;
    deps.wakeWordPlatform.emit(const WakeWordStopped());
    await pumpEventQueue();
    expect(container.read(wakeWordStateProvider).listening, isFalse);

    await container.read(wakeWordStateProvider.notifier).arm();
    await pumpEventQueue();

    expect(deps.wakeWordPlatform.startCalls, callsAfterInit + 1);
    expect(container.read(wakeWordStateProvider).listening, isTrue);
  });

  test('availability maps to a user-facing message for every reason', () {
    expect(
      const WakeWordAvailability(available: true, reason: 'ok', models: ['hey_nova'])
          .userMessage,
      contains('hey_nova'),
    );
    expect(
      const WakeWordAvailability(available: false, reason: 'unsupported_platform')
          .userMessage,
      contains('not available on this platform'),
    );
    expect(
      const WakeWordAvailability(available: false, reason: 'missing_shared_models')
          .userMessage,
      contains('missing'),
    );
    expect(
      const WakeWordAvailability(available: false, reason: 'permission_denied')
          .userMessage,
      contains('microphone'),
    );
  });
}
