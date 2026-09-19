import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';
import 'notification_controller.dart';

/// `SwitchListTile` paints its ink splashes onto the nearest `Material`, and
/// `NovaCard` is a `DecoratedBox` with a background. A tile placed directly
/// inside one trips a framework assertion that the splash would be invisible,
/// so every tile in this feature is wrapped in this transparent surface — the
/// framework's own documented fix, and visually a no-op.
class NotificationTileSurface extends StatelessWidget {
  const NotificationTileSurface({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) =>
      Material(color: Colors.transparent, child: child);
}

/// Named feature, explicit disclosure, and the "off by default" statement.
class NotificationDisclosure extends StatelessWidget {
  const NotificationDisclosure({
    super.key,
    required this.state,
    required this.controller,
  });

  final NotificationAssistantState state;
  final NotificationAssistantController controller;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.shield_outlined,
                size: 18,
                color: state.isEnabled ? c.success : c.muted,
              ),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'Read selected notifications',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              NovaStatusPill(
                label: state.isEnabled ? 'ON' : 'OFF',
                tone: state.isEnabled ? c.success : c.muted,
                animate: false,
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'This is Smart Notification Assistant, and it is off by default: a '
            'fresh install reads nothing. When you turn it on, NOVA reads only '
            'the apps you tick below, keeps nothing on disk, never reads OTPs, '
            'passwords, bank alerts or verification codes, and never speaks '
            'unless you confirm it.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.muted),
          ),
          if (state.isEnabled) ...[
            const SizedBox(height: NovaSpace.sm),
            NovaSecondaryButton(
              label: 'Turn off and clear',
              icon: Icons.power_settings_new_rounded,
              onPressed: controller.disableAndClear,
            ),
          ],
        ],
      ),
    );
  }
}

class NotificationErrorBanner extends StatelessWidget {
  const NotificationErrorBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: c.danger.withValues(alpha: 0.12),
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.danger.withValues(alpha: 0.4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline_rounded, size: 16, color: c.danger),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Text(
              message,
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.fg),
            ),
          ),
        ],
      ),
    );
  }
}

/// Android owns this grant; the app can only send the user to the screen.
class NotificationAccessCard extends StatelessWidget {
  const NotificationAccessCard({
    super.key,
    required this.state,
    required this.controller,
  });

  final NotificationAssistantState state;
  final NotificationAssistantController controller;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final granted = state.hasAccess;
    final tone = granted ? c.success : c.warning;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                granted
                    ? Icons.verified_user_outlined
                    : Icons.gpp_maybe_outlined,
                size: 18,
                color: tone,
              ),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  state.status?.userMessage ?? 'Checking Notification Access…',
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall!.copyWith(color: c.fg),
                ),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.sm),
          Text(
            'Android calls this "Notification access". NOVA appears there under '
            'its own name, and you can revoke it at any time — the assistant '
            'switches itself off the next time the app opens.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.muted),
          ),
          const SizedBox(height: NovaSpace.sm),
          Wrap(
            spacing: NovaSpace.xs,
            runSpacing: NovaSpace.xs,
            children: [
              NovaSecondaryButton(
                label: granted
                    ? 'Manage in Android Settings'
                    : 'Open Notification Access',
                icon: Icons.settings_outlined,
                onPressed: controller.openAccessSettings,
              ),
              NovaSecondaryButton(
                label: 'Re-check',
                icon: Icons.refresh_rounded,
                onPressed: controller.refreshStatus,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The master toggle. Off until the user turns it on, and it will not turn on
/// without Notification Access.
class NotificationMasterCard extends StatelessWidget {
  const NotificationMasterCard({
    super.key,
    required this.state,
    required this.controller,
  });

  final NotificationAssistantState state;
  final NotificationAssistantController controller;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      padding: EdgeInsets.zero,
      child: NotificationTileSurface(
        child: SwitchListTile.adaptive(
          contentPadding: const EdgeInsets.symmetric(horizontal: NovaSpace.md),
          value: state.isEnabled,
          onChanged: state.busy
              ? null
              : (bool value) => controller.setEnabled(value),
          title: Text(
            'Read selected notifications',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          subtitle: Text(
            state.isEnabled
                ? 'On. Only the apps below, only high-priority work messages, '
                      'and never codes or bank alerts.'
                : state.hasAccess
                ? 'Off. NOVA reads nothing at all while this is off.'
                : 'Off. Grant Notification Access first.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.muted),
          ),
        ),
      ),
    );
  }
}

/// §5.21's four rules. Two are enforced and cannot be switched off; two are the
/// user's choice.
///
/// §5.21 draws "Ask before reading notifications aloud" as an unchecked box,
/// which contradicts §9.3's requirement of a confirmation *per session*. The
/// section marked non-negotiable wins, so it renders locked.
class NotificationRulesCard extends StatelessWidget {
  const NotificationRulesCard({
    super.key,
    required this.state,
    required this.controller,
  });

  final NotificationAssistantState state;
  final NotificationAssistantController controller;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final settings = state.settings;

    return NovaCard(
      padding: EdgeInsets.zero,
      child: NotificationTileSurface(
        child: Column(
          children: [
            const _LockedRule(
              label: 'Ignore OTPs, passwords, bank alerts, auth messages',
              detail:
                  'Enforced on-device before anything is kept or spoken. This '
                  'cannot be turned off (§9.5).',
            ),
            Divider(height: 1, color: c.border),
            const _LockedRule(
              label: 'Do not store raw notification text',
              detail:
                  'No database row, no preference value, no log line. '
                  'Summaries live in memory for this session only.',
            ),
            Divider(height: 1, color: c.border),
            SwitchListTile.adaptive(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: NovaSpace.md,
              ),
              value: settings.summarizeHighPriorityOnly,
              onChanged: state.busy
                  ? null
                  : controller.setSummarizeHighPriorityOnly,
              title: Text(
                'Summarize only high-priority work notifications',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              subtitle: Text(
                'Silent, promotional and social notifications are discarded.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
            ),
            Divider(height: 1, color: c.border),
            SwitchListTile.adaptive(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: NovaSpace.md,
              ),
              value: settings.readAloudEnabled,
              onChanged: state.isEnabled && !state.busy
                  ? controller.setReadAloudEnabled
                  : null,
              title: Text(
                'Read summaries aloud',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              subtitle: Text(
                'Off by default. Even when on, NOVA asks before every session '
                'of reading.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
            ),
            Divider(height: 1, color: c.border),
            const _LockedRule(
              label: 'Ask before reading notifications aloud',
              detail:
                  'Always on. §9.3 requires a confirmation per session, so '
                  'this is not a setting — the switch would defeat it.',
              icon: Icons.record_voice_over_outlined,
            ),
          ],
        ),
      ),
    );
  }
}

class _LockedRule extends StatelessWidget {
  const _LockedRule({
    required this.label,
    required this.detail,
    this.icon = Icons.lock_rounded,
  });

  final String label;
  final String detail;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: NovaSpace.md,
        vertical: 14,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: c.success.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(NovaRadius.control),
              border: Border.all(color: c.success.withValues(alpha: 0.25)),
            ),
            child: Icon(icon, size: 18, color: c.success),
          ),
          const SizedBox(width: NovaSpace.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(label, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 2),
                Text(
                  detail,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall!.copyWith(color: c.muted),
                ),
              ],
            ),
          ),
          const SizedBox(width: NovaSpace.xs),
          Icon(Icons.verified_rounded, size: 18, color: c.success),
        ],
      ),
    );
  }
}
