import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/voice/device_tts.dart';
import 'notification_app_catalogue.dart';
import 'notification_content_guard.dart';
import 'notification_filter.dart';
import 'notification_models.dart';
import 'notification_platform.dart';
import 'notification_settings_store.dart';

/// Native transport for the notification listener.
///
/// Only Android has an implementation (`NovaNotificationListenerService.kt`).
/// Elsewhere the app gets [UnsupportedNotificationAssistantPlatform], which
/// reports `supported: false` so the screen explains the situation instead of
/// offering a toggle that could never work. Override in tests with a fake.
final notificationAssistantPlatformProvider =
    Provider<NotificationAssistantPlatform>((ref) {
      final platform = defaultTargetPlatform == TargetPlatform.android
          ? MethodChannelNotificationAssistantPlatform()
          : const UnsupportedNotificationAssistantPlatform();
      ref.onDispose(platform.dispose);
      return platform;
    });

/// Reads and writes the five persisted settings keys.
final notificationSettingsStoreProvider = Provider<NotificationSettingsStore>(
  (ref) => NotificationSettingsStore(ref.watch(sharedPreferencesProvider)),
);

/// What the settings screen renders.
@immutable
class NotificationAssistantState {
  const NotificationAssistantState({
    this.settings = const NotificationGuardSettings(),
    this.status,
    this.inbox = const <UntrustedNotificationData>[],
    this.discoveredApps = const <DiscoveredApp>[],
    this.sessionSpeechConsent = false,
    this.busy = false,
    this.error,
  });

  final NotificationGuardSettings settings;
  final NotificationAssistantStatus? status;

  /// The allowed, filtered notifications currently held **in memory only**.
  /// Cleared on disable, on notification-access revocation and on process
  /// death. Nothing here is ever written to disk.
  final List<UntrustedNotificationData> inbox;

  /// Packages the listener has seen post a notification while the assistant was
  /// on and that are not blocked. Metadata only; also in memory only.
  final List<DiscoveredApp> discoveredApps;

  /// Whether the user has confirmed read-aloud for this session. Not persisted:
  /// §9.3 requires a confirmation *per session*, so this resets on every
  /// restart and on every change to the feature's switches.
  final bool sessionSpeechConsent;

  final bool busy;
  final String? error;

  bool get isEnabled => settings.enabled;
  bool get isSupported => status?.supported ?? false;
  bool get hasAccess => status?.accessGranted ?? false;
  bool get readAloudEnabled => settings.readAloudEnabled;

