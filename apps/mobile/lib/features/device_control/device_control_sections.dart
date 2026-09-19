import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';
import 'device_control_models.dart';
import 'device_control_voice_commands.dart';

/// The visual pieces of the device-control screen.
///
/// Split from [DeviceControlPage] so the page stays about wiring and this file
/// stays about what the user reads. Nothing here decides whether an action may
/// run — that is the controller's gate — so these widgets only render the
/// status they are handed, including the reasons an action is impossible.

/// What this screen is, in one card, before any control.
class DeviceControlDisclosure extends StatelessWidget {
  const DeviceControlDisclosure({super.key, required this.status});

  final DeviceControlStatus? status;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final android = status?.androidRelease ?? status?.androidSdk?.toString();
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('What NOVA can control', style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'NOVA opens apps, links and system screens, opens the dialer with a '
            'number you confirm, can change brightness and Do Not Disturb once '
            'you grant Android\'s special access, and can send media keys. It '
            'cannot toggle Wi-Fi or Bluetooth — Android stopped letting apps do '
            'that — so it opens those screens instead.',
            style: Theme.of(context).textTheme.bodySmall!
                .copyWith(color: c.muted),
          ),
          if (android != null) ...[
            const SizedBox(height: NovaSpace.sm),
            Row(
              children: [
                Icon(Icons.android_rounded, size: 14, color: c.muted),
                const SizedBox(width: 6),
                Text(
                  'Android $android · SDK ${status?.androidSdk ?? "?"}',
                  style: NovaTheme.chip(c).copyWith(color: c.muted),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// Shows the last result, including the ones that did not run.
class DeviceOutcomeBanner extends StatelessWidget {
  const DeviceOutcomeBanner({
    super.key,
    this.outcome,
    this.error,
    this.busy = false,
  });

  final DeviceOutcome? outcome;
  final String? error;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final message = error ?? outcome?.message;
    if (message == null && !busy) return const SizedBox.shrink();

    final ok = error == null && (outcome?.ok ?? false);
    final tone = error != null ? c.danger : (ok ? c.success : c.warning);
    final icon = busy
        ? Icons.hourglass_top_rounded
        : (ok
              ? Icons.check_circle_outline_rounded
              : Icons.info_outline_rounded);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.10),
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: tone.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: tone),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Text(
              busy ? 'Talking to Android…' : message!,
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: c.fg),
            ),
          ),
        ],
      ),
    );
  }
}

/// `L3` / `deep-link only` style markers, so the limits are visible at a glance.
class DeviceMarker extends StatelessWidget {
  const DeviceMarker({super.key, required this.label, this.tone});

  final String label;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final color = tone ?? c.muted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: NovaRadius.rPill,
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        label,
        style: NovaTheme.chip(c)
            .copyWith(color: color, fontSize: NovaType.label),
      ),
    );
  }
}

/// The level + capability markers for one action.
class DeviceActionMarkers extends StatelessWidget {
  const DeviceActionMarkers({
    super.key,
    required this.level,
    required this.capability,
    required this.granted,
  });

  final int level;
  final DeviceCapability capability;
  final bool granted;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Wrap(
      spacing: NovaSpace.xs,
      runSpacing: NovaSpace.xxs,
      children: [
        DeviceMarker(
          label: _levelLabel(level),
          tone: level >= DeviceControlLevels.sensitive
              ? c.danger
              : (level >= DeviceControlLevels.external ? c.warning : c.muted),
        ),
        if (capability == DeviceCapability.deepLinkOnly)
          DeviceMarker(label: 'deep link only', tone: c.warning),
        if (capability == DeviceCapability.excluded)
          DeviceMarker(label: 'not implemented', tone: c.muted),
        if (!granted)
          DeviceMarker(label: 'access not granted', tone: c.warning),
      ],
    );
  }

  static String _levelLabel(int level) => switch (level) {
    DeviceControlLevels.readOnly => 'L0 read-only',
    DeviceControlLevels.lowRiskWrite => 'L1 low-risk',
    DeviceControlLevels.external => 'L2 external',
    _ => 'L3 sensitive',
  };
}

/// One actionable control: a title, the honest context, and a button.
class DeviceActionTile extends StatelessWidget {
  const DeviceActionTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.level,
    this.icon,
    this.capability = DeviceCapability.functional,
    this.granted = true,
    this.reason,
    this.buttonLabel,
    this.onPressed,
    this.busy = false,
  });

  final String title;
  final String subtitle;
  final int level;
  final IconData? icon;
  final DeviceCapability capability;
  final bool granted;
  final String? reason;
  final String? buttonLabel;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 18, color: c.accent),
                const SizedBox(width: NovaSpace.xs),
              ],
              Expanded(child: Text(title, style: NovaTheme.sectionHeading(c))),
            ],
          ),
          const SizedBox(height: NovaSpace.xxs),
          DeviceActionMarkers(
            level: level,
            capability: capability,
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
          if (onPressed != null) ...[
            const SizedBox(height: NovaSpace.sm),
            NovaSecondaryButton(
              label: buttonLabel ?? 'Open',
              onPressed: busy ? null : onPressed,
              icon: icon,
            ),
          ],
        ],
      ),
    );
  }
}

/// A capability the spec deliberately does not implement.
class DeviceExcludedTile extends StatelessWidget {
  const DeviceExcludedTile({super.key, required this.item});

