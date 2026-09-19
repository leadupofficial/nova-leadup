import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'device_control_models.dart';
import 'device_control_platform.dart';
import 'device_control_voice_commands.dart';
import '../recording/recording_controller.dart';

/// Native transport for device & system control.
///
/// Only Android has an implementation (`NovaDeviceControl.kt`). Elsewhere the
/// app gets [UnsupportedDeviceControlPlatform], which reports `supported: false`
/// so the screen explains the situation instead of offering controls that could
/// never work. Override in tests with a fake.
final deviceControlPlatformProvider = Provider<DeviceControlPlatform>((ref) {
  final platform = defaultTargetPlatform == TargetPlatform.android
      ? MethodChannelDeviceControlPlatform()
      : const UnsupportedDeviceControlPlatform();
  ref.onDispose(platform.dispose);
  return platform;
});

/// What the device-control screen renders.
@immutable
class DeviceControlState {
  const DeviceControlState({
    this.status,
    this.busy = false,
    this.error,
    this.lastOutcome,
  });

  final DeviceControlStatus? status;
  final bool busy;
  final String? error;

  /// The most recent result, so the screen can show exactly what happened —
  /// including "it did not run".
  final DeviceOutcome? lastOutcome;

  bool get isSupported => status?.supported ?? false;

  DeviceControlState copyWith({
    DeviceControlStatus? status,
    bool? busy,
    String? error,
    DeviceOutcome? lastOutcome,
    bool clearError = false,
  }) {
    return DeviceControlState(
      status: status ?? this.status,
      busy: busy ?? this.busy,
      error: clearError ? null : (error ?? this.error),
      lastOutcome: lastOutcome ?? this.lastOutcome,
    );
  }
}

/// Bridges the Android device-control surface to the UI and to a voice command.
///
/// The same entry point — [perform] — is used by the screen's buttons and by
/// [runVoiceCommand], so an action cannot be gated one way from the UI and
/// another way from speech. The gate itself lives here and mirrors the API's
/// `toolRequiresConfirmation`: an action at or above the configured level does
/// not reach Android until [perform] is called with `confirmed: true`.
class DeviceControlController extends Notifier<DeviceControlState> {
  /// The level at or above which a *screen tap* raises the confirmation sheet.
  ///
  /// The API's gate treats L1 as configurable ("confirm during beta") and L2/L3
  /// as always-confirm. On the screen a tap on a labelled L1 control — "Open
  /// Wi-Fi settings" — is itself the explicit user action, so prompting again
  /// would be noise; L2 (a link leaving the app, a call) and L3 (a device-wide
  /// setting) always get the sheet. Speech has no such shortcut: [runVoiceCommand]
  /// never pre-confirms anything.
  static const int uiConfirmLevel = DeviceControlLevels.external;

  bool _disposed = false;

  @override
  DeviceControlState build() {
    ref.onDispose(() {
      _disposed = true;
    });
    // Probe the capabilities. Scheduled rather than awaited so `build()` stays
    // synchronous, and it must not touch `state` before `build()` returns.
    unawaited(_probe());
    return const DeviceControlState();
  }

  /// The first capability read, from `build()`.
  ///
  /// Awaits before writing state: `build()` has not returned yet, so touching
  /// `state` here would be reading an uninitialised provider.
  Future<void> _probe() async {
    final status = await ref.read(deviceControlPlatformProvider).status();
    if (_disposed) return;
    state = state.copyWith(status: status, busy: false);
  }

  /// Re-reads what this device and this grant state allow.
  Future<void> refreshStatus() async {
    state = state.copyWith(busy: true, clearError: true);
    final status = await ref.read(deviceControlPlatformProvider).status();
    if (_disposed) return;
    state = state.copyWith(status: status, busy: false);
  }

  /// True when a screen tap on [request] must raise the confirmation sheet.
  ///
  /// Deliberately independent of [DeviceControlState.status] so the UI never
  /// silently downgrades a sensitive action while the status probe is in flight.
  bool needsConfirmationSheet(DeviceActionRequest request) =>
      request.level >= uiConfirmLevel;

  /// Performs one action through the platform.
  ///
  /// Refuses before touching Android when the action is unavailable, when its
  /// special access is not granted, or when it needs a confirmation that has
  /// not been given. In each case the returned outcome names the reason and
  /// nothing was invoked.
  Future<DeviceOutcome> perform(
    DeviceActionRequest request, {
    bool confirmed = false,
  }) async {
    final status = state.status;

    if (status != null && !status.supported) {
      return _record(DeviceOutcome.notSupported);
    }

    final actionStatus = status?.actionStatus(request.action);
    if (actionStatus != null) {
      if (!actionStatus.available) {
        return _record(
          DeviceOutcome(
            code: DeviceOutcomeCode.unsupported,
            message:
                actionStatus.reason ??
                'This Android version cannot ${request.action.label.toLowerCase()}.',
          ),
        );
      }
      if (!actionStatus.granted) {
        return _record(
          DeviceOutcome(
            code: DeviceOutcomeCode.permissionDenied,
            message:
                actionStatus.reason ??
                'NOVA does not have the access this needs yet.',
            grantPanel: _grantPanelFor(request.action),
          ),
        );
      }
    }

    final threshold =
        status?.confirmLevel ?? DeviceControlLevels.defaultConfirmLevel;
    if (request.requiresConfirmation(threshold: threshold) && !confirmed) {
      // Nothing is sent to Android. The caller must confirm and call again.
      return DeviceOutcome.confirmationRequired;
    }

    state = state.copyWith(busy: true, clearError: true);
    final outcome = await ref
        .read(deviceControlPlatformProvider)
        .invoke(request);
    if (_disposed) return outcome;

    state = state.copyWith(busy: false, lastOutcome: outcome, clearError: true);

    // A state-changing action leaves the reported brightness/DND stale; re-read
    // so the screen does not show the old value next to a "done" notice.
    if (outcome.ok &&
        (request.action == DeviceAction.setDnd ||
            request.action == DeviceAction.setBrightness)) {
      unawaited(refreshStatus());
    }
    return outcome;
  }

