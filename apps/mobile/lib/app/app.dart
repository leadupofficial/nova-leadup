import 'dart:async';
import '../features/briefing/briefing_controller.dart';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'error_apps.dart';

import '../core/api/device_registration.dart';
import '../core/api/providers.dart';
import '../core/config/remote_config_provider.dart';
import '../core/config/remote_control_gate.dart';
import '../core/theme/nova_theme.dart';
import '../core/voice/voice_protocol.dart';
import '../core/voice/voice_realtime_controller.dart';
import '../core/voice/wake_word_controller.dart';
import '../core/voice/wake_word_service.dart';
import '../core/voice/wake_word_session.dart';
import '../features/auth/auth_controller.dart';
import '../features/notifications/notification_controller.dart';
import '../features/onboarding/pending_persona_flush.dart';
import '../features/reminders/reminder_sync.dart';
import '../services/analytics_service.dart';
import 'providers.dart';
import 'router.dart';
import '../features/notifications/push_messaging.dart';
import '../features/reminders/reminder_notifications.dart';

/// Root widget. Owns the router, the theme and the app-lifecycle hooks.
class NovaApp extends ConsumerStatefulWidget {
  const NovaApp({super.key});

  @override
  ConsumerState<NovaApp> createState() => _NovaAppState();
}

class _NovaAppState extends ConsumerState<NovaApp> {
  late final AppLifecycleListener _lifecycleListener;

  /// False while the app is not the visible foreground app.
  ///
  /// A wake-word detection arrives from a foreground service that keeps running while
  /// NOVA is backgrounded. Opening the microphone from here in that state would be a
  /// surprise, so a detection only opens a conversation while the app is on screen.
  bool _foreground = true;

  /// The `at` of the last detection this widget acted on, so one detection opens one
  /// conversation even though the controller republishes state for other reasons.
  DateTime? _handledDetectionAt;

  /// Connectivity changes drive the `/offline` route.
  StreamSubscription<bool>? _connectivity;

