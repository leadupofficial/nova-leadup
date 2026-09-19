import 'package:flutter/foundation.dart';

import 'device_control_models.dart';

/// The outcome of one device action and the request that produced it.
///
/// Split from `device_control_models.dart` so each file stays small; both are
/// part of the same surface and are imported together by the platform seam, the
/// controller and the cards.

/// Why an action did or did not run. The wire values are frozen and match the
/// `CODE_*` constants in `NovaDeviceControl.kt`.
enum DeviceOutcomeCode {
  ok('ok'),
  unsupported('unsupported'),
  permissionDenied('permission_denied'),
  appNotFound('app_not_found'),
  noActiveSession('no_active_session'),
  invalidArgument('invalid_argument'),
  failed('failed'),

  /// Client-side: the action is at or above the confirmation threshold and the
  /// user has not confirmed. Nothing was sent to Android.
  confirmationRequired('confirmation_required'),

  /// Client-side: this platform has no native implementation.
  notSupported('not_supported');

  const DeviceOutcomeCode(this.wireName);

  final String wireName;

  static DeviceOutcomeCode fromWire(String value) {
    for (final code in DeviceOutcomeCode.values) {
      if (code.wireName == value) return code;
    }
    return DeviceOutcomeCode.failed;
  }

  /// True when the action genuinely happened.
  bool get succeeded => this == DeviceOutcomeCode.ok;
}

/// The result of one device action.
@immutable
class DeviceOutcome {
  const DeviceOutcome({
    required this.code,
    required this.message,
    this.grantPanel,
    this.extras = const <String, Object?>{},
  });

  final DeviceOutcomeCode code;

  /// Human-readable, honest wording — safe to show and to speak.
  final String message;

  /// When the failure was a missing special access, the screen that grants it.
  final DeviceSettingsPanel? grantPanel;

  final Map<String, Object?> extras;

  bool get ok => code.succeeded;
  bool get permissionDenied => code == DeviceOutcomeCode.permissionDenied;

  factory DeviceOutcome.fromMap(Map<dynamic, dynamic> map) {
    final extras = <String, Object?>{};
    for (final entry in map.entries) {
      extras[entry.key.toString()] = entry.value;
    }
    return DeviceOutcome(
      code: DeviceOutcomeCode.fromWire((map['code'] ?? 'failed').toString()),
      message: (map['message'] ?? 'The action did not run.').toString(),
      grantPanel: DeviceSettingsPanel.fromWire(
        (map['grantPanel'] ?? '').toString().trim(),
      ),
      extras: extras,
    );
  }

  static const DeviceOutcome notSupported = DeviceOutcome(
    code: DeviceOutcomeCode.notSupported,
    message: 'Device control is implemented for Android only.',
  );

  static const DeviceOutcome confirmationRequired = DeviceOutcome(
    code: DeviceOutcomeCode.confirmationRequired,
    message: 'This action needs your confirmation before it can run.',
  );
}

/// One concrete request to perform.
@immutable
class DeviceActionRequest {
  const DeviceActionRequest(
    this.action, {
    this.app,
    this.uri,
    this.panel,
    this.number,
    this.brightness,
    this.dndEnabled,
  });

  const DeviceActionRequest.openApp(String app)
    : this(DeviceAction.openApp, app: app);

  const DeviceActionRequest.openDeepLink(String uri)
    : this(DeviceAction.openDeepLink, uri: uri);

  const DeviceActionRequest.openPanel(DeviceSettingsPanel panel)
    : this(DeviceAction.openSettings, panel: panel);

  const DeviceActionRequest.dial(String number)
    : this(DeviceAction.dialNumber, number: number);

  const DeviceActionRequest.brightness(double value)
    : this(DeviceAction.setBrightness, brightness: value);

  const DeviceActionRequest.dnd(bool enabled)
    : this(DeviceAction.setDnd, dndEnabled: enabled);

  final DeviceAction action;
  final String? app;
  final String? uri;
  final DeviceSettingsPanel? panel;
  final String? number;

  /// 0.0–1.0. Always absolute by the time it reaches the platform.
  final double? brightness;
  final bool? dndEnabled;

