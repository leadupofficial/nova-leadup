/// NOVA — Operator control gates shown to the user.
///
/// Two operator decisions must be able to interrupt the user, and this file is where
/// they become visible:
///
///  * **Maintenance mode** — the platform is deliberately unavailable. Without this,
///    `CONTROL_MAINTENANCE_MODE` would refuse API calls with a `503` and the app would
///    show a generic network error, which tells the user nothing.
///  * **A required update** — the build is below the operator-set minimum. The server
///    computes `updateRequired` (see the bootstrap route) so the client does not have
///    to compare versions itself and cannot disagree with the server about it.
///
/// Both are **non-blocking during startup**: the gate renders its child until a real
/// document has arrived, so a slow or failed fetch never delays the first usable
/// frame. That is the same invariant `startup.dart` protects.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'remote_config.dart';
import 'remote_config_provider.dart';

/// Wraps the routed app and shows a blocking notice when the operator has required
/// one.
///
/// Deliberately a *builder* rather than a route: a maintenance notice should cover the
/// whole app, including a page the user navigated to directly, and a route could be
/// bypassed by a deep link or a `go()` call.
class RemoteControlGate extends ConsumerWidget {
  const RemoteControlGate({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(remoteConfigProvider);
    final config = state.config;

    // Before the first successful fetch the document is a permissive placeholder.
    // Rendering the gate then would be wrong in both directions: it would either block
    // a working app or claim a maintenance window that may not exist for this build.
    if (config.unknown) return child;

    if (config.maintenance.enabled) {
      return _BlockingNotice(
        icon: Icons.build_circle_outlined,
        title: 'NOVA is under maintenance',
        message: config.maintenance.message.isEmpty
            ? 'NOVA is briefly unavailable while we perform scheduled maintenance. Please try again shortly.'
            : config.maintenance.message,
        // A maintenance window ends, so this offers a retry rather than a dead end.
        actionLabel: 'Retry',
        onAction: () => ref.read(remoteConfigProvider.notifier).refresh(force: true),
        busy: state.loading,
      );
    }

    if (config.version.updateRequired || config.version.forceUpdate) {
      return _BlockingNotice(
        icon: Icons.system_update_alt,
        title: 'Update required',
        message:
            'This version of NOVA (v${config.version.clientVersion ?? 'unknown'}) is no longer supported. '
            'Please update to v${config.version.latest} to continue.',
        actionLabel: 'Check again',
        onAction: () => ref.read(remoteConfigProvider.notifier).refresh(force: true),
        busy: state.loading,
      );
    }

    return child;
  }
}

/// A dismissable-by-nobody full-screen notice, used for maintenance and hard updates.
class _BlockingNotice extends StatelessWidget {
  const _BlockingNotice({
    required this.icon,
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
    required this.busy,
  });

  final IconData icon;
  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback onAction;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(icon, size: 56, color: Theme.of(context).colorScheme.primary),
                const SizedBox(height: 20),
                Text(
                  title,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 12),
                Text(
                  message,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: busy ? null : onAction,
                  child: busy
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(actionLabel),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Renders [child] only when a flag is enabled.
///
/// [fallback] is required so each call site states the behaviour before the flag
/// existed: a flag with no server-side row must not remove a feature.
///
/// [placeholder] is what to render when the flag is off. It defaults to nothing, which
/// is right for a launcher button; pass an explanatory widget where a silently missing
/// control would confuse the user.
class FeatureGate extends ConsumerWidget {
  const FeatureGate({
    super.key,
    required this.flag,
    required this.fallback,
    required this.child,
    this.placeholder,
  });

  final String flag;
  final bool fallback;
  final Widget child;
  final Widget? placeholder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref
        .watch(remoteConfigProvider)
        .config
        .isEnabled(flag, fallback: fallback);
    if (enabled) return child;
    return placeholder ?? const SizedBox.shrink();
  }
}

/// True when the operator's configuration allows a capability right now.
///
/// Reads `capabilities`, which the server has already combined with the emergency
/// kill switches, so a caller must not AND this with a flag check of its own.
bool capabilityEnabled(WidgetRef ref, bool Function(RemoteCapabilities) selector) {
  return selector(ref.watch(remoteCapabilitiesProvider));
}

/// A one-line, dismissible banner for a non-blocking notice — an available (but not
/// required) update.
class UpdateAvailableBanner extends ConsumerWidget {
  const UpdateAvailableBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(remoteConfigProvider).config;
    if (config.unknown ||
        config.maintenance.enabled ||
        config.version.updateRequired ||
        !config.version.updateRecommended) {
      return const SizedBox.shrink();
    }

    return Material(
      color: Theme.of(context).colorScheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: <Widget>[
            const Icon(Icons.system_update_alt, size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'NOVA v${config.version.latest} is available.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