  @override
  void initState() {
    super.initState();
    _lifecycleListener = AppLifecycleListener(
      onResume: _onResume,
      onPause: _onPause,
      onInactive: _onPause,
      onDetach: _onDetach,
    );

    // Fetch operator configuration once, after the first frame.
    //
    // Deferred with `addPostFrameCallback` rather than called here so remote
    // configuration can never be on the critical path to the first painted frame —
    // the exact failure `startup.dart` was written to eliminate. The provider starts
    // from a permissive placeholder, so the app is fully usable while this is in
    // flight; it is what delivers maintenance mode, kill switches, feature flags and
    // the version gate.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(ref.read(remoteConfigProvider.notifier).refresh(force: true));
      // Report this install so the operator's device and app-version views are populated.
      // `devices` had no writer at all before this, which is why those console tables were
      // empty. Fire-and-forget by design: registration is telemetry, and a device that cannot
      // report itself must still be able to use NOVA.
      unawaited(ref.read(deviceRegistrationProvider)());
      // A push that arrives while this app is open is handed to `onMessage` and
      // posted by nobody: Android only draws its own notification when the app is
      // in the background. Measured on the OnePlus 9R — FCM accepted the send, the
      // shade stayed empty with NOVA in the foreground, and the same message
      // appeared the moment the app was backgrounded.
      PushForegroundHandler(
        ref.read(reminderNotificationsProvider),
        onPush: () {
          ref.invalidate(notificationsProvider);
          ref.invalidate(unreadNotificationCountProvider);
        },
      ).start();
    });
    // **`listenManual`, not `read`.** These notifiers are built once for the app
    // lifetime and their `build` watches the auth state, so they have to be *rebuilt*
    // when it changes. `ref.read(x.notifier)` does not do that: it constructs the
    // notifier and returns, creating no subscription, and in Riverpod 3 an element
    // without listeners is not eagerly rebuilt when a dependency changes — it is only
    // recomputed on the next read. So each of these saw the *first* auth state it
    // happened to be built in and nothing afterwards.
    //
    // The visible consequences were concrete. A persona chosen during onboarding runs
    // before sign-in, so the flush never fired at sign-in — it was deferred by a whole
    // restart. And `ref.invalidate(reminderSyncProvider)` from the notifications sheet
    // did not re-run reconciliation, so switching reminders off did not cancel the
    // alarms already armed.
    //
    // The listeners are empty on purpose: the subscription is the point, not the
    // callback.
    ref.listenManual(reminderSyncProvider, (_, _) {});
    ref.listenManual(notificationAssistantProvider, (_, _) {});
    ref.listenManual(pendingPersonaFlushProvider, (_, _) {});
    // The daily briefing for the same reason, and it had the same defect. Its reconciler
    // is reached only through `DailyBriefingController.build`, which ran when the Daily
    // briefing *screen* was opened — so invalidating it from the notifications sheet did
    // nothing (no listener, no rebuild) and, worse, the briefing was only ever armed by
    // visiting that screen. Subscribing here both makes the sheet's invalidation
    // effective and arms the briefing at startup, which is what "daily briefing" implies.
    ref.listenManual(dailyBriefingProvider, (_, _) {});

    // Report this install when a session appears, not only at launch.
    //
    // The post-frame attempt below runs before the stored session has finished loading from
    // secure storage, so it can read no token and return `reported: false, error: 'no session'`
    // — correctly silent, because registration is telemetry. The consequence was measured on an
    // emulator: the device appeared in the operator's inventory only after the app had been
    // backgrounded and resumed once, so a user who launches NOVA and leaves it in the foreground
    // was never counted at all.
    //
    // `fireImmediately` covers the other half of the race — a cold start whose session *has*
    // already been restored by the time this runs — which would otherwise still depend on the
    // post-frame attempt winning. Registering twice is harmless: the endpoint upserts on
    // `installationId`, so the second call updates the same row rather than creating another.
    ref.listenManual(
      authStateProvider.select((state) => state.isAuthenticated),
      (previous, next) {
        if (next && previous != true) {
          unawaited(ref.read(deviceRegistrationProvider)());
        }
      },
      fireImmediately: true,
    );

    // The router has always declared `/offline` as a surface "reachable under every
    // gate", the page has existed for as long as it has, and nothing ever navigated
    // there — so losing connectivity showed the ordinary screens with "Not reachable"
    // cards instead of the screen written to explain exactly that.
    _connectivity = ref
        .read(networkInfoServiceProvider)
        .onConnectivityChanged
        .listen(_onConnectivityChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkConnectivityOnce());
  }

  @override
  void dispose() {
    _connectivity?.cancel();
    _lifecycleListener.dispose();
    super.dispose();
  }

  /// Covers a cold start that is already offline, which the stream alone would miss.
  Future<void> _checkConnectivityOnce() async {
    try {
      final connected = await ref.read(networkInfoServiceProvider).isConnected;
      if (!mounted) return;
      _onConnectivityChanged(connected);
    } catch (_) {
      // A probe that fails tells us nothing; leave routing to the app's own screens.
    }
  }

  /// Shows the offline screen while disconnected and leaves it once connectivity is
  /// back. The router's gates decide where "back" is, so this never has to know whether
  /// the user was onboarding or signed in.
  void _onConnectivityChanged(bool connected) {
    if (!mounted) return;
    final router = ref.read(routerProvider);
    final location = router.routerDelegate.currentConfiguration.uri.path;
    if (!connected) {
      if (location != '/offline') router.go('/offline');
    } else if (location == '/offline') {
      router.go('/');
    }
  }

  /// Re-arms wake word listening when the app comes back to the foreground.
  ///
  /// This is the reliable re-arm point: the Android foreground service can be killed
  /// under memory pressure, and Android 15+ does not permit restarting a
  /// `microphone`-type foreground service from a `BOOT_COMPLETED` receiver.
  void _onResume() {
    _foreground = true;
    // Re-read operator configuration on every resume.
    //
    // There is no push channel (the app has no FCM integration), so polling at resume
    // is how a maintenance window, a kill switch or a new flag value reaches a device
    // that was backgrounded while an operator changed it. `refresh()` joins an
    // in-flight request, so this cannot pile up.
    unawaited(ref.read(remoteConfigProvider.notifier).refresh());
    // Re-report on resume: the app version cannot change while running, but the session can
    // change hands, and a shared device must be re-bound to its current account.
    unawaited(ref.read(deviceRegistrationProvider)());
    ref.read(wakeWordStateProvider.notifier).arm();
    // Reminders may have changed on another device, and the OS may have dropped
    // alarms while the process was dead. Re-reconciling here is cheap.
    unawaited(ref.read(reminderSyncProvider.notifier).sync());
    // Notification Access can be revoked from Android Settings while NOVA is
    // backgrounded, and nothing tells the app. Re-checking on resume is what
    // makes "instantly disableable" true for a revocation the user made
    // outside the app.
    unawaited(ref.read(notificationAssistantProvider.notifier).refreshStatus());
  }

  void _onPause() {
    _foreground = false;
  }

  void _onDetach() {
    // Best-effort; the platform may kill the process before this completes.
    ref.read(analyticsServiceProvider).logEvent(AnalyticsService.eventAppOpen);
  }

  /// Opens a conversation when the wake word fires.
  ///
  /// This is the listener that never existed. `WakeWordService.kt` emits the
  /// detection, `WakeWordController` turns the orb to "listening", and its own comment
  /// said *"the conversation flow is started by whatever listens to `lastDetection`"* —
  /// nothing did, so saying the wake word produced an animation and no session. The
  /// decision itself lives in [shouldOpenSessionFromWakeWord] so it can be tested
  /// without a socket or a device.
  void _onWakeWordEvent(WakeWordEvent? event) {
    if (event is! WakeWordDetected) return;
    if (!shouldOpenSessionFromWakeWord(
      appInForeground: _foreground,
      turnActive: ref.read(voiceRealtimeProvider).isTurnActive,
      detectionAt: event.at,
      lastHandledAt: _handledDetectionAt,
    )) {
      return;
    }
    _handledDetectionAt = event.at;

    // Bring the conversation on screen before the turn begins, so the user sees the
    // transcript they are about to speak into.
    ref.read(routerProvider).go(wakeWordConverseRoute);

    unawaited(
      ref.read(voiceRealtimeProvider.notifier).startTurn(
            language: normalizeVoiceLanguage(
              ref.read(personaProvider).asData?.value.languagePolicy,
            ),
          ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Wake word → conversation. `listen` (rather than reading the state) fires only
    // when the detection actually changes, and it is safe here because the wake word
    // controller is built for the app's lifetime in `initState` by the settings and
    // home screens.
    ref.listen<WakeWordState>(wakeWordStateProvider, (previous, next) {
      _onWakeWordEvent(next.lastDetection);
    });

    return MaterialApp.router(
      title: 'NOVA',
      debugShowCheckedModeBanner: false,
      theme: NovaTheme.darkTheme,
      routerConfig: ref.watch(routerProvider),
      // Clamp accessibility text scaling so the layouts stay usable at very large
      // system font sizes instead of overflowing. A render exception inside any
      // routed page is caught by ErrorBoundary so the user sees a retry screen
      // rather than a blank red error screen.
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        maxScaleFactor: 1.3,
        child: ErrorBoundary(
          // Operator control gate inside the error boundary: a maintenance notice or a
          // required-update screen must render even if a routed page throws, and the
          // gate must be able to cover every route rather than being one itself.
          child: RemoteControlGate(
            child: child ?? const SizedBox.shrink(),
          ),
        ),
      ),
    );
  }
}
