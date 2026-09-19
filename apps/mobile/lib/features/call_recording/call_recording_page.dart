import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design/widgets/index.dart';
import 'call_recording_cards.dart';
import 'call_recording_controller.dart';
import 'call_recording_widgets.dart';

/// Call-recording summaries — requirement 6c, built as far as Android allows.
///
/// ## What the requirement asked for, and what this screen does instead
///
/// The brief asked NOVA to screen incoming calls, transcribe unknown callers on
/// the fly and summarise their intent before the user answers. **That cannot be
/// built**, and this screen does not pretend otherwise:
///
///  * since Android 10 the `VOICE_CALL` audio source is closed to third-party
///    apps, so an app cannot hear a call;
///  * `READ_CALL_LOG` is restricted on Google Play to default dialers;
///  * recording a call is unlawful in two-party-consent jurisdictions.
///
/// So this screen is the owner's own alternative, which is both implementable
/// and Play-compliant: the user points NOVA at the folder their **own dialer**
/// writes call recordings to, NOVA transcribes and summarises the recordings the
/// user already owns, and the results land with the meeting summaries.
///
/// ## Off until the user grants a folder
///
/// A fresh install reads nothing. The screen opens on the disclosure; the folder
/// picker is refused until it is acknowledged; scanning happens only when the
/// user asks; and importing happens only for files the user ticked.
///
/// The consent tick is deliberately **not** persisted. It is re-read and
/// re-ticked in front of the user each session, the same way the meeting
/// recorder re-states its §9.5 reminder, so a restored backup cannot turn this
/// on silently.
class CallRecordingPage extends ConsumerStatefulWidget {
  const CallRecordingPage({super.key});

  @override
  ConsumerState<CallRecordingPage> createState() => _CallRecordingPageState();
}

class _CallRecordingPageState extends ConsumerState<CallRecordingPage> {
  @override
  void initState() {
    super.initState();
    // A grant revoked in Android Settings while this screen was closed or the
    // app was backgrounded is discovered here. No MediaQuery in initState.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(callRecordingControllerProvider.notifier).scan();
    });
  }

  Future<void> _pick() async {
    await ref.read(callRecordingControllerProvider.notifier).pickFolder();
  }

  Future<void> _import() async {
    final id = await ref
        .read(callRecordingControllerProvider.notifier)
        .importSelected();
    if (!mounted) return;
    if (id != null) {
      // The same summary screen the meeting recorder opens: one pipeline, one
      // presentation.
      context.push('/recordings/$id');
      return;
    }
    final message = ref.read(callRecordingControllerProvider).error;
    if (message != null) _snack(message);
  }

  Future<void> _forget() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final c = dialogContext.nova;
        return AlertDialog(
          backgroundColor: c.surface,
          title: Text(
            'Forget this folder?',
            style: NovaTheme.sectionHeading(c),
          ),
          content: Text(
            'NOVA stops reading it and forgets which folder it was. Files '
            'already imported keep their summaries. Android\'s own grant is '
            'yours to revoke in Settings → Apps → NOVA → Storage.',
            style: Theme.of(dialogContext).textTheme.bodySmall,
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text('Keep it', style: TextStyle(color: c.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text('Forget', style: TextStyle(color: c.danger)),
            ),
          ],
        );
      },
    );
    if (confirmed != true || !mounted) return;
    await ref.read(callRecordingControllerProvider.notifier).forgetFolder();
  }

  void _snack(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        backgroundColor: context.nova.surfaceRaised,
        content: Text(message, style: TextStyle(color: context.nova.fg)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final state = ref.watch(callRecordingControllerProvider);
    final controller = ref.read(callRecordingControllerProvider.notifier);

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
              'Call recordings',
              style: NovaTheme.heroName(c).copyWith(fontSize: 22),
            ),
          ),
          NovaStatusPill(
            label: state.statusLabel,
            tone: state.isEnabled && state.hasFolder ? c.success : c.muted,
            animate: state.busy || state.importing,
          ),
        ],
      ),
      refresh: controller.scan,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!state.isSupported) ...[
            const CallRecordingErrorBanner(
              message:
                  'Reading a call-recording folder is implemented for Android '
                  'only, so there is nothing to configure on this device. NOVA '
                  'never records or listens to a call on any platform.',
            ),
            const SizedBox(height: NovaSpace.md),
          ],

          CallRecordingDisclosureCard(
            state: state,
            onAcknowledged: controller.acknowledgeConsent,
          ),
          const SizedBox(height: NovaSpace.lg),

          if (state.error != null) ...[
            CallRecordingErrorBanner(message: state.error!),
            const SizedBox(height: NovaSpace.md),
          ],

          const NovaSectionHeader(title: 'Step 1 · Your folder'),
          const SizedBox(height: NovaSpace.xs),
          CallRecordingFolderCard(
            state: state,
            onPick: _pick,
            onToggleEnabled: controller.setEnabled,
            onForget: _forget,
          ),
          const SizedBox(height: NovaSpace.lg),

          const NovaSectionHeader(title: 'Step 2 · Choose recordings'),
          const SizedBox(height: NovaSpace.xs),
          CallRecordingScanCard(
            state: state,
            onScan: controller.scan,
            onSelectAllNew: controller.selectAllNew,
            onClearSelection: controller.clearSelection,
            onToggle: controller.toggleSelected,
          ),
          const SizedBox(height: NovaSpace.md),

          NovaPrimaryButton(
            label: state.selected.isEmpty
                ? 'Select recordings to import'
                : 'Import ${state.selected.length} recording'
                      '${state.selected.length == 1 ? '' : 's'}',
            icon: Icons.cloud_upload_rounded,
            busy: state.importing,
            onPressed: state.canImport ? _import : null,
          ),
          const SizedBox(height: NovaSpace.xxs),
          Text(
            'Only the files you tick are read and uploaded. Nothing else in the '
            'folder is opened.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: NovaSpace.lg),

          if (state.importing || state.outcomes.isNotEmpty) ...[
            const NovaSectionHeader(title: 'Progress'),
            const SizedBox(height: NovaSpace.xs),
            CallRecordingOutcomesCard(state: state),
            const SizedBox(height: NovaSpace.lg),
          ],

          const NovaSectionHeader(title: 'What this is not'),
          const SizedBox(height: NovaSpace.xs),
          const CallRecordingLimitsCard(),
          const SizedBox(height: NovaSpace.xl),
        ],
      ),
    );
  }
}
