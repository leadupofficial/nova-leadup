import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/models.dart';
import '../../core/api/nova_api.dart' show NovaApiException, novaApiProvider;
import '../../core/voice/device_tts.dart';
import '../../services/analytics_service.dart';
import '../auth/auth_controller.dart';
import 'briefing_models.dart';
import 'briefing_reconciler.dart';
import 'briefing_settings_store.dart';

/// Reads and writes the three persisted briefing keys.
final briefingSettingsStoreProvider = Provider<BriefingSettingsStore>(
  (ref) => BriefingSettingsStore(ref.watch(sharedPreferencesProvider)),
);

/// The one-line explanation shown when the device cannot voice the briefing.
///
/// §9.4's honest-handling rule: a missing voice is stated in the UI, not
/// swallowed. The text is still shown, so the user is never left with nothing.
String noVoiceMessage(String languageTag) =>
    'This device has no voice for $languageTag, so NOVA cannot read the '
    'briefing aloud. Install a text-to-speech voice for that language in your '
    'device settings, or read it below.';

/// What the daily-briefing screen renders.
@immutable
class DailyBriefingState {
  const DailyBriefingState({
    this.settings = DailyBriefingSettings.defaults,
    this.reconciliation = BriefingReconciliation.idle,
    this.status = BriefingStatus.idle,
    this.briefing,
    this.error,
    this.voiceNotice,
    this.lastSpokenAt,
  });

  final DailyBriefingSettings settings;

  /// What the OS is currently holding.
  final BriefingReconciliation reconciliation;

  final BriefingStatus status;

  /// The most recently fetched briefing. Held in memory only.
  final NovaBriefing? briefing;

  final String? error;

  /// Set when the device has no voice for the briefing's language.
  final String? voiceNotice;

  final DateTime? lastSpokenAt;

  bool get isEnabled => settings.enabled;
  bool get isBusy =>
      status == BriefingStatus.loading || status == BriefingStatus.speaking;
  String? get text => briefing?.text;

  DailyBriefingState copyWith({
    DailyBriefingSettings? settings,
    BriefingReconciliation? reconciliation,
    BriefingStatus? status,
    NovaBriefing? briefing,
    String? error,
    String? voiceNotice,
    DateTime? lastSpokenAt,
    bool clearError = false,
    bool clearVoiceNotice = false,
  }) {
    return DailyBriefingState(
      settings: settings ?? this.settings,
      reconciliation: reconciliation ?? this.reconciliation,
      status: status ?? this.status,
      briefing: briefing ?? this.briefing,
      error: clearError ? null : (error ?? this.error),
      voiceNotice: clearVoiceNotice
          ? null
          : (voiceNotice ?? this.voiceNotice),
      lastSpokenAt: lastSpokenAt ?? this.lastSpokenAt,
    );
  }
}

/// Owns the daily briefing: the opt-in, the alarm and the spoken delivery.
///
/// The two halves are separate for the same reason they are for reminders.
/// Android shows the scheduled notification with the app closed, so the user
/// always learns the briefing exists; the in-app timer speaks it when the
/// process happens to be alive. Nothing here ever speaks without the opt-in
/// being on — [fetchAndSpeak] refuses outright when it is off, and the only
/// path that bypasses that is an explicit tap in the settings screen.
class DailyBriefingController extends Notifier<DailyBriefingState> {
  Timer? _timer;
  bool _busy = false;

  @override
  DailyBriefingState build() {
    final settings = ref.watch(briefingSettingsStoreProvider).read();
    final authenticated = ref.watch(
      authStateProvider.select((state) => state.isAuthenticated),
    );

    ref.onDispose(_cancelTimer);

    if (authenticated && settings.enabled) {
      // Deferred: `reconcile` writes state, which is illegal while `build` is
      // still running.
      unawaited(Future<void>.microtask(reconcile));
    } else {
      // A fresh install lands here: nothing armed, nothing to say.
      _cancelTimer();
    }

    return DailyBriefingState(settings: settings);
  }

  /// Flips the opt-in and re-arms (or drops) the alarm.
  ///
  /// §9.4 makes the briefing opt-in, so this toggle *is* the activation event;
  /// it is reported to analytics because a device-local preference cannot be
  /// measured from the server.
  Future<bool> setEnabled(bool value) async {
    await _persist(state.settings.copyWith(enabled: value));
    if (!value) _cancelTimer();
    await reconcile();
    await ref.read(analyticsServiceProvider).logEvent(
          AnalyticsService.eventDailyBriefingEnabled,
          parameters: <String, Object?>{'enabled': value},
        );
    return value;
  }

  /// Changes the time of day. 24-hour, device-local.
  Future<void> setTime({required int hour, required int minute}) async {
    await _persist(
      state.settings.copyWith(
        hour: hour.clamp(0, 23),
        minute: minute.clamp(0, 59),
      ),
    );
    await reconcile();
  }

  /// Brings the OS alarm and the in-app timer in line with the preference.
  Future<BriefingReconciliation?> reconcile() async {
    try {
      final result = await ref
          .read(briefingReconcilerProvider)
          .reconcile(state.settings);
      if (!ref.mounted) return null;
      _armSpeech(result.nextAt);
      state = state.copyWith(reconciliation: result, clearError: true);
      return result;
    } catch (error) {
      if (!ref.mounted) return null;
      state = state.copyWith(error: _message(error));
      return null;
    }
  }