  int get level => DeviceControlLevels.levelOf(action);

  bool requiresConfirmation({
    int threshold = DeviceControlLevels.defaultConfirmLevel,
  }) => DeviceControlLevels.requiresConfirmation(action, threshold: threshold);

  /// The method name on `nova/device_control`.
  ///
  /// [DeviceAction.startRecording] and [DeviceAction.stopRecording] are executed
  /// in Dart by the recorder; their method names exist only so that a mistaken
  /// call still reaches Kotlin's honest "not an Android action" refusal instead
  /// of looking like a missing case.
  String get method => switch (action) {
    DeviceAction.openApp => 'openApp',
    DeviceAction.openDeepLink => 'openDeepLink',
    DeviceAction.openSettings => 'openSettings',
    DeviceAction.dialNumber => 'dial',
    DeviceAction.setBrightness => 'setBrightness',
    DeviceAction.setDnd => 'setDnd',
    DeviceAction.mediaPlay ||
    DeviceAction.mediaPause ||
    DeviceAction.mediaNext ||
    DeviceAction.mediaPrevious => 'media',
    DeviceAction.startRecording => 'startRecording',
    DeviceAction.stopRecording => 'stopRecording',
  };

  /// The arguments map, with the exact keys the Kotlin handler reads.
  Map<String, Object?> get platformArguments => switch (action) {
    DeviceAction.openApp => <String, Object?>{'app': app ?? ''},
    DeviceAction.openDeepLink => <String, Object?>{'uri': uri ?? ''},
    DeviceAction.openSettings => <String, Object?>{
      'panel': (panel ?? DeviceSettingsPanel.sound).wireName,
    },
    DeviceAction.dialNumber => <String, Object?>{'number': number ?? ''},
    DeviceAction.setBrightness => <String, Object?>{'value': brightness ?? 0.0},
    DeviceAction.setDnd => <String, Object?>{'enabled': dndEnabled ?? false},
    DeviceAction.mediaPlay ||
    DeviceAction.mediaPause ||
    DeviceAction.mediaNext ||
    DeviceAction.mediaPrevious => <String, Object?>{'action': action.wireName},
    // Nothing is sent to Android for the two capture actions.
    DeviceAction.startRecording ||
    DeviceAction.stopRecording => const <String, Object?>{},
  };

  /// A sentence describing exactly what will happen, for the confirmation sheet.
  String get confirmationSummary => switch (action) {
    DeviceAction.openApp => 'Open ${app ?? "the app"}.',
    DeviceAction.openDeepLink =>
      'Open the link ${uri ?? ""} outside NOVA. The page it opens is not one NOVA chose.',
    DeviceAction.openSettings =>
      'Open the ${(panel ?? DeviceSettingsPanel.sound).label} screen. NOVA will not change the setting.',
    DeviceAction.dialNumber =>
      'Open the dialer with ${number ?? "that number"}. NOVA does not place the call — you press call.',
    DeviceAction.setBrightness =>
      'Change the screen brightness to ${((brightness ?? 0) * 100).round()}%.',
    DeviceAction.setDnd =>
      'Turn Do Not Disturb ${(dndEnabled ?? false) ? "on" : "off"} for the whole device.',
    DeviceAction.mediaPlay => 'Send play to the active media session.',
    DeviceAction.mediaPause => 'Send pause to the active media session.',
    DeviceAction.mediaNext => 'Skip to the next track.',
    DeviceAction.mediaPrevious => 'Go back to the previous track.',
    DeviceAction.startRecording =>
      'Open the microphone and start recording this meeting. Everyone present '
          'must know they are being recorded.',
    DeviceAction.stopRecording =>
      'Stop the current recording, save it and send it for transcription.',
  };

  @override
  bool operator ==(Object other) =>
      other is DeviceActionRequest &&
      other.action == action &&
      other.app == app &&
      other.uri == uri &&
      other.panel == panel &&
      other.number == number &&
      other.brightness == brightness &&
      other.dndEnabled == dndEnabled;

  @override
  int get hashCode =>
      Object.hash(action, app, uri, panel, number, brightness, dndEnabled);

  @override
  String toString() => 'DeviceActionRequest(${action.wireName})';
}