  final DeviceExcludedCapability item;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.block_rounded, size: 16, color: c.muted),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(item.title, style: NovaTheme.sectionHeading(c)),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            item.reason,
            style: Theme.of(context).textTheme.bodySmall!
                .copyWith(color: c.muted),
          ),
        ],
      ),
    );
  }
}

/// The voice-command console.
///
/// The mapper is real and tested; whether a production spoken turn reaches it
/// is a separate question, and [footnote] says plainly what the current answer
/// is rather than implying a wake-word feature that does not exist.
class DeviceVoiceConsole extends StatelessWidget {
  const DeviceVoiceConsole({
    super.key,
    required this.controller,
    required this.onSubmitted,
    required this.busy,
    this.footnote,
  });

  final TextEditingController controller;
  final ValueChanged<String> onSubmitted;
  final bool busy;
  final String? footnote;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Try a spoken command', style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: NovaSpace.xxs),
          Text(
            'Runs the same matcher a spoken turn uses. Nothing is sent to a '
            'server, and nothing runs without the confirmation this screen asks '
            'for.',
            style: Theme.of(context).textTheme.bodySmall!
                .copyWith(color: c.muted),
          ),
          const SizedBox(height: NovaSpace.sm),
          NovaTextField(
            controller: controller,
            hint: 'e.g. "set brightness to 40%"',
            prefixIcon: Icons.mic_none_rounded,
            textInputAction: TextInputAction.go,
            enabled: !busy,
            onSubmitted: onSubmitted,
          ),
          const SizedBox(height: NovaSpace.xs),
          Wrap(
            spacing: NovaSpace.xs,
            runSpacing: NovaSpace.xs,
            children: [
              for (final example in kDeviceVoiceExamples.take(5))
                NovaChip(
                  label: example,
                  onTap: busy ? null : () => onSubmitted(example),
                ),
            ],
          ),
          if (footnote != null) ...[
            const SizedBox(height: NovaSpace.sm),
            Text(
              footnote!,
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: c.muted, fontStyle: FontStyle.italic),
            ),
          ],
        ],
      ),
    );
  }
}

/// A compact "current value" readout for brightness / DND.
class DeviceReadout extends StatelessWidget {
  const DeviceReadout({super.key, required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: NovaTheme.chip(c).copyWith(color: c.muted)),
        Text(value, style: NovaTheme.chip(c).copyWith(color: c.fg)),
      ],
    );
  }
}

/// A row of evenly spaced secondary buttons.
class DeviceButtonRow extends StatelessWidget {
  const DeviceButtonRow({
    super.key,
    required this.children,
    this.spacing = NovaSpace.xs,
  });

  final List<Widget> children;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    return Wrap(spacing: spacing, runSpacing: spacing, children: children);
  }
}

/// The controller's busy flag as a thin progress line, for the top of the page.
class DeviceBusyLine extends StatelessWidget {
  const DeviceBusyLine({super.key, required this.busy});

  final bool busy;

  @override
  Widget build(BuildContext context) {
    if (!busy) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.sm),
      child: LinearProgressIndicator(
        minHeight: 2,
        color: context.nova.accent,
        backgroundColor: context.nova.border,
      ),
    );
  }
}

/// What Android will not let a third-party app do, and the spec decisions.
class DeviceLimitsCard extends StatelessWidget {
  const DeviceLimitsCard({
    super.key,
    required this.status,
    required this.onOpenPanel,
  });

  final DeviceControlStatus? status;
  final ValueChanged<DeviceSettingsPanel> onOpenPanel;

  @override
  Widget build(BuildContext context) {
    final excluded = status?.excluded ?? const <DeviceExcludedCapability>[];
    return Column(
      children: [
        // The two capabilities Android took away from third-party apps. They
        // are first-class rows with the version reason, so "NOVA cannot toggle
        // this" is visible rather than hidden behind a button that does
        // something else.
        DeviceActionTile(
          title: 'Toggle Wi-Fi',
          subtitle:
              'NOVA can open the Wi-Fi screen, but it cannot switch Wi-Fi on or '
              'off on this Android version.',
          icon: Icons.wifi_rounded,
          level: DeviceControlLevels.levelOf(DeviceAction.openSettings),
          capability: DeviceCapability.deepLinkOnly,
          reason: status?.panelStatus(DeviceSettingsPanel.wifi)?.reason,
          buttonLabel: 'Open Wi-Fi settings',
          onPressed: () => onOpenPanel(DeviceSettingsPanel.wifi),
        ),
        const SizedBox(height: NovaSpace.sm),
        DeviceActionTile(
          title: 'Toggle Bluetooth',
          subtitle:
              'NOVA can open the Bluetooth screen, but it cannot switch '
              'Bluetooth on or off on this Android version.',
          icon: Icons.bluetooth_rounded,
          level: DeviceControlLevels.levelOf(DeviceAction.openSettings),
          capability: DeviceCapability.deepLinkOnly,
          reason: status?.panelStatus(DeviceSettingsPanel.bluetooth)?.reason,
          buttonLabel: 'Open Bluetooth settings',
          onPressed: () => onOpenPanel(DeviceSettingsPanel.bluetooth),
        ),
        const SizedBox(height: NovaSpace.sm),
        for (final item in excluded) ...[
          DeviceExcludedTile(item: item),
          const SizedBox(height: NovaSpace.sm),
        ],
      ],
    );
  }
}
