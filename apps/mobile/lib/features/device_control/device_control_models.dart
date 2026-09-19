import 'package:flutter/foundation.dart';

// The outcome and request types live in `device_control_requests.dart` and are
// re-exported here, so a caller imports the device-control surface once. The two
// files import each other, which Dart allows for libraries; the split exists
// only to keep each file small.
export 'device_control_requests.dart';

/// Device & system control (§9.2) — the Dart-side models and the level registry.
///
/// ## The honest capability split
///
/// Every action here is something Android genuinely permits, or it is marked
/// [DeviceCapability.deepLinkOnly] / deliberately absent:
///
///  * opening apps, deep links and named Settings panels is functional;
///  * dialling is `ACTION_DIAL` — the number is shown and confirmed, and NOVA
///    never places the call;
///  * brightness and Do Not Disturb are functional *once the user grants the
///    special access* Android requires, and refuse with the grant screen
///    otherwise;
///  * media transport is functional against an active session;
///  * Wi-Fi and Bluetooth are **deep-link only** — Android 10 removed
///    programmatic Wi-Fi toggling and Android 12 neutered Bluetooth
///    `enable()`/`disable()` for third-party apps, so there is no toggle to call;
///  * SMS and screen reading are not actions at all (see
///    [DeviceControlStatus.excluded]).
///
/// ## One table, three languages
///
/// The wire names and levels below must match `DeviceControlCatalog.kt` and the
/// device-tool registry in `services/api/src/services/assistant-tools.ts`.
/// `device_control_levels_test.dart` pins this table, and a contract test reads
/// the Kotlin file to assert the two sides agree on every name.

/// A device action NOVA can perform. [wireName] is the cross-language id.
enum DeviceAction {
  openApp('open_app'),
  openDeepLink('open_deep_link'),
  openSettings('open_settings'),
  dialNumber('dial_number'),
  setBrightness('set_brightness'),
  setDnd('set_dnd'),
  mediaPlay('media_play'),
  mediaPause('media_pause'),
  mediaNext('media_next'),
  mediaPrevious('media_previous'),

  /// Meeting capture (§5.11). These two are **executed in Dart by the recorder,
  /// not by an Android intent** — `NovaDeviceControl.kt` refuses them with an
  /// honest "not an Android action" failure. They live in the same registry
  /// because the voice matcher, the level gate and the server tool registry all
  /// key off one vocabulary; the wire ids must agree across the three.
  startRecording('start_recording'),
  stopRecording('stop_recording');

  const DeviceAction(this.wireName);

  final String wireName;

  static DeviceAction? fromWire(String value) {
    for (final action in DeviceAction.values) {
      if (action.wireName == value) return action;
    }
    return null;
  }

  /// True for the four media transport actions.
  bool get isMedia =>
      this == mediaPlay ||
      this == mediaPause ||
      this == mediaNext ||
      this == mediaPrevious;

  /// True for the actions the in-app recorder performs itself.
  bool get isMeetingCapture =>
      this == startRecording || this == stopRecording;

  /// A short label for the control screen.
  String get label => switch (this) {
    openApp => 'Open an app',
    openDeepLink => 'Open a link',
    openSettings => 'Open a Settings screen',
    dialNumber => 'Open the dialer',
    setBrightness => 'Screen brightness',
    setDnd => 'Do Not Disturb',
    mediaPlay => 'Play',
    mediaPause => 'Pause',
    mediaNext => 'Next track',
    mediaPrevious => 'Previous track',
    startRecording => 'Start recording',
    stopRecording => 'Stop recording',
  };
}

/// A named Android Settings screen a deep link can open.
enum DeviceSettingsPanel {
  wifi('wifi'),
  bluetooth('bluetooth'),
  dndAccess('dnd_access'),
  writeSettings('write_settings'),
  notificationAccess('notification_access'),
  appDetails('app_details'),
  sound('sound');

  const DeviceSettingsPanel(this.wireName);

  final String wireName;

  static DeviceSettingsPanel? fromWire(String value) {
    for (final panel in DeviceSettingsPanel.values) {
      if (panel.wireName == value) return panel;
    }
    return null;
  }

  String get label => switch (this) {
    wifi => 'Wi-Fi settings',
    bluetooth => 'Bluetooth settings',
    dndAccess => 'Do Not Disturb access',
    writeSettings => 'Modify system settings',
    notificationAccess => 'Notification access',
    appDetails => 'NOVA app info',
    sound => 'Sound settings',
  };
}