  NotificationAssistantState copyWith({
    NotificationGuardSettings? settings,
    NotificationAssistantStatus? status,
    List<UntrustedNotificationData>? inbox,
    List<DiscoveredApp>? discoveredApps,
    bool? sessionSpeechConsent,
    bool? busy,
    String? error,
    bool clearError = false,
  }) {
    return NotificationAssistantState(
      settings: settings ?? this.settings,
      status: status ?? this.status,
      inbox: inbox ?? this.inbox,
      discoveredApps: discoveredApps ?? this.discoveredApps,
      sessionSpeechConsent: sessionSpeechConsent ?? this.sessionSpeechConsent,
      busy: busy ?? this.busy,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// The outcome of a read-aloud attempt.
enum SpeakOutcome {
  /// The utterance was handed to [DeviceTts].
  spoken,

  /// §5.21 rule 4 is off. Nothing is spoken.
  notOptedIn,

  /// §9.3 requires a confirmation per session and this session has not given
  /// one. The caller must show the confirmation and call again with
  /// `sessionConfirmed: true`.
  confirmationRequired,

  /// The content guard matched when re-checked immediately before speaking.
  blockedByGuard,

  /// There is no text worth speaking.
  empty,
}

/// Bridges the native listener to the UI and owns the user's settings.
///
/// Nothing in this class persists notification text: the only writes go through
/// [NotificationSettingsStore], whose five keys are booleans and package names.
class NotificationAssistantController extends Notifier<NotificationAssistantState> {
  /// How many filtered notifications are kept in memory.
  static const int inboxLimit = 20;

  /// How many discovered packages are offered as allowlist candidates.
  static const int discoveredLimit = 40;

  StreamSubscription<NotificationAssistantEvent>? _subscription;
  bool _disposed = false;

  @override
  NotificationAssistantState build() {
    final store = ref.read(notificationSettingsStoreProvider);
    final settings = store.read();

    final platform = ref.read(notificationAssistantPlatformProvider);
    _subscription = platform.events.listen(
      _onEvent,
      onError: (Object error) {
        if (_disposed) return;
        state = state.copyWith(error: 'Notification listener error: $error');
      },
    );

    ref.onDispose(() {
      _disposed = true;
      _subscription?.cancel();
      _subscription = null;
    });

    // Scheduled, not awaited: `build()` must stay synchronous.
    unawaited(_probe());

    return NotificationAssistantState(settings: settings);
  }

  /// Re-reads the platform status and turns the feature off if the user revoked
  /// Notification Access in Android Settings while it was on.
  ///
  /// §9.5 requires the feature to be instantly disableable, and access can be
  /// revoked without the app being told. Discovering it here — on every screen
  /// open and on every app resume — is what stops a revoked permission from
  /// leaving a toggle that looks on.
  Future<void> refreshStatus() async {
    state = state.copyWith(busy: true, clearError: true);
    final platform = ref.read(notificationAssistantPlatformProvider);
    final status = await platform.status();
    if (_disposed) return;

    if (state.settings.enabled && !status.accessGranted) {
      await _persist(
        state.settings.copyWith(enabled: false, readAloudEnabled: false),
        inbox: const <UntrustedNotificationData>[],
      );
      if (_disposed) return;
      state = state.copyWith(
        status: status,
        busy: false,
        error: 'Notification Access was revoked, so NOVA turned the assistant '
            'off and cleared what it held.',
      );
      return;
    }

    state = state.copyWith(status: status, busy: false);
  }

  /// Flips the master toggle.
  ///
  /// Enabling requires Notification Access; without it the toggle stays off and
  /// says why, rather than appearing on while nothing can be read.
  Future<bool> setEnabled(bool value) async {
    if (value && !state.hasAccess) {
      final status = await ref.read(notificationAssistantPlatformProvider).status();
      if (_disposed) return false;
      if (!status.accessGranted) {
        state = state.copyWith(
          status: status,
          error: 'Grant Notification Access first — NOVA cannot read anything '
              'until Android says it may.',
        );
        return false;
      }
      state = state.copyWith(status: status);
    }

    final next = state.settings.copyWith(
      enabled: value,
      // Turning the assistant off also turns read-aloud off: §9.5 requires the
      // whole capability to stop in one action.
      readAloudEnabled: value ? state.settings.readAloudEnabled : false,
    );

    await _persist(
      next,
      inbox: value ? state.inbox : const <UntrustedNotificationData>[],
      // A settings change invalidates the per-session confirmation.
      sessionSpeechConsent: false,
    );
    return value;
  }

  /// §5.21 "Summarize only high-priority work notifications".
  Future<void> setSummarizeHighPriorityOnly(bool value) async {
    await _persist(state.settings.copyWith(summarizeHighPriorityOnly: value));
  }

  /// §5.21 "Read notifications aloud" / §9.3 opt-in.
  ///
  /// This is only half of the requirement: the per-session confirmation in
  /// [speak] cannot be disabled from here or anywhere else.
  Future<bool> setReadAloudEnabled(bool value) async {
    if (value && !state.isEnabled) {
      state = state.copyWith(
        error: 'Turn the assistant on before enabling read-aloud.',
      );
      return false;
    }
    await _persist(
      state.settings.copyWith(readAloudEnabled: value),
      sessionSpeechConsent: false,
    );
    return value;
  }

  /// Ticks or unticks an app.
  ///
  /// Returns false — and changes nothing — when the app is permanently blocked,
  /// which is what makes banking and authenticator apps un-selectable rather
  /// than merely unchecked. The settings screen also disables those rows, so
  /// this is the second of two independent refusals.
  Future<bool> setPackageAllowed(String packageName, bool allowed) async {
    if (allowed && state.settings.isPackageBlocked(packageName)) return false;

    final next = <String>{...state.settings.allowedPackages};
    if (allowed) {
      next.add(packageName);
    } else {
      next.remove(packageName);
      // Unticking an app also drops anything already held from it, so the
      // in-memory inbox never outlives the permission that filled it.
      state = state.copyWith(
        inbox: state.inbox
            .where((item) => item.packageName != packageName)
            .toList(growable: false),
      );
    }
    await _persist(state.settings.copyWith(allowedPackages: next));
    return true;
  }

  /// Ticks Gmail, Google Calendar and WhatsApp Business — the three apps
  /// §5.21 draws as allowed.
  Future<void> allowRecommendedApps() async {
    final next = <String>{
      ...state.settings.allowedPackages,
      ...kRecommendedWorkPackages.where(
        (packageName) => !state.settings.isPackageBlocked(packageName),
      ),
    };
    await _persist(state.settings.copyWith(allowedPackages: next));
  }

  /// Turns the assistant off, forgets the allowlist and drops everything held.
  Future<void> disableAndClear() async {
    await _persist(
      const NotificationGuardSettings(),
      inbox: const <UntrustedNotificationData>[],
      discoveredApps: const <DiscoveredApp>[],
      sessionSpeechConsent: false,
    );
    await ref.read(notificationSettingsStoreProvider).clear();
    final status = await ref
        .read(notificationAssistantPlatformProvider)
        .status();
    if (_disposed) return;
    state = state.copyWith(status: status);
  }

  /// Opens Android's Notification Access screen.
  Future<bool> openAccessSettings() async {
    final opened = await ref
        .read(notificationAssistantPlatformProvider)
        .openAccessSettings();
    if (!opened && !_disposed) {
      state = state.copyWith(
        error: 'Could not open Android notification settings on this device.',
      );
    }
    return opened;
  }

  /// Forgets the per-session confirmation, e.g. when the user leaves the
  /// screen or taps "Stop reading aloud".
  void revokeSpeechConsent() {
    if (!state.sessionSpeechConsent) return;
    state = state.copyWith(sessionSpeechConsent: false);
  }

  /// Silences the device voice without changing the opt-in.
  Future<void> stopSpeaking() => ref.read(deviceTtsProvider).stop();

  /// Drops one notification from the in-memory inbox.
  void dismiss(UntrustedNotificationData data) {
    state = state.copyWith(
      inbox: state.inbox
          .where((item) => item != data)
          .toList(growable: false),
    );
  }

  /// Forgets everything held in memory, keeping the settings.
  void clearInbox() {
    state = state.copyWith(
      inbox: const <UntrustedNotificationData>[],
      discoveredApps: const <DiscoveredApp>[],
    );
  }

  /// Speaks one filtered notification with the device voice.
  ///
  /// §9.3/§9.5 require **both** an opt-in and a per-session confirmation, so
  /// this refuses unless [NotificationGuardSettings.readAloudEnabled] is on
  /// *and* this session already confirmed (or [sessionConfirmed] grants it
  /// now). It also re-runs [NotificationContentGuard] immediately before
  /// speaking: the filter already did, but the non-negotiable rule is worth
  /// checking at the last moment rather than trusting a value that has been
  /// sitting in memory.
  Future<SpeakOutcome> speak(
    UntrustedNotificationData data, {
    bool sessionConfirmed = false,
  }) async {
    if (!state.settings.readAloudEnabled || !state.isEnabled) {
      return SpeakOutcome.notOptedIn;
    }
    if (!data.hasText) return SpeakOutcome.empty;
    if (!sessionConfirmed && !state.sessionSpeechConsent) {
      return SpeakOutcome.confirmationRequired;
    }
    if (NotificationContentGuard.detectText(data.preview) != null) {
      return SpeakOutcome.blockedByGuard;
    }

    state = state.copyWith(sessionSpeechConsent: true, clearError: true);

    final text = data.speechText();
    if (text.isEmpty) return SpeakOutcome.empty;

    try {
      final tts = ref.read(deviceTtsProvider);
      final policy = ref.read(onboardingServiceProvider).getLanguagePolicy();
      final tag = resolveDeviceLanguageTag(languagePolicy: policy, text: text);
      if (tag != null && !await tts.canSpeak(tag)) {
        // Better the device default voice than silence.
        await tts.speak(text);
      } else {
        await tts.speak(text, languageTag: tag);
      }
      return SpeakOutcome.spoken;
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(error: 'Could not speak the notification.');
      }
      if (kDebugMode) debugPrint('[Notifications] speak failed: $error');
      return SpeakOutcome.empty;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  Future<void> _probe() async {
    final platform = ref.read(notificationAssistantPlatformProvider);
    final status = await platform.status();
    if (_disposed) return;

    if (state.settings.enabled && !status.accessGranted) {
      // The preference says on but the OS says no: correct the preference
      // rather than showing an enabled toggle that reads nothing.
      await _persist(
        state.settings.copyWith(enabled: false, readAloudEnabled: false),
        inbox: const <UntrustedNotificationData>[],
      );
      if (_disposed) return;
    }
    state = state.copyWith(status: status);
  }

  void _onEvent(NotificationAssistantEvent event) {
    if (_disposed) return;

    switch (event) {
      case NotificationAppSeen(:final packageName, :final label):
        _rememberApp(packageName, label);
      case NotificationCaptured(:final notification):
        _rememberApp(notification.packageName, notification.appLabel);
        final decision = NotificationFilter.evaluate(
          notification: notification,
          settings: state.settings,
        );
        switch (decision) {
          case NotificationAllowed(:final data):
            state = state.copyWith(
              inbox: <UntrustedNotificationData>[
                data,
                ...state.inbox,
              ].take(inboxLimit).toList(growable: false),
            );
            // §9.4: a high-priority notification is *spoken as it arrives*, not
            // only when the user opens this screen and taps a row. That manual
            // tap was the only call site, so the feature the brief calls
            // "proactive spoken updates" never happened on its own.
            //
            // Both gates §9.3/§9.5 require are still enforced, neither is
            // bypassed here: `readAloudEnabled` is the persisted opt-in and
            // `sessionSpeechConsent` is the non-persisted per-session
            // confirmation. Until the user has confirmed in this session,
            // `speak` returns `confirmationRequired`; rather than prompt
            // unprompted, nothing is spoken. `speak` re-runs the content guard
            // immediately before it speaks.
            if (NotificationFilter.isHighPriorityWork(notification) &&
                state.settings.readAloudEnabled &&
                state.sessionSpeechConsent) {
              unawaited(speak(data));
            }
          case NotificationDropped(:final reason):
            // Dropped, not stored. The log line names the app and the rule only
            // — never the title or the body, which are already unreachable from
            // here.
            if (kDebugMode) {
              debugPrint(
                '[Notifications] dropped ${notification.packageName} '
                '(${reason.name})',
              );
            }
        }
    }
  }

  /// Records an app as an allowlist candidate. Package name and label only.
  void _rememberApp(String packageName, String label) {
    if (packageName.isEmpty) return;
    if (state.settings.isPackageBlocked(packageName, appLabel: label)) return;

    final existing = state.discoveredApps.any(
      (DiscoveredApp app) => app.packageName == packageName,
    );
    if (existing) return;

    state = state.copyWith(
      discoveredApps: <DiscoveredApp>[
        DiscoveredApp(
          packageName: packageName,
          label: label.trim().isEmpty ? packageName : label.trim(),
        ),
        ...state.discoveredApps,
      ].take(discoveredLimit).toList(growable: false),
    );
  }

  Future<void> _persist(
    NotificationGuardSettings settings, {
    List<UntrustedNotificationData>? inbox,
    List<DiscoveredApp>? discoveredApps,
    bool? sessionSpeechConsent,
  }) async {
    await ref.read(notificationSettingsStoreProvider).write(settings);
    if (_disposed) return;
    state = state.copyWith(
      settings: settings,
      inbox: inbox,
      discoveredApps: discoveredApps,
      sessionSpeechConsent: sessionSpeechConsent,
      clearError: true,
    );
  }
}

final notificationAssistantProvider =
    NotifierProvider<NotificationAssistantController, NotificationAssistantState>(
      NotificationAssistantController.new,
    );
