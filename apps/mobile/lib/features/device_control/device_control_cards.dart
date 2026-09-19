import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';
import 'device_control_models.dart';
import 'device_control_sections.dart';

/// The control cards of the device-control screen.
///
/// Split out of [DeviceControlPage] so the page is wiring and this file is
/// presentation. Nothing here decides whether an action may run: each card
/// reports one of its callbacks and the controller's gate decides. The status
/// objects render the honest reasons an action is impossible, ungranted, or
/// deep-link only.
///
/// These are deliberately dumb widgets — `status` and the callbacks in, widgets
/// out — so the page can be read top to bottom as "what exists" and the tests
/// can pump any single card without a controller.

/// Open an app by name/package, or a URL.
class DeviceOpenAppCard extends StatelessWidget {
  const DeviceOpenAppCard({
    super.key,
    required this.status,
    required this.controller,
    required this.onOpen,
  });

  final DeviceControlStatus? status;
  final TextEditingController controller;

  /// Receives the trimmed text; the page decides app-vs-link.
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    final actionStatus = status?.actionStatus(DeviceAction.openApp);
    return _InputCard(
      title: 'Open an app or link',
      subtitle:
          'Type an app name (WhatsApp, Spotify, Maps…) or a package name, or '
          'paste an https link. Opening a link leaves NOVA for a page it did '
          'not choose.',
      icon: Icons.open_in_new_rounded,
      level: DeviceControlLevels.levelOf(DeviceAction.openApp),
      granted: actionStatus?.granted ?? true,
      reason: actionStatus?.reason,
      controller: controller,
      hint: 'WhatsApp, com.spotify.music, https://…',
      buttonLabel: 'Open',
      onSubmit: () => onOpen(controller.text.trim()),
    );
  }
}

/// Open the dialer with a number. Never places the call.
class DeviceDialCard extends StatelessWidget {
  const DeviceDialCard({
    super.key,
    required this.status,
    required this.controller,
    required this.onDial,
  });

  final DeviceControlStatus? status;
  final TextEditingController controller;
  final ValueChanged<String> onDial;

  @override
  Widget build(BuildContext context) {
    return _InputCard(
      title: 'Call a number',
      subtitle:
          'NOVA opens the dialer with the number filled in and does not place '
          'the call — you press call. Only a number you type is used; NOVA has '
          'no contacts access and will not guess a name.',
      icon: Icons.call_outlined,
      level: DeviceControlLevels.levelOf(DeviceAction.dialNumber),
      granted: status?.actionStatus(DeviceAction.dialNumber)?.granted ?? true,
      controller: controller,
      hint: '+91 98765 43210',
      keyboardType: TextInputType.phone,
      buttonLabel: 'Open dialer',
      onSubmit: () => onDial(controller.text.trim()),
    );
  }
}

/// Play / pause / previous / next against the active media session.
class DeviceMediaCard extends StatelessWidget {
  const DeviceMediaCard({
    super.key,
    required this.status,
    required this.onAction,
  });

