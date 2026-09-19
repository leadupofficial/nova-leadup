import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Meeting Summary — port of `recording/summary.html` (blueprint §5.12).
///
/// Reads `GET /api/v1/recordings/:id`, which returns the recording together with
/// its transcript, its `recording_summaries` row and the transcript segments.
///
/// While the server reports `processing`, this polls that route on a bounded
/// schedule — every few seconds, stopping after about two minutes — so the
/// screen fills in on its own without an unbounded request loop. It states
/// "Transcribing and summarising…" while it waits and "Transcription failed"
/// when the server says so, rather than rendering empty sections as though the
/// meeting contained nothing.
///
/// **No speaker breakdown.** `segments[].speakerIndex` is always 0 and means
/// "unattributed"; the pipeline does not diarise. The export's per-speaker
/// percentages are therefore not rendered, and the screen says why.
class SummaryPage extends ConsumerStatefulWidget {
  const SummaryPage({super.key, required this.recordingId});

  final String recordingId;

  @override
  ConsumerState<SummaryPage> createState() => _SummaryPageState();
}

class _SummaryPageState extends ConsumerState<SummaryPage> {
  /// How often the processing state is re-checked.
  static const Duration pollInterval = Duration(seconds: 3);

  /// Stops after ~2 minutes so a stuck job cannot poll forever.
  static const int maxPolls = 40;

  Timer? _poll;
  int _polls = 0;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  void _stopPolling() {
    _poll?.cancel();
    _poll = null;
  }

  /// Starts the bounded poll only while the server is still working.
  void _syncPolling(String status) {
    if (status != 'processing') {
      _stopPolling();
      return;
    }
    if (_poll != null || _polls >= maxPolls) return;
    _poll = Timer.periodic(pollInterval, (_) {
      if (!mounted) return;
      _polls++;
      if (_polls >= maxPolls) {
        _stopPolling();
        setState(() {});
        return;
      }
      ref.invalidate(recordingDetailProvider(widget.recordingId));
    });
  }

