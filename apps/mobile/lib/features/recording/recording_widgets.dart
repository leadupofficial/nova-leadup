import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';
import 'recording_controller.dart';

/// The recorder screen's panels.
///
/// Split from `recording_page.dart` so each file stays small. They are public
/// only for that split; nothing outside the recording feature uses them.

String recordingStatusLabel(RecordingPhase phase) => switch (phase) {
  RecordingPhase.consent => 'Ready',
  RecordingPhase.starting => 'Starting',
  RecordingPhase.recording => 'Recording',
  RecordingPhase.paused => 'Paused',
  RecordingPhase.uploading => 'Uploading',
  RecordingPhase.processing => 'Processing',
  RecordingPhase.failed => 'Problem',
};

class RecordingTimer extends StatelessWidget {
  const RecordingTimer({super.key, required this.seconds});

  final int seconds;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final m = (seconds ~/ 60).toString().padLeft(2, '0');
    final s = (seconds % 60).toString().padLeft(2, '0');
    return Text(
      '$m:$s',
      textAlign: TextAlign.center,
      style: NovaTheme.heroName(
        c,
      ).copyWith(fontSize: 56, fontFeatures: const [FontFeature.tabularFigures()]),
    );
  }
}

/// The consent gate and the Start button it guards.
class RecordingConsentPanel extends StatelessWidget {
  const RecordingConsentPanel({
    super.key,
    required this.controller,
    required this.acknowledged,
    required this.canStart,
    required this.language,
    required this.onAcknowledged,
    required this.onStart,
  });

  final TextEditingController controller;
  final bool acknowledged;
  final bool canStart;
  final String? language;
  final ValueChanged<bool> onAcknowledged;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        NovaCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline_rounded, size: 18, color: c.warning),
                  const SizedBox(width: NovaSpace.sm),
                  Expanded(
                    child: Text(
                      // Verbatim, as §9.5 requires.
                      'Ensure everyone knows this conversation is being '
                      'recorded',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: NovaSpace.sm),
              // A plain Checkbox rather than CheckboxListTile: a ListTile paints
              // its ink on the nearest Material, and inside the card's decorated
              // box that triggers a framework assertion.
              InkWell(
                onTap: () => onAcknowledged(!acknowledged),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Checkbox(
                      value: acknowledged,
                      onChanged: (v) => onAcknowledged(v ?? false),
                    ),
                    const SizedBox(width: NovaSpace.xs),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Everyone has been told',
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                          Text(
                            'Stored with the recording as your consent record',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: NovaSpace.sm),
        NovaCard(
          child: TextField(
            controller: controller,
            textInputAction: TextInputAction.done,
            decoration: const InputDecoration(
              labelText: 'Meeting title',
              border: InputBorder.none,
            ),
          ),
        ),
        const SizedBox(height: NovaSpace.sm),
        RecordingFactRow(
          icon: '🌐',
          label: 'Language',
          value: language ?? 'Auto-detect (Tamil + English)',
        ),
        const SizedBox(height: NovaSpace.xs),
        const RecordingFactRow(
          icon: '🗣',
          label: 'Transcription',
          value: 'Runs after the audio is uploaded',
        ),
        const SizedBox(height: NovaSpace.md),
        NovaPrimaryButton(
          label: 'Start recording',
          icon: Icons.fiber_manual_record_rounded,
          gradient: c.recordingGradient,
          onPressed: canStart ? onStart : null,
        ),
        const SizedBox(height: NovaSpace.xs),
        Text(
          acknowledged
              ? 'The microphone opens when you press Start.'
              : 'Tick the box above before you can start. Recording is off until then.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class RecordingActivePanel extends StatelessWidget {
  const RecordingActivePanel({
    super.key,
    required this.paused,
    required this.onPause,
    required this.onResume,
    required this.onStop,
  });

  final bool paused;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (paused)
          NovaSecondaryButton(
            label: 'Resume',
            icon: Icons.play_arrow_rounded,
            expand: true,
            onPressed: onResume,
          )
        else
          NovaSecondaryButton(
            label: 'Pause',
            icon: Icons.pause_rounded,
            expand: true,
            onPressed: onPause,
          ),
        const SizedBox(height: NovaSpace.sm),
        NovaPrimaryButton(
          label: 'Stop recording',
          icon: Icons.stop_rounded,
          gradient: c.recordingGradient,
          onPressed: onStop,
        ),
      ],
    );
  }
}

class RecordingProgressPanel extends StatelessWidget {
  const RecordingProgressPanel({super.key, required this.state});

  final RecordingState state;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final message = switch (state.phase) {
      RecordingPhase.starting => 'Opening the microphone…',
      RecordingPhase.uploading =>
        state.statusMessage ?? 'Uploading the audio…',
      RecordingPhase.processing =>
        state.statusMessage ?? 'Transcribing and summarising…',
      _ => state.statusMessage ?? 'Working…',
    };
    return NovaCard(
      child: Row(
        children: [
          SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
          ),
          const SizedBox(width: NovaSpace.sm),
          Expanded(
            child: Text(message, style: Theme.of(context).textTheme.bodySmall),
          ),
        ],
      ),
    );
  }
}

class RecordingErrorCard extends StatelessWidget {
  const RecordingErrorCard({
    super.key,
    required this.message,
    this.recordingId,
  });

  final String message;
  final String? recordingId;

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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            message,
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.danger),
          ),
          if (recordingId != null) ...[
            const SizedBox(height: NovaSpace.xs),
            Text(
              'Recording $recordingId is saved on the server. Its audio is not.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ),
    );
  }
}

class RecordingFactRow extends StatelessWidget {
  const RecordingFactRow({
    super.key,
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
