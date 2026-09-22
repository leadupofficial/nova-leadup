import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../services/analytics_service.dart';
import '../avatar/avatar_provider.dart';
import 'wake_word_service.dart';

@immutable
class WakeWordState {
  const WakeWordState({
    this.enabled = false,
    this.listening = false,
    this.busy = false,
    this.availability,
    this.lastDetection,
    this.error,
  });

  /// The user's persisted preference.
  final bool enabled;

  /// Whether the native foreground service reports it is listening.
  final bool listening;

  /// True while a start/stop round-trip is in flight.
  final bool busy;

  final WakeWordAvailability? availability;

  final WakeWordDetected? lastDetection;

  final String? error;

  bool get isSupported => availability?.available ?? false;

  /// The wake words the native service found in the app bundle.
  List<String> get installedModels => availability?.models ?? const <String>[];

  /// The wake word the service will actually listen for — the user's stored
  /// choice, or (when nothing is stored) the one installed wake word. Null when
  /// no wake word is installed at all.
  String? get selectedModel => availability?.selected;

  /// True only when there is a real choice to make. Today's build ships one
  /// wake word (`hey_nova`), so this is false and the UI says so instead of
  /// drawing a picker with a single, inert row.
  bool get hasChoice => availability?.hasChoice ?? false;

  /// The phrase NOVA will actually listen for, humanised (`Hey Nova`), or null
  /// when no wake word is installed.
  ///
  /// There is deliberately no invented fallback. This used to answer `'Hey
  /// Nova'` unconditionally, from a hardcoded product name rather than from what
  /// the service reports; every screen that showed it was naming a phrase the
  /// microphone might not be loaded with. The phrase now comes from the
  /// installed keywords file, which is data — `hey_nova` is the shipped one.
  String? get phrase {
    final selected = availability?.selectedPhrase;
    if (selected != null) return selected;
    if (installedModels.isEmpty) return null;
    return installedModels.map(humanizeWakeWordName).join(' or ');
  }

  /// What the wake word is doing *right now* — the Status row's line.
  ///
  /// [availability] cannot answer this on its own: a wake word being installed is
  /// not a service being listened for. This reads the user's toggle and the state
  /// the native service reports as well, so the row says "Listening" only when it
  /// genuinely is, and names the phrase the same humanised way every other surface
  /// does. A real failure keeps the native reason message rather than being turned
  /// into a cheerful status.
  String get statusMessage {
    final availability = this.availability;
    if (availability == null) return 'Checking availability…';
    if (!availability.available) return availability.userMessage;
    final phrase = this.phrase;
    if (enabled && listening) {
      return phrase == null ? 'Listening' : 'Listening for "$phrase"';
    }
    if (enabled) return 'Wake word is paused';
    return 'Wake word is off';
  }