  /// Runs one of the screen's own controls.
  ///
  /// A tap on a labelled control is the user's explicit action, so L1 runs
  /// immediately; [needsConfirmationSheet] tells the screen when to raise the
  /// sheet first, after which it calls this with `confirmed: true`.
  Future<DeviceOutcome> performFromUi(
    DeviceActionRequest request, {
    bool confirmed = false,
  }) => perform(request, confirmed: confirmed);

  /// Opens the Settings screen that grants a special access.
  Future<DeviceOutcome> openGrantSettings(DeviceAction action) {
    final panel = _grantPanelFor(action);
    if (panel == null) {
      return Future<DeviceOutcome>.value(
        const DeviceOutcome(
          code: DeviceOutcomeCode.unsupported,
          message: 'That action needs no special access.',
        ),
      );
    }
    // Opening a settings panel is L1 and the tap is the confirmation.
    return perform(DeviceActionRequest.openPanel(panel), confirmed: true);
  }

  /// Maps a spoken request onto an action and runs it through the same gate.
  ///
  /// Returns null when nothing in [transcript] matched the device vocabulary —
  /// the caller decides how to say "I did not catch a device command", rather
  /// than this class inventing an action.
  Future<DeviceOutcome?> runVoiceCommand(
    String transcript, {
    bool confirmed = false,
  }) async {
    final command = matchDeviceVoiceCommand(transcript);
    if (command == null) return null;
    return runMatchedCommand(command, confirmed: confirmed);
  }

  /// Runs a command that has already been matched, through the same gate.
  Future<DeviceOutcome?> runMatchedCommand(
    DeviceVoiceCommand command, {
    bool confirmed = false,
  }) async {
    // The two meeting-capture actions are executed by the recorder in Dart, not
    // by an Android intent, so they never reach `perform`/the platform channel.
    final capture = await _runMeetingCapture(command, confirmed: confirmed);
    if (capture != null) return capture;

    var request = command.resolve(state.status);
    if (request == null && command.needsCurrentState) {
      // A relative brightness or a DND toggle needs the current value. Read it
      // rather than guessing, then resolve once more.
      await refreshStatus();
      request = command.resolve(state.status);
    }
    if (request == null) {
      return _record(
        const DeviceOutcome(
          code: DeviceOutcomeCode.invalidArgument,
          message: 'NOVA could not read the current state that command needs, so nothing was changed.',
        ),
      );
    }

    final outcome = await perform(request, confirmed: confirmed);
    if (_disposed) return outcome;

    // For a deep-link-only request the honest note is the whole point: the user
    // asked to toggle something NOVA cannot toggle. Never let the platform's
    // "opened the screen" line stand alone.
    if (command.deepLinkOnly && outcome.ok && command.honestNote != null) {
      return _record(
        DeviceOutcome(
          code: DeviceOutcomeCode.ok,
          message: command.honestNote!,
          extras: outcome.extras,
        ),
      );
    }
    return outcome;
  }

  void clearError() {
    if (state.error == null) return;
    state = state.copyWith(clearError: true);
  }

  /// Runs a matched meeting-capture command through the in-app recorder.
  ///
  /// Returns null when [command] is not a capture action, so the normal device
  /// path continues. `start_recording` is L3 and never runs without [confirmed];
  /// the confirmation sheet shows the §9.5 consent wording ("Everyone present
  /// must know they are being recorded"), so a confirmed start also records the
  /// consent acknowledgement for that session. Nothing is faked: the message
  /// returned is the recorder's own outcome.
  Future<DeviceOutcome?> _runMeetingCapture(
    DeviceVoiceCommand command, {
    required bool confirmed,
  }) async {
    final action = command.action;
    if (!action.isMeetingCapture) return null;

    // Both actions are at or above the L1 confirmation threshold, and speech
    // never pre-confirms: nothing runs until the caller has shown the sheet.
    if (!confirmed) {
      return _record(DeviceOutcome.confirmationRequired);
    }

    final recorder = ref.read(recordingControllerProvider.notifier);
    final result = action == DeviceAction.startRecording
        ? await recorder.startFromVoice(consentAcknowledged: true)
        : await recorder.stopFromVoice();

    return _record(
      DeviceOutcome(
        code: result.ok ? DeviceOutcomeCode.ok : DeviceOutcomeCode.failed,
        message: result.message,
        extras: <String, Object?>{
          if (result.route != null) 'route': result.route,
        },
      ),
    );
  }

  DeviceOutcome _record(DeviceOutcome outcome) {
    if (!_disposed) {
      state = state.copyWith(lastOutcome: outcome, busy: false);
    }
    return outcome;
  }

  static DeviceSettingsPanel? _grantPanelFor(DeviceAction action) =>
      switch (action) {
        DeviceAction.setBrightness => DeviceSettingsPanel.writeSettings,
        DeviceAction.setDnd => DeviceSettingsPanel.dndAccess,
        _ => null,
      };
}

final deviceControlProvider =
    NotifierProvider<DeviceControlController, DeviceControlState>(
      DeviceControlController.new,
    );