  Future<void> _refresh({bool resetBudget = false}) async {
    if (resetBudget) _polls = 0;
    ref.invalidate(recordingDetailProvider(widget.recordingId));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final detail = ref.watch(recordingDetailProvider(widget.recordingId));

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
      refresh: _refresh,
      child: detail.when(
        loading: () =>
            const NovaStateView(loading: true, title: 'Loading summary'),
        error: (e, _) => NovaStateView(
          icon: Icons.cloud_off_rounded,
          tone: NovaStateTone.error,
          title: 'Could not load this recording',
          message: e.toString().replaceFirst(
            RegExp(r'^NovaApiException\(\d*\): '),
            '',
          ),
          actionLabel: 'Retry',
          onAction: () => ref.invalidate(
            recordingDetailProvider(widget.recordingId),
          ),
        ),
        data: (d) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) _syncPolling(d.recording.status);
          });
          return _body(d);
        },
      ),
    );
  }

  Widget _body(NovaRecordingDetail d) {
    final c = context.nova;
    final status = d.recording.status;
    final transcript = _transcriptOf(d);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(d.recording.title, style: NovaTheme.heroName(c)),
        const SizedBox(height: NovaSpace.md),
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
              _Fact(icon: '📌', label: 'Status', value: status),
            ],
          ),
        ),
        const SizedBox(height: NovaSpace.lg),

        if (status == 'processing') ...[
          NovaStateView(
            loading: true,
            title: 'Transcribing and summarising…',
            message: _polls >= maxPolls
                ? 'This is taking longer than usual. The server is still '
                      'working; refresh to check again.'
                : 'This screen updates itself every few seconds while the '
                      'server works. It stops checking after about two minutes.',
            actionLabel: _polls >= maxPolls ? 'Check now' : null,
            onAction: _polls >= maxPolls
                ? () => _refresh(resetBudget: true)
                : null,
          ),
        ] else if (status == 'failed') ...[
          NovaStateView(
            icon: Icons.error_outline_rounded,
            tone: NovaStateTone.error,
            title: 'Transcription failed',
            message:
                'The server could not transcribe this recording. The audio is '
                'saved, so it can be retried from the server side.',
            actionLabel: 'Check again',
            onAction: () => _refresh(resetBudget: true),
          ),
        ] else if (d.hasNothing) ...[
          const NovaStateView(
            icon: Icons.volume_off_rounded,
            tone: NovaStateTone.accent,
            title: 'No speech was detected',
            message:
                'Nothing in this recording produced a transcript or a summary, '
                'so there is nothing to show. The recording and its duration '
                'are saved.',
          ),
        ] else ...[
          if (d.summary != null && !d.summary!.isEmpty) ...[
            if (d.summary!.summary != null &&
                d.summary!.summary!.trim().isNotEmpty) ...[
              Text('Summary', style: NovaTheme.sectionHeading(c)),
              const SizedBox(height: NovaSpace.xs),
              NovaCard(
                child: Text(d.summary!.summary!, style: NovaTheme.bubble(c)),
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
                      .map((item) => _ActionItemRow(item: item))
                      .toList(),
                ),
              ),
              const SizedBox(height: NovaSpace.lg),
            ],
            if (d.summary!.extractedContacts.isNotEmpty) ...[
              Text('Contacts Mentioned', style: NovaTheme.sectionHeading(c)),
              const SizedBox(height: NovaSpace.xs),
              NovaCard(
                child: Column(
                  children: d.summary!.extractedContacts
                      .map((contact) => _ContactRow(contact: contact))
                      .toList(),
                ),
              ),
              const SizedBox(height: NovaSpace.lg),
            ],
          ] else ...[
            const NovaStateView(
              icon: Icons.notes_rounded,
              tone: NovaStateTone.neutral,
              title: 'No summary was produced',
              message:
                  'The transcript is below, but the server did not extract a '
                  'summary from it.',
            ),
            const SizedBox(height: NovaSpace.md),
          ],
          if (transcript != null && transcript.trim().isNotEmpty) ...[
            Text('Transcript', style: NovaTheme.sectionHeading(c)),
            const SizedBox(height: NovaSpace.xs),
            NovaCard(child: Text(transcript, style: NovaTheme.bubble(c))),
            const SizedBox(height: NovaSpace.xs),
            Text(
              'Speaker labels are not available: the transcript is not split '
              'by speaker, so no per-speaker breakdown is shown.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ],
    );
  }

  /// The transcript text, falling back to the segments when the route returned
  /// only those.
  String? _transcriptOf(NovaRecordingDetail d) {
    final text = d.transcript?.trim();
    if (text != null && text.isNotEmpty) return text;
    if (d.segments.isEmpty) return null;
    final joined = d.segments
        .map((s) => s.text.trim())
        .where((s) => s.isNotEmpty)
        .join(' ');
    return joined.isEmpty ? null : joined;
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

/// One action item: the text, then who owns it and when it is due — both stated
/// as "Unassigned"/"No due date" when the pipeline did not extract them, rather
/// than left blank.
class _ActionItemRow extends StatelessWidget {
  const _ActionItemRow({required this.item});

  final NovaActionItem item;

  @override
  Widget build(BuildContext context) {
    final owner = item.owner?.trim();
    final due = item.dueDate?.trim() ?? item.dueDateIso?.trim();
    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Bullet(text: item.text, marker: '☐'),
          Wrap(
            spacing: NovaSpace.xs,
            runSpacing: 4,
            children: [
              _MetaChip(
                icon: Icons.person_outline_rounded,
                label: (owner == null || owner.isEmpty)
                    ? 'Unassigned'
                    : owner,
                muted: owner == null || owner.isEmpty,
              ),
              _MetaChip(
                icon: Icons.event_outlined,
                label: (due == null || due.isEmpty) ? 'No due date' : due,
                muted: due == null || due.isEmpty,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ContactRow extends StatelessWidget {
  const _ContactRow({required this.contact});

  final NovaExtractedContact contact;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final name = contact.name?.trim();
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('👤', style: TextStyle(color: c.accent)),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  (name == null || name.isEmpty) ? 'Unnamed contact' : name,
                  style: NovaTheme.bubble(c),
                ),
                Text(
                  contact.detail,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          Text(
            contact.source == 'model' ? 'inferred' : 'said aloud',
            style: NovaTheme.chip(c),
          ),
        ],
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip({
    required this.icon,
    required this.label,
    this.muted = false,
  });

  final IconData icon;
  final String label;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final color = muted ? c.muted : c.fg;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: c.surfaceRaised,
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.muted.withValues(alpha: 0.25)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 4),
          Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: color),
          ),
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
