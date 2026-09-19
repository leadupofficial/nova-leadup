import 'package:flutter/material.dart';

import '../../core/api/models.dart';
import '../../core/design/widgets/index.dart';
import 'briefing_controller.dart';
import 'briefing_models.dart';

/// `SwitchListTile` paints its ink splashes onto the nearest `Material`, and
/// `NovaCard` is a `DecoratedBox` with a background, so a tile placed directly
/// inside one trips a framework assertion. Same fix as the notification
/// assistant uses.
class BriefingTileSurface extends StatelessWidget {
  const BriefingTileSurface({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) =>
      Material(color: Colors.transparent, child: child);
}

/// The sources a briefing can draw on, in the order they are shown.
///
/// The four `false` entries are the honest part. The product brief mentions
/// weather, an evening recap and location or traffic nudges, and the master
/// document mentions meetings; **none of these exists in this repository** — no
/// table, no route, no provider, no key — so there is nothing to call. Rather
/// than render a placeholder that would have to invent content, the screen says
/// which sources are absent. The server confirms the same flags in every
/// briefing response, so this list and the composer cannot disagree.
const List<({String key, String label, String detail})> kBriefingSources = [
  (
    key: 'tasks',
    label: 'Tasks',
    detail: 'What is due today, what is overdue, and open work',
  ),
  (
    key: 'reminders',
    label: 'Reminders',
    detail: 'The next reminder, and any that already went off',
  ),
  (
    key: 'memories',
    label: 'Memories',
    detail: 'Notes you asked NOVA to remember about you',
  ),
  (
    key: 'calendar',
    label: 'Calendar and meetings',
    detail: 'Not connected — NOVA has no calendar or event source',
  ),
  (
    key: 'weather',
    label: 'Weather',
    detail: 'Not connected — no weather provider is configured',
  ),
  (
    key: 'eveningRecap',
    label: 'Evening recap',
    detail: 'Not built — the master document does not define one',
  ),
  (
    key: 'locationNudges',
    label: 'Location and traffic',
    detail: 'Not connected — NOVA does not read your location',
  ),
];

/// Named feature, explicit disclosure, and the "off by default" statement.
class BriefingDisclosure extends StatelessWidget {
  const BriefingDisclosure({
    super.key,
    required this.state,
    required this.controller,
  });

  final DailyBriefingState state;
  final DailyBriefingController controller;

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
                Icons.wb_sunny_outlined,
                size: 18,
                color: state.isEnabled ? c.success : c.muted,
              ),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'Daily briefing',
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
            'NOVA reads you a short spoken summary of your day: what is '
            'overdue, what is due today and your next reminder. It is off by '
            'default — a fresh install says nothing — and it only ever uses '
            'the tasks, reminders and memories already in your account. NOVA '
            'has no calendar, so it will never announce a meeting.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.muted),
          ),
          if (state.isEnabled) ...[
            const SizedBox(height: NovaSpace.sm),
            NovaSecondaryButton(
              label: 'Turn off briefing',
              icon: Icons.power_settings_new_rounded,
              onPressed: () => controller.setEnabled(false),
            ),
          ],
        ],
      ),
    );
  }
}

