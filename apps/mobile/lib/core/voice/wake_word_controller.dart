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
    state = state.copyWith(
      busy: false,
      error: started ? null : 'Could not start wake word detection.',
      clearError: started,
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
  Future<void> arm() async {
    if (!state.enabled) return;
    if (state.listening) return;
    final platform = ref.read(wakeWordPlatformProvider);
    final availability = state.availability ?? await platform.availability();
    if (_disposed) return;
    if (!availability.available) {
      state = state.copyWith(availability: availability);
      return;
    }
    if (await platform.isRunning()) {
      if (_disposed) return;
      state = state.copyWith(listening: true);
      return;
    }
    await start();
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
        state = state.copyWith(listening: false, lastDetection: event);
        unawaited(_onDetected(event));
      case WakeWordFailure(:final code, :final message):
        state = state.copyWith(
          listening: false,
          busy: false,
          error: code == 'permission_denied'
              ? 'NOVA needs microphone and notification access to listen for the wake word.'
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
