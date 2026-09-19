import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/widgets/index.dart';
import 'notification_app_catalogue.dart';
import 'notification_assistant_sections.dart';
import 'notification_controller.dart';
import 'notification_models.dart';

/// §5.21 "Apps allowed" — the per-app allowlist, with the banking and
/// OTP/authenticator rows rendered as un-selectable.
///
/// Every blocked row is a disabled [_BlockedAppRow] with the category and the
/// reason, not a switch the user can flip. Tapping one shows why it is blocked
/// so the screen never looks broken; there is no way to allow it from here, and
/// [NotificationAssistantController.setPackageAllowed] refuses independently.
class NotificationAppList extends ConsumerWidget {
  const NotificationAppList({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final state = ref.watch(notificationAssistantProvider);
    final controller = ref.read(notificationAssistantProvider.notifier);
    final settings = state.settings;

    final allowable = kKnownApps
        .where((KnownApp app) => !app.isBlocked)
        .toList(growable: false);
    final blocked = kKnownApps
        .where((KnownApp app) => app.isBlocked)
        .toList(growable: false);
    final discovered = state.discoveredApps
        .where(
          (DiscoveredApp app) =>
              !app.packageName.startsWith('com.leadup.nova') &&
              knownApp(app.packageName) == null &&
              !settings.isPackageBlocked(app.packageName, appLabel: app.label),
        )
        .toList(growable: false);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                settings.allowedPackages.isEmpty
                    ? 'No apps are allowed yet, so NOVA reads nothing.'
                    : '${settings.allowedPackages.length} '
                          'app${settings.allowedPackages.length == 1 ? '' : 's'} '
                          'allowed.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
            ),
            NovaChip(
              label: 'Use work defaults',
              icon: Icons.auto_awesome_rounded,
              onTap: controller.allowRecommendedApps,
            ),
          ],
        ),
        const SizedBox(height: NovaSpace.sm),

        Text('Work apps you can allow', style: NovaTheme.overline(c)),
        const SizedBox(height: NovaSpace.xs),
        NovaCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              for (var i = 0; i < allowable.length; i++) ...[
                if (i > 0) Divider(height: 1, color: c.border),
                _AllowedAppRow(
                  label: allowable[i].label,
                  packageName: allowable[i].packageName,
                  selected: settings.allowedPackages.contains(
                    allowable[i].packageName,
                  ),
                  enabled: !state.busy,
                  onChanged: (bool value) => controller.setPackageAllowed(
                    allowable[i].packageName,
                    value,
                  ),
                ),
              ],
            ],
          ),
        ),

        if (discovered.isNotEmpty) ...[
          const SizedBox(height: NovaSpace.md),
          Text('Seen recently', style: NovaTheme.overline(c)),
          const SizedBox(height: 2),
          Text(
            'These apps posted a notification since you turned the assistant '
            'on. NOVA saw the app name only — never the content — and will not '
            'read them unless you allow them.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.muted),
          ),
          const SizedBox(height: NovaSpace.xs),
          NovaCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                for (var i = 0; i < discovered.length; i++) ...[
                  if (i > 0) Divider(height: 1, color: c.border),
                  _AllowedAppRow(
                    label: discovered[i].label,
                    packageName: discovered[i].packageName,
                    selected: settings.allowedPackages.contains(
                      discovered[i].packageName,
                    ),
                    enabled: !state.busy,
                    onChanged: (bool value) => controller.setPackageAllowed(
                      discovered[i].packageName,
                      value,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],

        const SizedBox(height: NovaSpace.md),
        Text('Always blocked', style: NovaTheme.overline(c)),
        const SizedBox(height: 2),
        Text(
          'Banking, payment, one-time-code and password apps can never be '
          'selected. This is not a setting (§9.5).',
          style: Theme.of(
            context,
          ).textTheme.bodySmall!.copyWith(color: c.muted),
        ),
        const SizedBox(height: NovaSpace.xs),
        NovaCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              for (var i = 0; i < blocked.length; i++) ...[
                if (i > 0) Divider(height: 1, color: c.border),
                _BlockedAppRow(app: blocked[i]),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// One selectable app.
class _AllowedAppRow extends StatelessWidget {
  const _AllowedAppRow({
    required this.label,
    required this.packageName,
    required this.selected,
    required this.enabled,
    required this.onChanged,
  });

  final String label;
  final String packageName;
  final bool selected;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NotificationTileSurface(
      child: SwitchListTile.adaptive(
        contentPadding: const EdgeInsets.symmetric(horizontal: NovaSpace.md),
        value: selected,
        onChanged: enabled ? onChanged : null,
        title: Text(label, style: Theme.of(context).textTheme.titleMedium),
        subtitle: Text(
          packageName,
          style: Theme.of(
            context,
          ).textTheme.bodySmall!.copyWith(color: c.muted),
        ),
      ),
    );
  }
}

/// One permanently blocked app. There is no switch: §5.21 requires these to be
/// un-selectable, so the row explains the block and cannot be toggled.
class _BlockedAppRow extends StatelessWidget {
  const _BlockedAppRow({required this.app});

  final KnownApp app;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final category = app.category!;

    return InkWell(
      onTap: () => ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: c.surfaceRaised,
          content: Text(
            '${app.label} is always blocked. ${category.explanation}',
            style: TextStyle(color: c.fg),
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: NovaSpace.md,
          vertical: 14,
        ),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: c.danger.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(NovaRadius.control),
                border: Border.all(color: c.danger.withValues(alpha: 0.25)),
              ),
              child: Icon(Icons.lock_rounded, size: 18, color: c.danger),
            ),
            const SizedBox(width: NovaSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    app.label,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    category.label,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall!.copyWith(color: c.danger),
                  ),
                ],
              ),
            ),
            Text(
              'Blocked',
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.muted),
            ),
          ],
        ),
      ),
    );
  }
}