  WakeWordState copyWith({
    bool? enabled,
    bool? listening,
    bool? busy,
    WakeWordAvailability? availability,
    WakeWordDetected? lastDetection,
    String? error,
    bool clearError = false,
  }) {
    return WakeWordState(
      enabled: enabled ?? this.enabled,
      listening: listening ?? this.listening,
      busy: busy ?? this.busy,
      availability: availability ?? this.availability,
      lastDetection: lastDetection ?? this.lastDetection,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// Bridges the native wake word service to the UI and owns the user's preference.
class WakeWordController extends Notifier<WakeWordState> {
  /// Persisted preference key. `BootReceiver.kt` reads this exact key
  /// (`flutter.nova_wake_word_enabled` once shared_preferences prefixes it) to decide
  /// whether to re-arm after a reboot, so the two must stay in sync.
  static const String enabledPreferenceKey = 'nova_wake_word_enabled';

  StreamSubscription<WakeWordEvent>? _subscription;
  bool _disposed = false;

  @override
  WakeWordState build() {
    final prefs = ref.read(sharedPreferencesProvider);
    final enabled = prefs.getBool(enabledPreferenceKey) ?? false;

    final platform = ref.read(wakeWordPlatformProvider);
    _subscription = platform.events.listen(
      _onEvent,
      onError: (Object error) {
        if (_disposed) return;
        state = state.copyWith(error: 'Wake word listener error: $error');
      },
    );

    ref.onDispose(() {
      _disposed = true;
      _subscription?.cancel();
      _subscription = null;
    });

    // Probe availability, and re-arm if the user had it on. Scheduled rather than
    // awaited so `build()` stays synchronous.
    unawaited(_initialize());

    return WakeWordState(enabled: enabled);
  }

  Future<void> _initialize() async {
    final platform = ref.read(wakeWordPlatformProvider);
    final availability = await platform.availability();
    if (_disposed) return;

    state = state.copyWith(availability: availability);

    if (state.enabled && availability.available) {
      await start();
    } else if (state.enabled && !availability.available) {
      // The preference is on but the build cannot honour it: make that visible
      // instead of showing an enabled toggle that does nothing.
      state = state.copyWith(
        enabled: false,
        error: availability.userMessage,
      );
      await ref.read(sharedPreferencesProvider).setBool(enabledPreferenceKey, false);
    }
  }

  /// Re-reads availability from the native service.
  ///
  /// Used by the settings screen's "Re-check" action: the set of installed
  /// wake words is fixed at build time, but the probe also reports whether the
  /// platform is supported at all, and that can change (e.g. the plugin is only
  /// registered on Android).
  Future<void> refreshAvailability() async {
    final platform = ref.read(wakeWordPlatformProvider);
    final availability = await platform.availability();
    if (_disposed) return;
    state = state.copyWith(availability: availability);
  }

  /// Chooses which installed wake word the service listens for.
  ///
  /// Nothing is written unless the native service accepts the name: it is the
  /// only party that can see which keywords files are actually installed, so a
  /// phrase that is not installed is refused here rather than shown as selected.
  ///
  /// The selection is applied immediately when the service is currently
  /// listening (the engine is already built around the old wake word). A
  /// paused service picks the new choice up on its next start — this never
  /// starts the microphone behind the user's back.
  Future<bool> setModel(String name) async {
    if (state.busy) return false;

    if (name == state.selectedModel) return true;

    final platform = ref.read(wakeWordPlatformProvider);
    final availability = state.availability ?? await platform.availability();
    if (_disposed) return false;

    if (!availability.models.contains(name)) {
      // Refuse before reaching the platform: the UI can only offer installed
      // wake words, so this is a programming error or a stale screen, and
      // either way there is nothing to persist.
      state = state.copyWith(
        availability: availability,
        error: 'No installed wake word is named "$name".',
      );
      return false;
    }

    final accepted = await platform.selectModel(name);
    if (_disposed) return false;
    if (!accepted) {
      // The platform is the authority on what is installed. Re-read rather than
      // keeping a stale list, so the screen stops offering a wake word the
      // service does not have.
      final refreshed = await platform.availability();
      if (_disposed) return false;
      state = state.copyWith(
        availability: refreshed,
        error: 'This device refused the wake word "$name".',
      );
      return false;
    }

    // Re-read availability instead of assuming: `selected` is then the
    // service's own answer, not what the screen hoped for.
    final refreshed = await platform.availability();
    if (_disposed) return false;
    state = state.copyWith(availability: refreshed, clearError: true);

    await ref.read(analyticsServiceProvider).logEvent(
          AnalyticsService.eventWakeWordSelected,
          parameters: <String, Object?>{'wake_word': name},
        );

    if (state.listening) {
      await stop();
      await start();
    }
    return true;
  }

  /// Turns listening on or off and persists the choice.
  Future<void> setEnabled(bool value) async {
    if (state.busy) return;

    if (value) {
      // Refuse to persist an enabled preference the build cannot honour; otherwise the
      // toggle would survive a restart while never actually listening.
      final availability =
          state.availability ?? await ref.read(wakeWordPlatformProvider).availability();
      if (_disposed) return;
      if (!availability.available) {
        await ref.read(sharedPreferencesProvider).setBool(enabledPreferenceKey, false);
        state = state.copyWith(
          enabled: false,
          listening: false,
          availability: availability,
          error: availability.userMessage,
        );
        return;
      }
    }

    await ref.read(sharedPreferencesProvider).setBool(enabledPreferenceKey, value);
    state = state.copyWith(enabled: value, clearError: true);

    await ref.read(analyticsServiceProvider).logEvent(
          AnalyticsService.eventWakeWordEnabled,
          parameters: <String, Object?>{'enabled': value},
        );

    if (value) {
      await start();
    } else {
      await stop();
    }
  }

  Future<void> start() async {
    if (state.busy) return;

    final platform = ref.read(wakeWordPlatformProvider);
    final availability = state.availability ?? await platform.availability();
    if (!availability.available) {
      state = state.copyWith(
        listening: false,
        availability: availability,
        error: availability.userMessage,
      );
      return;
    }

    state = state.copyWith(busy: true, clearError: true);
    final started = await platform.start();
    if (_disposed) return;

    // `start()` only asks the service to run; the authoritative "listening" signal
    // arrives asynchronously over the event channel.
    //
    // `clearError` is deliberately NOT tied to `started`. The native side answers
    // this call successfully and then reports a refusal as an error *event* — for
    // example "POST_NOTIFICATIONS not granted", which it refuses rather than
    // starting a microphone foreground service without. That event can land
    // before this line runs, and clearing on `started` wiped the message, so the
    // screen just said "not running" with no reason and no way to fix it.
    state = state.copyWith(
      busy: false,
      error: started ? null : 'Could not start wake word detection.',
    );
  }

  Future<void> stop() async {
    if (state.busy) return;

    state = state.copyWith(busy: true, clearError: true);
    await ref.read(wakeWordPlatformProvider).stop();
    if (_disposed) return;
    state = state.copyWith(busy: false, listening: false);
  }

  /// Re-arms listening if the user enabled it. Call on app resume: the Android
  /// foreground service can be killed under memory pressure, and this is the
  /// reliable place to bring it back (a BOOT_COMPLETED restart is not permitted for
  /// microphone services on Android 15+).
  ///
  /// The service is asked, never assumed. `state.listening` cannot answer "is the
  /// microphone live": a service killed under memory pressure emits no
  /// `WakeWordStopped`, so the flag can be stale *true* — and the early return on it
  /// meant exactly the case this method exists for was the case it skipped. The
  /// same flag can be stale *false*, because a detection clears it while the native
  /// engine keeps capturing.
  Future<void> arm() async {
    if (!state.enabled) return;
    final platform = ref.read(wakeWordPlatformProvider);
    final availability = state.availability ?? await platform.availability();
    if (_disposed) return;
    if (!availability.available) {
      state = state.copyWith(availability: availability, listening: false);
      return;
    }

    final running = await platform.isRunning();
    if (_disposed) return;
    if (running) {
      state = state.copyWith(listening: true);
      return;
    }

    state = state.copyWith(listening: false);
    await start();
  }

  /// Makes `listening` describe the native service rather than a local guess.
  ///
  /// Used after a detection, which is the event that most invites the wrong guess:
  /// the engine resets and immediately keeps capturing for the next phrase, so
  /// nothing about it means "the microphone stopped". Clearing the flag here made
  /// the Status row read "Wake word is paused" while the microphone was genuinely
  /// live — the app claiming *not* to listen, which is still a false claim about
  /// the microphone, and one the user cannot act on.
  Future<void> _refreshListening() async {
    final running = await ref.read(wakeWordPlatformProvider).isRunning();
    if (_disposed) return;
    state = state.copyWith(listening: running);
  }

  void clearError() {
    if (state.error == null) return;
    state = state.copyWith(clearError: true);
  }

  void _onEvent(WakeWordEvent event) {
    if (_disposed) return;

    switch (event) {
      case WakeWordListening():
        state = state.copyWith(listening: true, clearError: true, busy: false);
      case WakeWordStopped():
        state = state.copyWith(listening: false, busy: false);
      case WakeWordServiceStateChanged(:final running):
        state = state.copyWith(listening: running);
      case WakeWordDetected():
        // `lastDetection` drives the orb and the conversation flow; whether the
        // microphone is still live is asked of the service, not inferred from the
        // fact that a phrase was heard.
        state = state.copyWith(lastDetection: event);
        unawaited(_refreshListening());
        unawaited(_onDetected(event));
      case WakeWordFailure(:final code, :final message):
        state = state.copyWith(
          listening: false,
          busy: false,
          // Name the permission that actually failed. The native layer refuses to
          // start the microphone foreground service without BOTH microphone and
          // notification access and says which one is missing; collapsing that to a
          // generic sentence left the user tapping Resume with no idea what to fix.
          error: code == 'permission_denied'
              ? 'NOVA cannot listen yet — $message. Wake word detection runs in a '
                    'foreground service, so it needs both microphone and '
                    'notification access.'
              : message,
        );
    }
  }

  Future<void> _onDetected(WakeWordDetected detection) async {
    // The orb reacts immediately; the conversation flow is started by whatever
    // listens to `lastDetection`.
    await ref.read(avatarStateProvider.notifier).setState(AvatarState.listening);
    await ref.read(analyticsServiceProvider).logEvent(
          AnalyticsService.eventWakeWordDetected,
          parameters: <String, Object?>{'wake_word': detection.name},
        );
    await ref.read(crashReportingServiceProvider).log('Wake word detected: ${detection.name}');
  }
}

final wakeWordStateProvider = NotifierProvider<WakeWordController, WakeWordState>(
  WakeWordController.new,
);
