import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design/widgets/index.dart';
import 'briefing_controller.dart';
import 'briefing_models.dart';
import 'briefing_sections.dart';

/// Daily briefing — the opt-in surface for master document §9.4.
///
/// The screen exists to make three things unmissable:
///
///  * the briefing is **off by default**, and a fresh install schedules nothing
///    and says nothing;
///  * it can only draw on the tasks, reminders and memories already in the
///    account — there is no calendar, no weather and no location source, and
///    the screen says so rather than implying otherwise;
///  * if the device has no voice for the configured language, the screen says
///    that too, instead of failing silently when the time arrives.
class DailyBriefingPage extends ConsumerStatefulWidget {
  const DailyBriefingPage({super.key});

  @override
  ConsumerState<DailyBriefingPage> createState() => _DailyBriefingPageState();
}

class _DailyBriefingPageState extends ConsumerState<DailyBriefingPage> {
  @override
  void initState() {
    super.initState();
    // The OS alarm and the device's installed voices can both change while the
    // app is backgrounded, so both are re-checked on every screen open.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final controller = ref.read(dailyBriefingProvider.notifier);
      controller.reconcile();
      controller.probeVoice();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final state = ref.watch(dailyBriefingProvider);
    final controller = ref.read(dailyBriefingProvider.notifier);

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
              'Daily briefing',
              style: NovaTheme.heroName(c).copyWith(fontSize: 22),
            ),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          BriefingDisclosure(state: state, controller: controller),
          const SizedBox(height: NovaSpace.lg),

          if (state.error != null) ...[
            BriefingErrorBanner(message: state.error!),
            const SizedBox(height: NovaSpace.md),
          ],

          if (state.voiceNotice != null) ...[
            BriefingVoiceNotice(message: state.voiceNotice!),
            const SizedBox(height: NovaSpace.md),
          ],

          const NovaSectionHeader(title: 'Schedule'),
          const SizedBox(height: NovaSpace.xs),
          BriefingScheduleCard(
            state: state,
            controller: controller,
            onPickTime: _pickTime,
          ),
          const SizedBox(height: NovaSpace.lg),

          const NovaSectionHeader(title: 'Preview'),
          const SizedBox(height: NovaSpace.xs),
          BriefingPreviewCard(
            state: state,
            onPreview: _preview,
            onStop: controller.stopSpeaking,
            onClear: controller.clear,
          ),
          const SizedBox(height: NovaSpace.lg),

          const NovaSectionHeader(title: 'What the briefing can see'),
          const SizedBox(height: NovaSpace.xs),
          BriefingSourcesCard(briefing: state.briefing),
          const SizedBox(height: NovaSpace.xl),
        ],
      ),
    );
  }

  Future<void> _pickTime() async {
    final state = ref.read(dailyBriefingProvider);
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(
        hour: state.settings.hour,
        minute: state.settings.minute,
      ),
      helpText: 'When should the briefing be read?',
    );
    if (picked == null) return;
    await ref
        .read(dailyBriefingProvider.notifier)
        .setTime(hour: picked.hour, minute: picked.minute);
  }

  Future<void> _preview() async {
    final outcome = await ref.read(dailyBriefingProvider.notifier).preview();
    if (!mounted) return;

    final message = switch (outcome) {
      BriefingSpeechOutcome.spoken => 'Reading your briefing now.',
      BriefingSpeechOutcome.empty => 'There was nothing to read.',
      BriefingSpeechOutcome.noVoice =>
        'This device has no voice for that language — the text is below.',
      BriefingSpeechOutcome.failed => 'Could not fetch the briefing.',
      BriefingSpeechOutcome.busy => 'Already fetching a briefing.',
      BriefingSpeechOutcome.notOptedIn => 'The daily briefing is off.',
    };
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        backgroundColor: context.nova.surfaceRaised,
        content: Text(message, style: TextStyle(color: context.nova.fg)),
      ),
    );
  }
}
