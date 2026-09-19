import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design/widgets/index.dart';
import 'live_waveform.dart';
import 'recording_controller.dart';
import 'recording_widgets.dart';

/// Recording — port of `recording/recording.html` (blueprint §5.11).
///
/// Real microphone capture. Recording is **off by default**: the screen opens on
/// the §9.5 consent reminder ("Ensure everyone knows this conversation is being
/// recorded") and Start stays disabled until it is acknowledged. Starting writes
/// the `audio_recordings` row with `consentRecorded: true`, opens the microphone
/// and runs the elapsed timer; pausing genuinely pauses capture and the timer
/// stops with it. On stop the bytes are uploaded to
/// `POST /recordings/:id/audio` (raw body, not base64) and the server is asked to
/// transcribe; a failed upload is stated plainly and the row is kept, never
/// reported as stored.
///
/// Speaker diarisation does not exist in the pipeline (`speakerIndex` is always
/// 0 and means "unattributed"), so the screen says that rather than showing the
/// export's per-speaker percentages.
class RecordingPage extends ConsumerStatefulWidget {
  const RecordingPage({super.key, this.title, this.language});

  final String? title;
  final String? language;

  @override
  ConsumerState<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends ConsumerState<RecordingPage> {
  late final TextEditingController _titleController;

  @override
  void initState() {
    super.initState();
    _titleController = TextEditingController(text: widget.title ?? 'Meeting');
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(recordingControllerProvider.notifier).prepareNewSession();
    });
  }

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    await ref
        .read(recordingControllerProvider.notifier)
        .start(title: _titleController.text, language: widget.language);
  }

  Future<void> _stop() async {
    final id = await ref.read(recordingControllerProvider.notifier).stop();
    if (!mounted) return;
    if (id != null) context.go('/recordings/$id');
  }

  Future<void> _retryUpload() async {
    final id = await ref.read(recordingControllerProvider.notifier).retryUpload();
    if (!mounted) return;
    if (id != null) context.go('/recordings/$id');
  }

  Future<void> _back() async {
    final controller = ref.read(recordingControllerProvider.notifier);
    if (ref.read(recordingControllerProvider).isActive) {
      final leave = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('A recording is in progress'),
          content: const Text(
            'Leaving now stops the microphone and discards this recording. '
            'The saved row stays, without audio.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Keep recording'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Discard'),
            ),
          ],
        ),
      );
      if (leave != true) return;
      await controller.discard();
    }
    if (!mounted) return;
    context.go('/tasks');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final state = ref.watch(recordingControllerProvider);

    return PopScope(
      canPop: !state.isActive,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: NovaScaffold(
        topBar: Row(
          children: [
            NovaIconButton(
              icon: Icons.arrow_back_rounded,
              size: 36,
              tooltip: 'Back',
              onTap: _back,
            ),
            const Spacer(),
            NovaStatusPill(
              label: recordingStatusLabel(state.phase),
              tone: state.phase == RecordingPhase.failed ? c.danger : null,
              animate: state.isBusy || state.phase == RecordingPhase.recording,
            ),
            const Spacer(),
            const SizedBox(width: 36),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // §9.5: the indicator stays on screen the whole time capture is
            // active — recording or paused.
            if (state.isActive) ...[
              RecordingIndicatorBar(
                paused: state.phase == RecordingPhase.paused,
                elapsed: state.elapsedLabel,
              ),
              const SizedBox(height: NovaSpace.md),
            ],
            RecordingTimer(seconds: state.elapsedSeconds),
            const SizedBox(height: NovaSpace.xs),
            Text(
              state.title ?? widget.title ?? 'Meeting',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: NovaSpace.lg),
            LiveWaveform(
              levels: state.levels,
              active: state.phase == RecordingPhase.recording,
            ),
            const SizedBox(height: NovaSpace.xs),
            Text(
              state.levels.isEmpty
                  ? 'No audio level yet.'
                  : 'Live input level from the microphone.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: NovaSpace.lg),

            if (state.phase == RecordingPhase.consent ||
                state.phase == RecordingPhase.failed)
              RecordingConsentPanel(
                controller: _titleController,
                acknowledged: state.consentAcknowledged,
                canStart: state.canStart,
                language: widget.language,
                onAcknowledged: (v) => ref
                    .read(recordingControllerProvider.notifier)
                    .acknowledgeConsent(v),
                onStart: _start,
              )
            else if (state.isActive)
              RecordingActivePanel(
                paused: state.phase == RecordingPhase.paused,
                onPause: () =>
                    ref.read(recordingControllerProvider.notifier).pause(),
                onResume: () =>
                    ref.read(recordingControllerProvider.notifier).resume(),
                onStop: _stop,
              )
            else
              RecordingProgressPanel(state: state),

            if (state.error != null) ...[
              const SizedBox(height: NovaSpace.md),
              RecordingErrorCard(message: state.error!, recordingId: state.recordingId),
              if (state.phase == RecordingPhase.failed &&
                  state.recordingId != null) ...[
                const SizedBox(height: NovaSpace.sm),
                NovaPrimaryButton(
                  label: 'Retry upload',
                  icon: Icons.cloud_upload_rounded,
                  onPressed: _retryUpload,
                ),
              ],
            ],
            const SizedBox(height: NovaSpace.md),
            Text(
              'Speaker labels are not available — the transcript is not split '
              'by speaker, so NOVA does not show a speaker breakdown.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}
