import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Meeting Summary — port of `recording/summary.html` (blueprint §5.12).
///
/// Reads `GET /api/v1/recordings/:id`, which returns the recording together with
/// its transcript and `recording_summaries` row (summary, decisions, action
/// items, extracted contacts).
///
/// The export shows date / duration / people / language in a fact grid above the
/// Summary / Decisions Made / Action Items sections. When the summary row is
/// absent — which is the normal state until the transcription pipeline runs —
/// the screen says so plainly rather than rendering empty sections, because
/// "no summary yet" and "summary with nothing in it" are different facts.
class SummaryPage extends ConsumerWidget {
  const SummaryPage({super.key, required this.recordingId});

  final String recordingId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final detail = ref.watch(recordingDetailProvider(recordingId));

    return NovaScaffold(
      topBar: Row(
        children: [
          NovaIconButton(
            icon: Icons.arrow_back_rounded,
            size: 36,
            tooltip: 'Back',
            onTap: () => context.go('/tasks'),
          ),
          const Spacer(),
          Text('Meeting Summary', style: NovaTheme.sectionHeading(c)),
          const Spacer(),
          const SizedBox(width: 36),
        ],
      ),
      refresh: () async =>
          ref.invalidate(recordingDetailProvider(recordingId)),
      child: detail.when(
        loading: () => const NovaStateView(
          loading: true,
          title: 'Loading summary',
        ),
        error: (e, _) => NovaStateView(
          icon: Icons.cloud_off_rounded,
          tone: NovaStateTone.error,
          title: 'Could not load this recording',
          message: e.toString().replaceFirst(
            RegExp(r'^NovaApiException\(\d*\): '),
            '',
          ),
          actionLabel: 'Retry',
          onAction: () =>
              ref.invalidate(recordingDetailProvider(recordingId)),
        ),
        data: (d) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              d.recording.title,
              style: NovaTheme.heroName(c),
            ),
            const SizedBox(height: NovaSpace.md),

            // Fact grid: date / duration / language.
            NovaCard(
              child: Column(
                children: [
                  _Fact(
                    icon: '📅',
                    label: 'Date',
                    value: _fmtDate(d.recording.createdAt),
                  ),
                  const SizedBox(height: NovaSpace.xs),
                  _Fact(
                    icon: '⏱',
                    label: 'Duration',
                    value: d.recording.durationLabel,
                  ),
                  const SizedBox(height: NovaSpace.xs),
                  _Fact(
                    icon: '🌐',
                    label: 'Language',
                    value: d.recording.language ?? 'Auto-detected',
                  ),
                  const SizedBox(height: NovaSpace.xs),
                  _Fact(
                    icon: '📌',
                    label: 'Status',
                    value: d.recording.status,
                  ),
                ],
              ),
            ),
            const SizedBox(height: NovaSpace.lg),

            if (d.summary == null) ...[
              const NovaStateView(
                icon: Icons.hourglass_empty_rounded,
                tone: NovaStateTone.accent,
                title: 'No summary yet',
                message:
                    'Transcription and summarisation run once the recording '
                    'pipeline is configured on the server. The recording and its '
                    'duration are saved.',
              ),
            ] else ...[
              if (d.summary!.summary != null) ...[
                Text('Summary', style: NovaTheme.sectionHeading(c)),
                const SizedBox(height: NovaSpace.xs),
                NovaCard(
                  child: Text(
                    d.summary!.summary!,
                    style: NovaTheme.bubble(c),
                  ),
                ),
                const SizedBox(height: NovaSpace.lg),
              ],
              if (d.summary!.decisions.isNotEmpty) ...[
                Text('Decisions Made', style: NovaTheme.sectionHeading(c)),
                const SizedBox(height: NovaSpace.xs),
                NovaCard(
                  child: Column(
                    children: d.summary!.decisions
                        .map((x) => _Bullet(text: x, marker: '✓'))
                        .toList(),
                  ),
                ),
                const SizedBox(height: NovaSpace.lg),
              ],
              if (d.summary!.actionItems.isNotEmpty) ...[
                Text('Action Items', style: NovaTheme.sectionHeading(c)),
                const SizedBox(height: NovaSpace.xs),
                NovaCard(
                  child: Column(
                    children: d.summary!.actionItems
                        .map((x) => _Bullet(text: x, marker: '☐'))
                        .toList(),
                  ),
                ),
              ],
            ],

            if (d.transcript != null && d.transcript!.isNotEmpty) ...[
              const SizedBox(height: NovaSpace.lg),
              Text('Transcript', style: NovaTheme.sectionHeading(c)),
              const SizedBox(height: NovaSpace.xs),
              NovaCard(
                child: Text(d.transcript!, style: NovaTheme.bubble(c)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.label, required this.value});

  final String icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Row(
      children: [
        Text(icon, style: const TextStyle(fontSize: 15)),
        const SizedBox(width: NovaSpace.xs),
        Text(label, style: NovaTheme.overline(c)),
        const Spacer(),
        Text(value, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet({required this.text, required this.marker});

  final String text;
  final String marker;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(marker, style: NovaTheme.chip(c).copyWith(color: c.accent)),
          const SizedBox(width: NovaSpace.xs),
          Expanded(child: Text(text, style: NovaTheme.bubble(c))),
        ],
      ),
    );
  }
}

String _fmtDate(DateTime? d) {
  if (d == null) return '—';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  final ampm = d.hour < 12 ? 'AM' : 'PM';
  return '${months[d.month - 1]} ${d.day}, $h:${d.minute.toString().padLeft(2, '0')} $ampm';
}
