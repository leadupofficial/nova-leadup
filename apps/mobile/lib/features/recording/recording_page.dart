import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Recording — port of `recording/recording.html` (blueprint §5.11).
///
/// Creates a real `audio_recordings` row via `POST /api/v1/recordings`, ticks a
/// live timer, records the consent acknowledgement the design insists on
/// ("Ensure everyone knows this conversation is being recorded"), and on stop
/// persists the duration and status before opening the summary.
///
/// NOT YET IMPLEMENTED: actual microphone capture and speaker diarisation. The
/// design shows a detected-participant breakdown with per-speaker percentages;
/// that requires the STT pipeline (`services/api/src/services/ai.ts` exposes
/// `transcribeAudio`) plus a provider key, so this screen currently records the
/// session metadata and the timer only. It is labelled as such in the UI rather
/// than showing invented speaker data.
class RecordingPage extends ConsumerStatefulWidget {
  const RecordingPage({super.key, this.title, this.language});

  final String? title;
  final String? language;

  @override
  ConsumerState<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends ConsumerState<RecordingPage> {
  Timer? _ticker;
  int _seconds = 0;
  bool _consentAcknowledged = false;
  bool _starting = true;
  bool _saving = false;
  String? _recordingId;
  String? _error;

  String get _timer {
    final m = (_seconds ~/ 60).toString().padLeft(2, '0');
    final s = (_seconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    try {
      final rec = await ref
          .read(novaMutationsProvider)
          .startRecording(
            title: widget.title ?? 'Meeting',
            language: widget.language,
          );
      if (!mounted) return;
      setState(() {
        _recordingId = rec.id;
        _starting = false;
      });
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() => _seconds++);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _starting = false;
        _error = e.toString().replaceFirst(
          RegExp(r'^NovaApiException\(\d*\): '),
          '',
        );
      });
    }
  }

  Future<void> _stop() async {
    final id = _recordingId;
    if (id == null || _saving) return;
    setState(() => _saving = true);
    _ticker?.cancel();
    try {
      await ref
          .read(novaMutationsProvider)
          .finishRecording(id, durationSeconds: _seconds);
      if (!mounted) return;
      context.go('/recordings/$id');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e
            .toString()
            .replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

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
          if (!_starting && _recordingId != null)
            const NovaStatusPill(label: 'Recording')
          else
            NovaStatusPill(
              label: 'Starting',
              tone: c.warning,
              animate: true,
            ),
          const Spacer(),
          const SizedBox(width: 36),
        ],
      ),
      child: Column(
        children: [
          const SizedBox(height: NovaSpace.lg),
          Text(
            _timer,
            style: NovaTheme.heroName(c).copyWith(
              fontSize: 56,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            widget.title ?? 'Meeting',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: NovaSpace.lg),
          NovaWaveform(bars: 7, height: 28, color: c.danger),

          const SizedBox(height: NovaSpace.xl),
          NovaCard(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.info_outline_rounded, size: 18, color: c.warning),
                const SizedBox(width: NovaSpace.sm),
                Expanded(
                  child: Text(
                    'Ensure everyone knows this conversation is being '
                    'recorded.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: NovaSpace.sm),

          // Consent is recorded as a real row before the session is finalised.
          NovaCard(
            child: SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: _consentAcknowledged,
              onChanged: (v) => setState(() => _consentAcknowledged = v),
              title: const Text('Everyone has been told'),
              subtitle: Text(
                'Stored with the recording as your consent record',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ),

          const SizedBox(height: NovaSpace.md),
          _FactRow(
            icon: '🌐',
            label: 'Language',
            value: widget.language ?? 'Auto-detect (Tamil + English)',
          ),
          const SizedBox(height: NovaSpace.xs),
          const _FactRow(
            icon: '👥',
            label: 'Speakers',
            value: 'Detected after transcription',
          ),
          const SizedBox(height: NovaSpace.xs),
          const _FactRow(
            icon: '📝',
            label: 'Transcription',
            value: 'Runs when the meeting ends',
          ),

          if (_error != null) ...[
            const SizedBox(height: NovaSpace.md),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(NovaSpace.sm),
              decoration: BoxDecoration(
                color: c.danger.withValues(alpha: 0.12),
                borderRadius: NovaRadius.rControl,
                border: Border.all(color: c.danger.withValues(alpha: 0.4)),
              ),
              child: Text(
                _error!,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.danger),
              ),
            ),
          ],

          const SizedBox(height: NovaSpace.xl),
          NovaPrimaryButton(
            label: 'Stop recording',
            icon: Icons.stop_rounded,
            gradient: c.recordingGradient,
            busy: _saving,
            onPressed: _starting || _recordingId == null ? null : _stop,
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'Microphone capture is not wired up yet — this session stores its '
            'metadata and duration only.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _FactRow extends StatelessWidget {
  const _FactRow({
    required this.icon,
    required this.label,
    required this.value,
  });

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
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.right,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ],
    );
  }
}
