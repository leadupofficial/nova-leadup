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

  // ─── W-10: `listening` must describe the service, not a local guess ────────

  test('a detection does not claim the microphone stopped', () async {
    // After a detection the native engine resets and keeps capturing for the next
    // phrase. `WakeWordDetected` set `listening: false` from the local guess, so
    // the Status row read "Wake word is paused" — and the app stopped claiming to
    // listen only in the direction that is *wrong*, because the microphone was
    // genuinely live.
    final deps = await createTestDependencies(
      preferences: <String, Object>{WakeWordController.enabledPreferenceKey: true},
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();
    expect(container.read(wakeWordStateProvider).listening, isTrue);
    expect(deps.wakeWordPlatform.running, isTrue);

    deps.wakeWordPlatform.emit(
      WakeWordDetected(name: 'hey_jarvis', score: 0.93, at: DateTime.now()),
    );
    await pumpEventQueue();

    final state = container.read(wakeWordStateProvider);
    expect(state.lastDetection?.name, 'hey_jarvis');
    expect(
      state.listening,
      isTrue,
      reason:
          'the service still answers isRunning() == true, so `listening` must '
          'stay true and the Status row must keep saying it is listening',
    );
    expect(state.statusMessage, contains('Listening'));
  });

  test('arm() re-arms a service that died without reporting stopped', () async {
    // A foreground service killed under memory pressure emits no `WakeWordStopped`,
    // so the last thing the controller heard was `listening: true`. `arm()`
    // early-returned on exactly that stale flag, so the microphone stayed dead
    // until a cold start — the case `arm()` exists to fix.
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

    // Killed, with no event to say so: the app's own flag still says `true`.
    deps.wakeWordPlatform.running = false;

    await container.read(wakeWordStateProvider.notifier).arm();
    await pumpEventQueue();

    expect(
      deps.wakeWordPlatform.startCalls,
      callsAfterInit + 1,
      reason: 'the service is dead; arm() must not trust the stale flag',
    );
    expect(container.read(wakeWordStateProvider).listening, isTrue);
  });

  test('arm() does not restart a service that is genuinely running', () async {
    final deps = await createTestDependencies(
      preferences: <String, Object>{WakeWordController.enabledPreferenceKey: true},
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();
    final callsAfterInit = deps.wakeWordPlatform.startCalls;

    await container.read(wakeWordStateProvider.notifier).arm();
    await pumpEventQueue();

    expect(deps.wakeWordPlatform.startCalls, callsAfterInit);
    expect(container.read(wakeWordStateProvider).listening, isTrue);
  });

  test('availability maps to a user-facing message for every reason', () {
    // The `ok` message describes *availability*, not state. It used to answer
    // "Listening for hey_nova." from a wake word merely being installed, and the home
    // dashboard's Status row rendered exactly that on a device where the wake word had
    // never been switched on — while leaking the raw asset key next to a humanised one.
    // This assertion used to require the raw name; that encoded the defect.
    final available = const WakeWordAvailability(
      available: true,
      reason: 'ok',
      models: ['hey_nova'],
    ).userMessage;
    expect(available, contains('Hey Nova'));
    expect(available, isNot(contains('hey_nova')));
    expect(available.toLowerCase(), isNot(contains('listening')));

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

  test('statusMessage states what the wake word is doing, not what is installed', () {
    const availability = WakeWordAvailability(
      available: true,
      reason: 'ok',
      models: <String>['hey_nova'],
      selected: 'hey_nova',
    );

    // Installed, but the user never switched it on. This is the D1 defect: "Listening"
    // must not be claimed from availability alone.
    const off = WakeWordState(availability: availability);
    expect(off.statusMessage, 'Wake word is off');
    expect(off.statusMessage.toLowerCase(), isNot(contains('listening')));

    // Switched on, but the native service has not reported listening.
    const paused = WakeWordState(availability: availability, enabled: true);
    expect(paused.statusMessage, 'Wake word is paused');
    expect(paused.statusMessage.toLowerCase(), isNot(contains('listening')));

    // Genuinely listening: the phrase is named humanised, like every other surface.
    const listening = WakeWordState(
      availability: availability,
      enabled: true,
      listening: true,
    );
    expect(listening.statusMessage, 'Listening for "Hey Nova"');

    // A real failure keeps the native reason rather than becoming a cheerful status.
    const failed = WakeWordState(
      availability: WakeWordAvailability(
        available: false,
        reason: 'no_wake_word_model',
      ),
      enabled: true,
      listening: true,
    );
    expect(failed.statusMessage, contains('No wake word is installed'));

    // Before the probe has answered.
    expect(const WakeWordState().statusMessage, 'Checking availability…');
  });

  // ─── Model selection (requirement 2) ──────────────────────────────────────

  /// The two-classifier case, which no shipped build has yet. It is the case the
  /// picker exists for, so the controller's behaviour is pinned here even though
  /// the UI never draws the picker today.
  WakeWordAvailability twoInstalled({String selected = 'hey_jarvis'}) =>
      WakeWordAvailability(
        available: true,
        reason: 'ok',
        models: const <String>['hey_jarvis', 'hey_mycroft'],
        selected: selected,
      );

  test('a build with one classifier offers no choice', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    final state = container.read(wakeWordStateProvider);
    expect(state.installedModels, <String>['hey_jarvis']);
    expect(state.hasChoice, isFalse);
    expect(state.selectedModel, 'hey_jarvis');
    expect(state.phrase, 'Hey Jarvis');
  });

  test('no installed classifier yields no phrase, and no invented one', () async {
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

    final state = container.read(wakeWordStateProvider);
    // The regression this guards: `phrase` used to answer 'Hey Nova' here.
    expect(state.phrase, isNull);
    expect(state.selectedModel, isNull);
    expect(state.hasChoice, isFalse);
  });

  test('choosing an installed classifier persists it and applies it', () async {
    final deps = await createTestDependencies(
      preferences: <String, Object>{WakeWordController.enabledPreferenceKey: true},
      wakeWordAvailability: twoInstalled(),
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();
    expect(container.read(wakeWordStateProvider).listening, isTrue);
    final startsBefore = deps.wakeWordPlatform.startCalls;

    final accepted = await container
        .read(wakeWordStateProvider.notifier)
        .setModel('hey_mycroft');
    await pumpEventQueue();

    expect(accepted, isTrue);
    expect(deps.wakeWordPlatform.selectModelCalls, <String>['hey_mycroft']);
    final state = container.read(wakeWordStateProvider);
    expect(state.selectedModel, 'hey_mycroft');
    expect(state.phrase, 'Hey Mycroft');
    expect(state.error, isNull);
    // The engine was already built around the old classifier, so the service is
    // cycled to pick the new one up now rather than at the next cold start.
    expect(deps.wakeWordPlatform.stopCalls, 1);
    expect(deps.wakeWordPlatform.startCalls, startsBefore + 1);
    expect(state.listening, isTrue);
  });

  test('a paused service keeps the choice without starting the microphone', () async {
    final deps = await createTestDependencies(
      wakeWordAvailability: twoInstalled(),
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    final accepted = await container
        .read(wakeWordStateProvider.notifier)
        .setModel('hey_mycroft');
    await pumpEventQueue();

    expect(accepted, isTrue);
    expect(container.read(wakeWordStateProvider).selectedModel, 'hey_mycroft');
    // Nothing was listening, so nothing may be started behind the user's back.
    expect(deps.wakeWordPlatform.startCalls, 0);
    expect(deps.wakeWordPlatform.stopCalls, 0);
    expect(container.read(wakeWordStateProvider).listening, isFalse);
  });

  test('refuses a classifier that is not installed, and writes nothing', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    // 'hey_nova' is the phrase the product is named after and the one no build
    // can hear. It must not become the selection just because it was asked for.
    final accepted = await container
        .read(wakeWordStateProvider.notifier)
        .setModel('hey_nova');
    await pumpEventQueue();

    expect(accepted, isFalse);
    expect(deps.wakeWordPlatform.selectModelCalls, isEmpty);
    final state = container.read(wakeWordStateProvider);
    expect(state.selectedModel, 'hey_jarvis');
    expect(state.error, contains('hey_nova'));
  });

  test('reports a native refusal instead of assuming the choice stuck', () async {
    final deps = await createTestDependencies(
      wakeWordAvailability: twoInstalled(),
    );
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    // The fake refuses anything it does not report as installed, so revoke the
    // second model after the screen has already been told about it — the stale
    // screen case that must not persist a phrase the service will ignore.
    deps.wakeWordPlatform.availabilityResult = const WakeWordAvailability(
      available: true,
      reason: 'ok',
      models: <String>['hey_jarvis'],
      selected: 'hey_jarvis',
    );

    final accepted = await container
        .read(wakeWordStateProvider.notifier)
        .setModel('hey_mycroft');
    await pumpEventQueue();

    // The controller's own list still had it, so the call reached the platform —
    // and the platform's refusal is what decides the outcome.
    expect(deps.wakeWordPlatform.selectModelCalls, <String>['hey_mycroft']);
    expect(accepted, isFalse);
    final state = container.read(wakeWordStateProvider);
    expect(state.error, contains('refused'));
    // Availability is re-read, so the stale entry disappears with it.
    expect(state.selectedModel, 'hey_jarvis');
    expect(state.installedModels, <String>['hey_jarvis']);
  });

  test('selecting the phrase already in use is a no-op', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();

    final accepted = await container
        .read(wakeWordStateProvider.notifier)
        .setModel('hey_jarvis');
    await pumpEventQueue();

    expect(accepted, isTrue);
    expect(deps.wakeWordPlatform.selectModelCalls, isEmpty);
  });

  test('refreshAvailability picks up a newly installed classifier', () async {
    final deps = await createTestDependencies();
    addTearDown(deps.dispose);

    final container = createTestContainer(deps);
    addTearDown(container.dispose);

    container.read(wakeWordStateProvider);
    await pumpEventQueue();
    expect(container.read(wakeWordStateProvider).hasChoice, isFalse);

    deps.wakeWordPlatform.availabilityResult = twoInstalled();

    await container.read(wakeWordStateProvider.notifier).refreshAvailability();
    await pumpEventQueue();

    expect(container.read(wakeWordStateProvider).hasChoice, isTrue);
  });
}
