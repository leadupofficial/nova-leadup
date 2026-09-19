import 'package:nova_mobile/features/device_control/device_control_models.dart';
import 'package:nova_mobile/features/device_control/device_control_platform.dart';

/// A scriptable [DeviceControlPlatform] for controller and widget tests.
///
/// Records every invocation, so a test can assert that a refused action was
/// *never sent to Android* — which is the difference between "it did not run"
/// and "it ran and failed".
class FakeDeviceControlPlatform implements DeviceControlPlatform {
  FakeDeviceControlPlatform({DeviceControlStatus? status})
    : _status = status ?? fakeDeviceControlStatus();

  DeviceControlStatus _status;

  /// Every request that actually reached the platform, in order.
  final List<DeviceActionRequest> invocations = <DeviceActionRequest>[];

  /// Per-action scripted replies. Anything not listed gets [fallback].
  final Map<DeviceAction, DeviceOutcome> responses = <DeviceAction, DeviceOutcome>{};

  DeviceOutcome fallback = const DeviceOutcome(
    code: DeviceOutcomeCode.ok,
    message: 'Done.',
  );

  int statusCalls = 0;
  bool disposed = false;

  void setStatus(DeviceControlStatus value) => _status = value;
  DeviceControlStatus get statusValue => _status;

  void reply(DeviceAction action, DeviceOutcome outcome) =>
      responses[action] = outcome;

  @override
  Future<DeviceControlStatus> status() async {
    statusCalls++;
    return _status;
  }

  @override
  Future<DeviceOutcome> invoke(DeviceActionRequest request) async {
    invocations.add(request);
    return responses[request.action] ?? fallback;
  }

  @override
  Future<void> dispose() async {
    disposed = true;
  }
}

/// A realistic status map for a modern Android with both special accesses held.
DeviceControlStatus fakeDeviceControlStatus({
  bool supported = true,
  int confirmLevel = DeviceControlLevels.defaultConfirmLevel,
  bool brightnessGranted = true,
  bool dndGranted = true,
  bool openAppAvailable = true,
  int? brightness = 128,
  bool? dndEnabled = false,
  DeviceCapability wifiCapability = DeviceCapability.deepLinkOnly,
  DeviceCapability bluetoothCapability = DeviceCapability.deepLinkOnly,
  String? brightnessReason,
  String? dndReason,
}) {
  final actions = <DeviceActionStatus>[
    for (final action in DeviceAction.values)
      DeviceActionStatus(
        action: action,
        level: DeviceControlLevels.levelOf(action),
        capability: DeviceCapability.functional,
        available: action == DeviceAction.openApp ? openAppAvailable : true,
        granted: switch (action) {
          DeviceAction.setBrightness => brightnessGranted,
          DeviceAction.setDnd => dndGranted,
          _ => true,
        },
        reason: switch (action) {
          DeviceAction.setBrightness when !brightnessGranted =>
            brightnessReason ??
                'Android requires the special "Modify system settings" access.',
          DeviceAction.setDnd when !dndGranted =>
            dndReason ?? 'Android requires "Do Not Disturb access".',
          DeviceAction.openApp when !openAppAvailable =>
            'This Android version cannot open apps.',
          _ => null,
        },
      ),
  ];

  final panels = <DevicePanelStatus>[
    for (final panel in DeviceSettingsPanel.values)
      DevicePanelStatus(
        panel: panel,
        capability: switch (panel) {
          DeviceSettingsPanel.wifi => wifiCapability,
          DeviceSettingsPanel.bluetooth => bluetoothCapability,
          _ => DeviceCapability.functional,
        },
        available: true,
        reason: switch (panel) {
          DeviceSettingsPanel.wifi
              when wifiCapability == DeviceCapability.deepLinkOnly =>
            'Android 10 removed programmatic Wi-Fi toggling for third-party apps, '
                'so NOVA opens the Wi-Fi screen and you flip the switch.',
          DeviceSettingsPanel.bluetooth
              when bluetoothCapability == DeviceCapability.deepLinkOnly =>
            'Android 12 made Bluetooth enable()/disable() no-ops for third-party '
                'apps, so NOVA opens the Bluetooth screen and you flip the switch.',
          _ => null,
        },
      ),
  ];

  return DeviceControlStatus(
    supported: supported,
    androidSdk: 36,
    androidRelease: '16',
    confirmLevel: confirmLevel,
    actions: actions,
    panels: panels,
    excluded: const <DeviceExcludedCapability>[
      DeviceExcludedCapability(
        id: 'send_sms',
        title: 'Send SMS',
        reason: 'Deferred by the product brief §9.2.',
      ),
      DeviceExcludedCapability(
        id: 'read_screen',
        title: 'Read the screen or control other apps',
        reason: 'Excluded from the consumer MVP by §9.2.',
      ),
    ],
    brightness: brightness,
    dndEnabled: dndEnabled,
  );
}