  /// Checks, before the time arrives, whether the device can voice the
  /// configured language, so the screen can warn instead of failing later.
  Future<void> probeVoice() async {
    final policy = ref.read(onboardingServiceProvider).getLanguagePolicy();
    // An empty sample leaves `auto`/`tanglish` on the device default voice,
    // which always counts as available; a fixed policy resolves to its tag.
    final tag = resolveDeviceLanguageTag(languagePolicy: policy, text: '');
    final available =
        tag == null || await ref.read(deviceTtsProvider).canSpeak(tag);
    if (!ref.mounted) return;
    state = state.copyWith(
      voiceNotice: available ? null : noVoiceMessage(tag),
      clearVoiceNotice: available,
    );
  }

  /// Fetches and speaks, because the scheduled time arrived.
  Future<BriefingSpeechOutcome> fetchAndSpeak() =>
      _fetchAndSpeak(userInitiated: false);

  /// Fetches and speaks because the user asked, right now.
  ///
  /// A tap is a request, so this works with the opt-in still off — nothing is
  /// spoken that the user did not just ask for.
  Future<BriefingSpeechOutcome> preview() => _fetchAndSpeak(userInitiated: true);

  /// Silences the device voice without changing the opt-in.
  Future<void> stopSpeaking() async {
    await ref.read(deviceTtsProvider).stop();
    if (ref.mounted) state = state.copyWith(status: BriefingStatus.ready);
  }

  /// Forgets the last briefing. Nothing is persisted, so this is all it takes.
  void clear() {
    state = state.copyWith(briefing: null, status: BriefingStatus.idle);
  }

  // ── internals ────────────────────────────────────────────────────────────

  Future<BriefingSpeechOutcome> _fetchAndSpeak({
    required bool userInitiated,
  }) async {
    if (!userInitiated && !state.settings.enabled) {
      return BriefingSpeechOutcome.notOptedIn;
    }
    if (_busy) return BriefingSpeechOutcome.busy;

    _busy = true;
    state = state.copyWith(status: BriefingStatus.loading, clearError: true);
    try {
      if (!ref.read(authStateProvider).isAuthenticated) {
        state = state.copyWith(
          status: BriefingStatus.failed,
          error: 'Sign in before asking for a briefing.',
        );
        return BriefingSpeechOutcome.failed;
      }

      final language = ref.read(onboardingServiceProvider).getLanguagePolicy();
      final briefing = await ref.read(novaApiProvider).getBriefing(
        language: language,
      );
      if (!ref.mounted) return BriefingSpeechOutcome.failed;

      if (briefing.isEmpty) {
        state = state.copyWith(
          status: BriefingStatus.failed,
          error: 'The briefing came back empty, so there is nothing to read.',
        );
        return BriefingSpeechOutcome.empty;
      }

      state = state.copyWith(
        briefing: briefing,
        status: BriefingStatus.ready,
        clearError: true,
      );
      return await _speak(briefing.text);
    } catch (error) {
      if (!ref.mounted) return BriefingSpeechOutcome.failed;
      state = state.copyWith(
        status: BriefingStatus.failed,
        error: _message(error),
      );
      return BriefingSpeechOutcome.failed;
    } finally {
      _busy = false;
    }
  }

  Future<BriefingSpeechOutcome> _speak(String text) async {
    final tts = ref.read(deviceTtsProvider);
    final policy = ref.read(onboardingServiceProvider).getLanguagePolicy();
    final tag = resolveDeviceLanguageTag(languagePolicy: policy, text: text);

    if (tag != null && !await tts.canSpeak(tag)) {
      // Deliberately NOT falling back to the device default voice: reading a
      // Tamil briefing with an English engine is worse than saying nothing, and
      // §9.4 requires the UI to state the problem rather than fail silently.
      if (ref.mounted) {
        state = state.copyWith(
          status: BriefingStatus.ready,
          voiceNotice: noVoiceMessage(tag),
        );
      }
      return BriefingSpeechOutcome.noVoice;
    }

    if (ref.mounted) {
      state = state.copyWith(
        status: BriefingStatus.speaking,
        clearVoiceNotice: true,
      );
    }

    try {
      await tts.speak(text, languageTag: tag);
    } catch (error) {
      if (ref.mounted) {
        state = state.copyWith(
          status: BriefingStatus.ready,
          error: 'Could not speak the briefing.',
        );
      }
      if (kDebugMode) debugPrint('[Briefing] speak failed: $error');
      return BriefingSpeechOutcome.failed;
    }

    if (ref.mounted) {
      state = state.copyWith(
        status: BriefingStatus.ready,
        lastSpokenAt: DateTime.now(),
        clearError: true,
      );
      // §22.1 asks for per-active-user counts; this is the briefing's.
      await ref.read(analyticsServiceProvider).logEvent(
            AnalyticsService.eventDailyBriefingSpoken,
            parameters: <String, Object?>{
              'source': state.briefing?.source ?? 'unknown',
            },
          );
    }
    return BriefingSpeechOutcome.spoken;
  }

  /// Arms the single in-app timer that speaks the briefing while the process is
  /// alive. A long delay rarely survives to its deadline, which is why every
  /// reconcile pass re-arms it.
  void _armSpeech(DateTime? at) {
    _cancelTimer();
    if (!state.settings.enabled || at == null) return;
    final delay = at.difference(DateTime.now());
    _timer = Timer(
      delay.isNegative ? Duration.zero : delay,
      () => unawaited(fetchAndSpeak()),
    );
  }

  void _cancelTimer() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _persist(DailyBriefingSettings settings) async {
    await ref.read(briefingSettingsStoreProvider).write(settings);
    if (!ref.mounted) return;
    state = state.copyWith(settings: settings, clearError: true);
  }
}

String _message(Object error) => error is NovaApiException
    ? error.message
    : error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');

final dailyBriefingProvider =
    NotifierProvider<DailyBriefingController, DailyBriefingState>(
      DailyBriefingController.new,
    );
