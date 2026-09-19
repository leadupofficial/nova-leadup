import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design/widgets/index.dart';
import 'device_control_cards.dart';
import 'device_control_controller.dart';
import 'device_control_models.dart';
import 'device_control_sections.dart';
import 'device_control_voice_commands.dart';

/// Device & system control — the settings surface for §9.2.
///
/// The screen exists to make three things impossible to miss:
///
///  * what NOVA can actually do (open apps, dial, media, brightness, DND);
///  * what it can only point at (Wi-Fi and Bluetooth, because Android 10 and 12
///    removed programmatic toggling);
///  * what it deliberately does not do (SMS, screen reading), with the spec
///    reason shown rather than hidden.
///
/// Every action goes through [DeviceControlController.perform], the same gate a
/// spoken command uses. A tap on an L1 control is the user's explicit action;
/// L2 and L3 raise a confirmation sheet showing exactly what will happen.
///
/// The visual cards live in `device_control_cards.dart`; this file is the wiring
/// between them, the controller and the confirmation sheet.
class DeviceControlPage extends ConsumerStatefulWidget {
  const DeviceControlPage({super.key});

  @override
  ConsumerState<DeviceControlPage> createState() => _DeviceControlPageState();
}

class _DeviceControlPageState extends ConsumerState<DeviceControlPage> {
  final TextEditingController _appController = TextEditingController();
  final TextEditingController _dialController = TextEditingController();
  final TextEditingController _voiceController = TextEditingController();