/// A failure, stated rather than swallowed.
class BriefingErrorBanner extends StatelessWidget {
  const BriefingErrorBanner({super.key, required this.message});

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

/// The honest "this device has no voice for that language" notice (§9.4).
class BriefingVoiceNotice extends StatelessWidget {
  const BriefingVoiceNotice({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: c.warning.withValues(alpha: 0.12),
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.warning.withValues(alpha: 0.4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.volume_off_rounded, size: 16, color: c.warning),
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

/// The opt-in and the time of day.
class BriefingScheduleCard extends StatelessWidget {
  const BriefingScheduleCard({
    super.key,
    required this.state,
    required this.controller,
    required this.onPickTime,
  });

  final DailyBriefingState state;
  final DailyBriefingController controller;
  final VoidCallback onPickTime;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final exact = state.reconciliation.exact;
    return NovaCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          BriefingTileSurface(
            child: SwitchListTile(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: NovaSpace.md,
              ),
              title: const Text('Morning briefing'),
              subtitle: Text(
                state.isEnabled
                    ? 'Speaks every day at ${state.settings.label}'
                    : 'Off — nothing is scheduled and nothing is spoken',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
              value: state.isEnabled,
              onChanged: controller.setEnabled,
            ),
          ),
          Divider(height: 1, color: c.border),
          BriefingTileSurface(
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: NovaSpace.md,
              ),
              leading: Icon(Icons.schedule_rounded, color: c.accent),
              title: const Text('Time of day'),
              subtitle: Text(
                state.settings.label,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted),
              ),
              trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
              enabled: state.isEnabled,
              onTap: state.isEnabled ? onPickTime : null,
            ),
          ),
          if (state.isEnabled && !exact) ...[
            Divider(height: 1, color: c.border),
            Padding(
              padding: const EdgeInsets.all(NovaSpace.sm),
              child: Text(
                'Android did not grant exact alarms, so the briefing may arrive '
                'a few minutes late. Grant "Alarms & reminders" to make it '
                'punctual.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.warning),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The button that fetches and reads a briefing now, and the text it read.
class BriefingPreviewCard extends StatelessWidget {
  const BriefingPreviewCard({
    super.key,
    required this.state,
    required this.onPreview,
    required this.onStop,
    required this.onClear,
  });

  final DailyBriefingState state;
  final VoidCallback onPreview;
  final VoidCallback onStop;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final briefing = state.briefing;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Hear it now',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (state.status == BriefingStatus.speaking)
                NovaStatusPill(
                  label: 'SPEAKING',
                  tone: c.accent,
                  icon: Icons.graphic_eq_rounded,
                  animate: false,
                ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'Fetches the briefing from NOVA and reads it with the on-device '
            'voice. This works whether or not the daily schedule is on, because '
            'you asked for it.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.muted),
          ),
          const SizedBox(height: NovaSpace.sm),
          Row(
            children: [
              NovaPrimaryButton(
                label: briefing == null ? 'Read it to me' : 'Read it again',
                icon: Icons.play_arrow_rounded,
                busy: state.status == BriefingStatus.loading,
                expand: false,
                onPressed: state.isBusy ? null : onPreview,
              ),
              if (state.status == BriefingStatus.speaking) ...[
                const SizedBox(width: NovaSpace.xs),
                NovaSecondaryButton(
                  label: 'Stop',
                  icon: Icons.stop_rounded,
                  onPressed: onStop,
                ),
              ],
            ],
          ),
          if (briefing != null) ...[
            const SizedBox(height: NovaSpace.md),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(NovaSpace.sm),
              decoration: BoxDecoration(
                color: c.surfaceRaised,
                borderRadius: NovaRadius.rControl,
                border: Border.all(color: c.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SelectableText(
                    briefing.text,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: NovaSpace.xs),
                  Text(
                    _provenance(briefing),
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall!.copyWith(color: c.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(height: NovaSpace.xs),
            NovaSecondaryButton(
              label: 'Clear',
              icon: Icons.close_rounded,
              onPressed: onClear,
            ),
          ],
        ],
      ),
    );
  }

  /// Where the words came from, in the user's terms.
  static String _provenance(NovaBriefing briefing) {
    final rewrote = briefing.source == 'model';
    final parts = <String>[
      rewrote
          ? 'Phrased by NOVA from your own tasks and reminders.'
          : 'Written directly from your own tasks and reminders.',
      if (briefing.source == 'grounded' && briefing.guardRejection != null)
        'A draft was discarded because it mentioned something not in your data.',
    ];
    return parts.join(' ');
  }
}

/// Which sources the briefing actually had. The absence is the point.
class BriefingSourcesCard extends StatelessWidget {
  const BriefingSourcesCard({super.key, this.briefing});

  /// The last fetched briefing, when there is one. Its `capabilities` are the
  /// server's own answer and win over the static table above; before the first
  /// fetch the table is what is shown.
  final NovaBriefing? briefing;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (final source in kBriefingSources) ...[
            if (source != kBriefingSources.first)
              Divider(height: 1, color: c.border),
            _SourceRow(
              label: source.label,
              detail: source.detail,
              available:
                  briefing == null
                      ? _kDefaultSources.contains(source.key)
                      : briefing!.hasSource(source.key),
            ),
          ],
        ],
      ),
    );
  }
}

/// The sources this app is known to have without asking the server.
const Set<String> _kDefaultSources = <String>{
  'tasks',
  'reminders',
  'memories',
};

class _SourceRow extends StatelessWidget {
  const _SourceRow({
    required this.label,
    required this.detail,
    required this.available,
  });

  final String label;
  final String detail;
  final bool available;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return BriefingTileSurface(
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: NovaSpace.md),
        leading: Icon(
          available
              ? Icons.check_circle_outline_rounded
              : Icons.remove_circle_outline_rounded,
          color: available ? c.success : c.muted,
        ),
        title: Text(label),
        subtitle: Text(
          detail,
          style: Theme.of(
            context,
          ).textTheme.bodySmall!.copyWith(color: c.muted),
        ),
        trailing: NovaStatusPill(
          label: available ? 'ON' : 'NOT CONNECTED',
          tone: available ? c.success : c.muted,
          animate: false,
        ),
      ),
    );
  }
}