  final DeviceControlStatus? status;
  final ValueChanged<DeviceAction> onAction;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final granted =
        status?.actionStatus(DeviceAction.mediaPause)?.granted ?? true;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Media playback', style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: NovaSpace.xxs),
          DeviceActionMarkers(
            level: DeviceControlLevels.levelOf(DeviceAction.mediaPause),
            capability: DeviceCapability.functional,
            granted: granted,
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'Sends transport keys to whichever app is playing. If Android '
            'reports no active session, NOVA says so and sends nothing rather '
            'than pretending a key worked.',
            style: Theme.of(context).textTheme.bodySmall!
                .copyWith(color: c.muted),
          ),
          const SizedBox(height: NovaSpace.sm),
          DeviceButtonRow(
            children: [
              NovaSecondaryButton(
                label: 'Previous',
                icon: Icons.skip_previous_rounded,
                onPressed: () => onAction(DeviceAction.mediaPrevious),
              ),
              NovaSecondaryButton(
                label: 'Play',
                icon: Icons.play_arrow_rounded,
                onPressed: () => onAction(DeviceAction.mediaPlay),
              ),
              NovaSecondaryButton(
                label: 'Pause',
                icon: Icons.pause_rounded,
                onPressed: () => onAction(DeviceAction.mediaPause),
              ),
              NovaSecondaryButton(
                label: 'Next',
                icon: Icons.skip_next_rounded,
                onPressed: () => onAction(DeviceAction.mediaNext),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The system Settings screens NOVA can open, with their honest capability.
class DevicePanelsCard extends StatelessWidget {
  const DevicePanelsCard({
    super.key,
    required this.status,
    required this.onOpenPanel,
  });

  final DeviceControlStatus? status;
  final ValueChanged<DeviceSettingsPanel> onOpenPanel;

  static const List<DeviceSettingsPanel> _panels = <DeviceSettingsPanel>[
    DeviceSettingsPanel.wifi,
    DeviceSettingsPanel.bluetooth,
    DeviceSettingsPanel.notificationAccess,
    DeviceSettingsPanel.appDetails,
  ];

  @override
  Widget build(BuildContext context) {
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('System screens', style: NovaTheme.sectionHeading(context.nova)),
          const SizedBox(height: NovaSpace.xs),
          for (final panel in _panels) ...[
            DeviceReadout(label: panel.label, value: _valueFor(panel)),
            const SizedBox(height: NovaSpace.xs),
          ],
          DeviceButtonRow(
            children: [
              NovaSecondaryButton(
                label: 'Wi-Fi',
                icon: Icons.wifi_rounded,
                onPressed: () => onOpenPanel(DeviceSettingsPanel.wifi),
              ),
              NovaSecondaryButton(
                label: 'Bluetooth',
                icon: Icons.bluetooth_rounded,
                onPressed: () => onOpenPanel(DeviceSettingsPanel.bluetooth),
              ),
              NovaSecondaryButton(
                label: 'App info',
                icon: Icons.info_outline_rounded,
                onPressed: () => onOpenPanel(DeviceSettingsPanel.appDetails),
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _valueFor(DeviceSettingsPanel panel) {
    final capability = status?.panelStatus(panel)?.capability;
    return switch (capability) {
      DeviceCapability.deepLinkOnly => 'deep link only',
      DeviceCapability.excluded => 'not implemented',
      _ => 'opens the screen',
    };
  }
}

/// Brightness, behind the `WRITE_SETTINGS` special access.
class DeviceBrightnessCard extends StatelessWidget {
  const DeviceBrightnessCard({
    super.key,
    required this.status,
    required this.onSet,
    required this.onGrant,
  });

  final DeviceControlStatus? status;
  final ValueChanged<double> onSet;
  final VoidCallback onGrant;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final actionStatus = status?.actionStatus(DeviceAction.setBrightness);
    final granted = actionStatus?.granted ?? false;
    final current = status?.brightness;
    final fraction = current == null ? 0.5 : (current / 255.0).clamp(0.0, 1.0);

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Brightness', style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: NovaSpace.xxs),
          DeviceActionMarkers(
            level: DeviceControlLevels.levelOf(DeviceAction.setBrightness),
            capability: DeviceCapability.functional,
            granted: granted,
          ),
          const SizedBox(height: NovaSpace.xs),
          DeviceReadout(
            label: 'Current',
            value: current == null
                ? 'unknown'
                : '${((current / 255) * 100).round()}%',
          ),
          if (!granted) ...[
            const SizedBox(height: NovaSpace.xs),
            Text(
              actionStatus?.reason ?? 'Android requires the special "Modify system settings" access.',
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: c.warning),
            ),
            const SizedBox(height: NovaSpace.sm),
            NovaSecondaryButton(
              label: 'Grant access',
              icon: Icons.settings_outlined,
              onPressed: onGrant,
            ),
          ] else ...[
            const SizedBox(height: NovaSpace.sm),
            DeviceButtonRow(
              children: [
                NovaSecondaryButton(
                  label: 'Dim',
                  icon: Icons.remove_rounded,
                  onPressed: () => onSet((fraction - 0.15).clamp(0.0, 1.0)),
                ),
                NovaSecondaryButton(
                  label: '50%',
                  icon: Icons.brightness_medium_rounded,
                  onPressed: () => onSet(0.5),
                ),
                NovaSecondaryButton(
                  label: 'Bright',
                  icon: Icons.add_rounded,
                  onPressed: () => onSet((fraction + 0.15).clamp(0.0, 1.0)),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// Do Not Disturb, behind `ACCESS_NOTIFICATION_POLICY`.
class DeviceDndCard extends StatelessWidget {
  const DeviceDndCard({
    super.key,
    required this.status,
    required this.onSet,
    required this.onGrant,
  });

  final DeviceControlStatus? status;
  final ValueChanged<bool> onSet;
  final VoidCallback onGrant;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final actionStatus = status?.actionStatus(DeviceAction.setDnd);
    final granted = actionStatus?.granted ?? false;
    final enabled = status?.dndEnabled;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Do Not Disturb', style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: NovaSpace.xxs),
          DeviceActionMarkers(
            level: DeviceControlLevels.levelOf(DeviceAction.setDnd),
            capability: DeviceCapability.functional,
            granted: granted,
          ),
          const SizedBox(height: NovaSpace.xs),
          DeviceReadout(
            label: 'Current',
            value: enabled == null ? 'unknown' : (enabled ? 'on' : 'off'),
          ),
          if (!granted) ...[
            const SizedBox(height: NovaSpace.xs),
            Text(
              actionStatus?.reason ??
                  'Android requires "Do Not Disturb access", granted on a '
                      'Settings screen.',
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: c.warning),
            ),
            const SizedBox(height: NovaSpace.sm),
            NovaSecondaryButton(
              label: 'Grant access',
              icon: Icons.settings_outlined,
              onPressed: onGrant,
            ),
          ] else ...[
            const SizedBox(height: NovaSpace.sm),
            NovaSecondaryButton(
              label: (enabled ?? false)
                  ? 'Turn Do Not Disturb off'
                  : 'Turn Do Not Disturb on',
              icon: (enabled ?? false)
                  ? Icons.notifications_active_outlined
                  : Icons.do_not_disturb_on_outlined,
              onPressed: () => onSet(!(enabled ?? false)),
            ),
          ],
        ],
      ),
    );
  }
}

/// One card with a text field, its markers, a reason and a submit button.
class _InputCard extends StatelessWidget {
  const _InputCard({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.level,
    required this.granted,
    required this.controller,
    required this.hint,
    required this.buttonLabel,
    required this.onSubmit,
    this.reason,
    this.keyboardType,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final int level;
  final bool granted;
  final TextEditingController controller;
  final String hint;
  final String buttonLabel;
  final VoidCallback onSubmit;
  final String? reason;
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: c.accent),
              const SizedBox(width: NovaSpace.xs),
              Expanded(child: Text(title, style: NovaTheme.sectionHeading(c))),
            ],
          ),
          const SizedBox(height: NovaSpace.xxs),
          DeviceActionMarkers(
            level: level,
            capability: DeviceCapability.functional,
            granted: granted,
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            subtitle,
            style: Theme.of(context).textTheme.bodySmall!
                .copyWith(color: c.muted),
          ),
          if (reason != null) ...[
            const SizedBox(height: NovaSpace.xs),
            Text(
              reason!,
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: c.warning),
            ),
          ],
          const SizedBox(height: NovaSpace.sm),
          NovaTextField(
            controller: controller,
            hint: hint,
            keyboardType: keyboardType,
            prefixIcon: icon,
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => onSubmit(),
          ),
          const SizedBox(height: NovaSpace.sm),
          NovaSecondaryButton(
            label: buttonLabel,
            icon: icon,
            onPressed: onSubmit,
          ),
        ],
      ),
    );
  }
}