/// How far an action gets on this platform.
enum DeviceCapability {
  /// NOVA performs it.
  functional('functional'),

  /// NOVA can only open the screen where the user changes it.
  deepLinkOnly('deep_link_only'),

  /// Deliberately not implemented (spec decision).
  excluded('excluded'),

  /// Android does not perform it at all: the app itself does, in Dart. Reported
  /// so a native "capability" is never claimed for something the OS was never
  /// asked to do (the meeting-recording actions are the only members today).
  dartExecuted('dart_executed');

  const DeviceCapability(this.wireName);

  final String wireName;

  static DeviceCapability fromWire(String value) {
    for (final capability in DeviceCapability.values) {
      if (capability.wireName == value) return capability;
    }
    return DeviceCapability.functional;
  }
}

/// The permission levels, identical to the API's `ToolPermissionLevel` (0–3).
class DeviceControlLevels {
  const DeviceControlLevels._();

  static const int readOnly = 0;
  static const int lowRiskWrite = 1;
  static const int external = 2;
  static const int sensitive = 3;

  /// The confirmation threshold, matching the API's beta default
  /// (`VOICE_TOOL_CONFIRM_LEVEL`, L1).
  static const int defaultConfirmLevel = lowRiskWrite;

  /// The single source of truth for each action's level.
  ///
  /// Deliberate choices, justified against §10.1:
  ///
  ///  * opening an app or a Settings panel is L1 — personal, low-risk, and
  ///    reversible; nothing changes by itself;
  ///  * an arbitrary deep link is L2 — it leaves NOVA for content it did not
  ///    choose, which is external communication;
  ///  * dialling is L2 — §9.2 calls for showing the number and confirming, and a
  ///    call reaches someone outside the user's account;
  ///  * brightness and Do Not Disturb are L3 — each changes a device-wide
  ///    setting (§10.1 "change account setting" → explicit confirm);
  ///  * media transport is L1 — local and instantly reversible;
  ///  * starting a meeting recording is L3 — it opens the microphone and records
  ///    people, which §9.5 pairs with an explicit consent flow;
  ///  * stopping one is L1 — the low-risk, reversible end of an action the user
  ///    already began.
  static const Map<DeviceAction, int> levels = <DeviceAction, int>{
    DeviceAction.openApp: lowRiskWrite,
    DeviceAction.openDeepLink: external,
    DeviceAction.openSettings: lowRiskWrite,
    DeviceAction.dialNumber: external,
    DeviceAction.setBrightness: sensitive,
    DeviceAction.setDnd: sensitive,
    DeviceAction.mediaPlay: lowRiskWrite,
    DeviceAction.mediaPause: lowRiskWrite,
    DeviceAction.mediaNext: lowRiskWrite,
    DeviceAction.mediaPrevious: lowRiskWrite,
    DeviceAction.startRecording: sensitive,
    DeviceAction.stopRecording: lowRiskWrite,
  };

  static int levelOf(DeviceAction action) {
    final level = levels[action];
    if (level == null) {
      // The untrusted-caller rule from the API registry: an unclassified action
      // is the most sensitive level, never read-only.
      return sensitive;
    }
    return level;
  }

  /// True when [action] may not run until the user confirms.
  ///
  /// The same arithmetic as the API's `toolRequiresConfirmation`, including the
  /// property that L0 is below every real threshold and can therefore never be
  /// made to prompt.
  static bool requiresConfirmation(
    DeviceAction action, {
    int threshold = defaultConfirmLevel,
  }) => levelOf(action) >= threshold;
}

/// One action's availability on this device, as reported by Android.
@immutable
class DeviceActionStatus {
  const DeviceActionStatus({
    required this.action,
    required this.level,
    required this.capability,
    required this.available,
    required this.granted,
    this.reason,
  });

  final DeviceAction action;
  final int level;
  final DeviceCapability capability;

  /// Whether this Android version can do it at all.
  final bool available;

  /// Whether the user has granted the special access it needs. Always true for
  /// actions that need none.
  final bool granted;

  /// Why it is unavailable or ungranted, in words meant to be shown.
  final String? reason;

  bool get isUsable => available && granted;