  @override
  void initState() {
    super.initState();
    // The grant state can be changed in Android Settings while this screen is
    // open or while the app was backgrounded. No MediaQuery here.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(deviceControlProvider.notifier).refreshStatus();
    });
  }

  @override
  void dispose() {
    _appController.dispose();
    _dialController.dispose();
    _voiceController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final state = ref.watch(deviceControlProvider);
    final status = state.status;

    return NovaScaffold(
      topBar: Row(
        children: [
          NovaIconButton(
            icon: Icons.arrow_back_rounded,
            tooltip: 'Back',
            onTap: () => context.pop(),
          ),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Text(
              'Device control',
              style: NovaTheme.heroName(c).copyWith(fontSize: 22),
            ),
          ),
        ],
      ),
      refresh: ref.read(deviceControlProvider.notifier).refreshStatus,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DeviceBusyLine(busy: state.busy),
          DeviceControlDisclosure(status: status),
          const SizedBox(height: NovaSpace.md),
          DeviceOutcomeBanner(
            outcome: state.lastOutcome,
            error: state.error,
            busy: state.busy,
          ),
          const SizedBox(height: NovaSpace.lg),

          // ── Apps, links and calls ─────────────────────────────────────
          const NovaSectionHeader(title: 'Apps, links and calls'),
          const SizedBox(height: NovaSpace.xs),
          DeviceOpenAppCard(
            status: status,
            controller: _appController,
            onOpen: _openAppOrLink,
          ),
          const SizedBox(height: NovaSpace.sm),
          DeviceDialCard(
            status: status,
            controller: _dialController,
            onDial: _dial,
          ),
          const SizedBox(height: NovaSpace.sm),
          DeviceMediaCard(
            status: status,
            onAction: (DeviceAction action) =>
                _invoke(DeviceActionRequest(action)),
          ),
          const SizedBox(height: NovaSpace.lg),

          // ── Deep-link-only system screens ────────────────────────────
          const NovaSectionHeader(title: 'Wi-Fi and Bluetooth'),
          const SizedBox(height: NovaSpace.xs),
          DevicePanelsCard(status: status, onOpenPanel: _openPanel),
          const SizedBox(height: NovaSpace.lg),

          // ── Device settings behind a special access ──────────────────
          const NovaSectionHeader(title: 'Device settings'),
          const SizedBox(height: NovaSpace.xs),
          DeviceBrightnessCard(
            status: status,
            onSet: (double value) =>
                _invoke(DeviceActionRequest.brightness(value)),
            onGrant: () => _grant(DeviceAction.setBrightness),
          ),
          const SizedBox(height: NovaSpace.sm),
          DeviceDndCard(
            status: status,
            onSet: (bool enabled) => _invoke(DeviceActionRequest.dnd(enabled)),
            onGrant: () => _grant(DeviceAction.setDnd),
          ),
          const SizedBox(height: NovaSpace.lg),

          // ── Voice ────────────────────────────────────────────────────
          const NovaSectionHeader(title: 'Voice'),
          const SizedBox(height: NovaSpace.xs),
          DeviceVoiceConsole(
            controller: _voiceController,
            busy: state.busy,
            onSubmitted: _runVoice,
            footnote:
                'Note: the on-device wake word opens a conversation — it does '
                'not dispatch a device action by itself, and the server turn '
                'cannot run one on your phone. This console is where the matcher '
                'is reachable today; nothing pretends otherwise.',
          ),
          const SizedBox(height: NovaSpace.lg),

          // ── What is impossible, and why ──────────────────────────────
          const NovaSectionHeader(title: 'Not possible on this platform'),
          const SizedBox(height: NovaSpace.xs),
          DeviceLimitsCard(status: status, onOpenPanel: _openPanel),
          const SizedBox(height: NovaSpace.xl),
        ],
      ),
    );
  }

  // ─── Input handlers ─────────────────────────────────────────────────────

  void _openAppOrLink(String value) {
    if (value.isEmpty) {
      _snack('Type an app name, package name or link first.');
      return;
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      _invoke(DeviceActionRequest.openDeepLink(value));
    } else {
      _invoke(DeviceActionRequest.openApp(value));
    }
  }

  void _dial(String value) {
    if (value.isEmpty) {
      _snack('Type a number first.');
      return;
    }
    _invoke(DeviceActionRequest.dial(value));
  }

  void _openPanel(DeviceSettingsPanel panel) =>
      _invoke(DeviceActionRequest.openPanel(panel));

  // ─── Invocation ─────────────────────────────────────────────────────────

  /// Runs one action, raising the confirmation sheet when the level requires it.
  Future<void> _invoke(DeviceActionRequest request) async {
    final controller = ref.read(deviceControlProvider.notifier);
    var confirmed = !controller.needsConfirmationSheet(request);
    if (!confirmed) {
      confirmed = await _confirm(request) ?? false;
      if (!confirmed) {
        _snack('Cancelled — nothing was changed.');
        return;
      }
    }
    final outcome = await controller.performFromUi(request, confirmed: true);
    if (!mounted) return;
    _snack(outcome.message);
  }

  Future<void> _grant(DeviceAction action) async {
    final outcome = await ref
        .read(deviceControlProvider.notifier)
        .openGrantSettings(action);
    if (!mounted) return;
    _snack(outcome.message);
  }

  /// The spoken path: match, resolve against the current state, confirm, run.
  Future<void> _runVoice(String transcript) async {
    final trimmed = transcript.trim();
    if (trimmed.isEmpty) return;
    final controller = ref.read(deviceControlProvider.notifier);
    final command = matchDeviceVoiceCommand(trimmed);
    if (command == null) {
      _snack(
        'No device command in that. Try "open WhatsApp", "call 9876543210", '
        '"set brightness to 40%" or "pause the music".',
      );
      return;
    }

    var request = command.resolve(ref.read(deviceControlProvider).status);
    if (request == null && command.needsCurrentState) {
      await controller.refreshStatus();
      request = command.resolve(ref.read(deviceControlProvider).status);
    }
    if (request == null) {
      _snack('NOVA could not read the current state that command needs.');
      return;
    }

    // Speech is never pre-confirmed: every device action is at least L1.
    final confirmed = await _confirm(request) ?? false;
    if (!confirmed) {
      _snack('Cancelled — nothing was changed.');
      return;
    }
    final outcome = await controller.runMatchedCommand(
      command,
      confirmed: true,
    );
    if (!mounted) return;
    _snack(outcome?.message ?? 'The action did not run.');
  }

  /// §5.7-style confirmation: the exact action and payload, before anything runs.
  Future<bool?> _confirm(DeviceActionRequest request) {
    final c = context.nova;
    final changesDeviceSetting = request.level >= DeviceControlLevels.sensitive;
    return showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: c.surface,
        title: Text(
          '${request.action.label}?',
          style: NovaTheme.sectionHeading(c),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              request.confirmationSummary,
              style: Theme.of(dialogContext).textTheme.bodyMedium!
                  .copyWith(color: c.fg),
            ),
            const SizedBox(height: NovaSpace.sm),
            Text(
              'Permission level ${request.level} of 3'
              '${changesDeviceSetting ? " — this changes a device-wide setting." : "."}',
              style: Theme.of(dialogContext).textTheme.bodySmall!
                  .copyWith(color: c.muted),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text('Cancel', style: TextStyle(color: c.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('Do it', style: TextStyle(color: c.accent)),
          ),
        ],
      ),
    );
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        backgroundColor: context.nova.surfaceRaised,
        content: Text(message, style: TextStyle(color: context.nova.fg)),
      ),
    );
  }
}