  factory DeviceActionStatus.fromMap(Map<dynamic, dynamic> map) {
    final action =
        DeviceAction.fromWire((map['action'] ?? '').toString().trim()) ??
        DeviceAction.openApp;
    return DeviceActionStatus(
      action: action,
      level:
          (map['level'] as num?)?.toInt() ??
          DeviceControlLevels.levelOf(action),
      capability: DeviceCapability.fromWire(
        (map['capability'] ?? 'functional').toString(),
      ),
      available: map['available'] != false,
      granted: map['granted'] != false,
      reason: map['reason']?.toString(),
    );
  }
}

/// One named Settings panel's availability.
@immutable
class DevicePanelStatus {
  const DevicePanelStatus({
    required this.panel,
    required this.capability,
    required this.available,
    this.reason,
  });

  final DeviceSettingsPanel panel;
  final DeviceCapability capability;
  final bool available;
  final String? reason;

  factory DevicePanelStatus.fromMap(Map<dynamic, dynamic> map) {
    final panel =
        DeviceSettingsPanel.fromWire((map['panel'] ?? '').toString().trim()) ??
        DeviceSettingsPanel.sound;
    return DevicePanelStatus(
      panel: panel,
      capability: DeviceCapability.fromWire(
        (map['capability'] ?? 'functional').toString(),
      ),
      available: map['available'] != false,
      reason: map['reason']?.toString(),
    );
  }
}

/// Something the spec deliberately does not implement.
@immutable
class DeviceExcludedCapability {
  const DeviceExcludedCapability({
    required this.id,
    required this.title,
    required this.reason,
  });

  final String id;
  final String title;
  final String reason;

  factory DeviceExcludedCapability.fromMap(Map<dynamic, dynamic> map) =>
      DeviceExcludedCapability(
        id: (map['id'] ?? '').toString(),
        title: (map['title'] ?? '').toString(),
        reason: (map['reason'] ?? '').toString(),
      );
}

/// What the whole device-control surface looks like right now.
@immutable
class DeviceControlStatus {
  const DeviceControlStatus({
    required this.supported,
    this.androidSdk,
    this.androidRelease,
    this.confirmLevel = DeviceControlLevels.defaultConfirmLevel,
    this.actions = const <DeviceActionStatus>[],
    this.panels = const <DevicePanelStatus>[],
    this.excluded = const <DeviceExcludedCapability>[],
    this.brightness,
    this.dndEnabled,
    this.detail,
  });

  final bool supported;
  final int? androidSdk;
  final String? androidRelease;
  final int confirmLevel;
  final List<DeviceActionStatus> actions;
  final List<DevicePanelStatus> panels;
  final List<DeviceExcludedCapability> excluded;

  /// System brightness 0–255, or null when it could not be read.
  final int? brightness;

  /// Whether Do Not Disturb is currently on, or null when it could not be read.
  final bool? dndEnabled;

  final String? detail;

  static const DeviceControlStatus unsupported = DeviceControlStatus(
    supported: false,
    detail: 'Device control is implemented for Android only.',
  );

  DeviceActionStatus? actionStatus(DeviceAction action) {
    for (final status in actions) {
      if (status.action == action) return status;
    }
    return null;
  }

  DevicePanelStatus? panelStatus(DeviceSettingsPanel panel) {
    for (final status in panels) {
      if (status.panel == panel) return status;
    }
    return null;
  }

  factory DeviceControlStatus.fromMap(Map<dynamic, dynamic> map) {
    final rawActions = map['actions'];
    final rawPanels = map['panels'];
    final rawExcluded = map['excluded'];
    return DeviceControlStatus(
      supported: map['supported'] != false,
      androidSdk: (map['androidSdk'] as num?)?.toInt(),
      androidRelease: map['androidRelease']?.toString(),
      confirmLevel:
          (map['confirmLevel'] as num?)?.toInt() ??
          DeviceControlLevels.defaultConfirmLevel,
      actions: rawActions is List
          ? rawActions
                .whereType<Map>()
                .map(DeviceActionStatus.fromMap)
                .toList(growable: false)
          : const <DeviceActionStatus>[],
      panels: rawPanels is List
          ? rawPanels
                .whereType<Map>()
                .map(DevicePanelStatus.fromMap)
                .toList(growable: false)
          : const <DevicePanelStatus>[],
      excluded: rawExcluded is List
          ? rawExcluded
                .whereType<Map>()
                .map(DeviceExcludedCapability.fromMap)
                .toList(growable: false)
          : const <DeviceExcludedCapability>[],
      brightness: (map['brightness'] as num?)?.toInt(),
      dndEnabled: map['dndEnabled'] is bool ? map['dndEnabled'] as bool : null,
    );
  }
}
