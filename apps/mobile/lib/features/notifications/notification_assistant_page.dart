import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design/widgets/index.dart';
import 'notification_app_list.dart';
import 'notification_assistant_sections.dart';
import 'notification_controller.dart';
import 'notification_inbox_card.dart';
import 'notification_models.dart';

/// Smart Notification Assistant — the settings surface for §5.21.
///
/// The screen exists to make three things impossible to miss:
///
///  * the feature is **off by default**, and a fresh install monitors nothing;
///  * it is a named, disclosed capability, and Notification Access is granted or
///    revoked by the user in Android Settings, never by NOVA;
///  * it can be switched off instantly, and switching it off drops everything it
///    was holding.
///
/// What is deliberately *not* here: a switch for "ignore OTPs, passwords, bank
/// alerts and auth messages" and a switch for "do not store raw notification
/// text". §9.5 makes both non-negotiable, so they render as locked rows — see
/// [NotificationRulesCard].
class NotificationAssistantPage extends ConsumerStatefulWidget {
  const NotificationAssistantPage({super.key});

  @override
  ConsumerState<NotificationAssistantPage> createState() =>
      _NotificationAssistantPageState();
}

class _NotificationAssistantPageState
    extends ConsumerState<NotificationAssistantPage> {
  @override
  void initState() {
    super.initState();
    // The grant can be revoked in Android Settings while this screen is open or
    // while the app was backgrounded. No MediaQuery here.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(notificationAssistantProvider.notifier).refreshStatus();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final state = ref.watch(notificationAssistantProvider);
    final controller = ref.read(notificationAssistantProvider.notifier);

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
              'Notification assistant',
              style: NovaTheme.heroName(c).copyWith(fontSize: 22),
            ),
          ),
        ],
      ),
      refresh: controller.refreshStatus,
      // The whole console is Android-only. It reads the notification shade through a
      // `NotificationListenerService` and sends the user to Android's own
      // "Notification access" screen, neither of which exists on iOS —
      // `notification_platform.dart` reports `unsupported` there. The controller
      // already refused to act, but the page still rendered every step, the master
      // toggle and a live-looking inbox, so an iOS reviewer saw a feature set the app
      // cannot deliver. That is the same App Review 2.3.1(a) defect the device-control
      // and call-recording screens were fixed for; this was the one screen left.
      //
      // Gated after `status` resolves, so the loading state is not mistaken for
      // "unsupported".
      child: (state.status != null && !state.isSupported)
          ? const NovaStateView(
              icon: Icons.notifications_off_outlined,
              title: 'Notification assistant is Android only',
              message:
                  'Reading alerts from other apps needs Android\'s notification listener, '
                  'which iOS does not provide. Nothing is being read on this device, and '
                  'NOVA never reads notification content it was not given access to.',
            )
          : Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          NotificationDisclosure(state: state, controller: controller),
          const SizedBox(height: NovaSpace.lg),

          if (state.error != null) ...[
            NotificationErrorBanner(message: state.error!),
            const SizedBox(height: NovaSpace.md),
          ],

          // ── Step 1: Notification Access ────────────────────────────────
          const NovaSectionHeader(title: 'Step 1 · Notification access'),
          const SizedBox(height: NovaSpace.xs),
          NotificationAccessCard(state: state, controller: controller),
          const SizedBox(height: NovaSpace.lg),

          // ── Step 2: the master toggle ──────────────────────────────────
          const NovaSectionHeader(title: 'Step 2 · Turn it on'),
          const SizedBox(height: NovaSpace.xs),
          NotificationMasterCard(state: state, controller: controller),
          const SizedBox(height: NovaSpace.lg),

          // ── Rules ──────────────────────────────────────────────────────
          const NovaSectionHeader(title: 'Rules'),
          const SizedBox(height: NovaSpace.xs),
          NotificationRulesCard(state: state, controller: controller),
          const SizedBox(height: NovaSpace.lg),

          // ── Apps ───────────────────────────────────────────────────────
          const NovaSectionHeader(title: 'Apps allowed'),
          const SizedBox(height: NovaSpace.xs),
          const NotificationAppList(),
          const SizedBox(height: NovaSpace.lg),

          // ── In memory only ─────────────────────────────────────────────
          const NovaSectionHeader(title: 'Summaries (this session only)'),
          const SizedBox(height: NovaSpace.xs),
          NotificationInboxCard(
            state: state,
            controller: controller,
            readAloud: _readAloud,
          ),
          const SizedBox(height: NovaSpace.xl),
        ],
      ),
    );
  }

  /// §9.3/§9.5 read-aloud: an opt-in plus a confirmation *per session*.
  ///
  /// The first call reports [SpeakOutcome.confirmationRequired]; only after the
  /// user confirms in the dialog does anything reach the speaker.
  Future<void> _readAloud(UntrustedNotificationData data) async {
    final controller = ref.read(notificationAssistantProvider.notifier);

    var outcome = await controller.speak(data);
    if (outcome == SpeakOutcome.confirmationRequired) {
      if (!mounted) return;
      final confirmed = await _confirmReadAloud(data);
      if (confirmed != true) return;
      outcome = await controller.speak(data, sessionConfirmed: true);
    }
    if (!mounted) return;

    final message = switch (outcome) {
      SpeakOutcome.spoken => 'Reading it aloud now.',
      SpeakOutcome.notOptedIn =>
        'Read-aloud is off. Turn on "Read summaries aloud" first.',
      SpeakOutcome.blockedByGuard =>
        'Blocked: NOVA does not read codes, passwords or bank alerts aloud.',
      SpeakOutcome.confirmationRequired => 'Confirmation was not given.',
      SpeakOutcome.empty => 'There is nothing to read.',
    };
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        backgroundColor: context.nova.surfaceRaised,
        content: Text(message, style: TextStyle(color: context.nova.fg)),
      ),
    );
  }

  Future<bool?> _confirmReadAloud(UntrustedNotificationData data) {
    final c = context.nova;
    return showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: c.surface,
        title: Text('Read this aloud?', style: NovaTheme.sectionHeading(c)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'NOVA will speak this once, now, using the on-device voice. '
              'Permission lasts until you leave this screen or change a '
              'setting.',
              style: Theme.of(
                dialogContext,
              ).textTheme.bodySmall!.copyWith(color: c.muted),
            ),
            const SizedBox(height: NovaSpace.sm),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(NovaSpace.sm),
              decoration: BoxDecoration(
                color: c.surfaceRaised,
                borderRadius: NovaRadius.rControl,
                border: Border.all(color: c.border),
              ),
              child: Text(
                data.preview,
                style: Theme.of(dialogContext).textTheme.bodyMedium,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text('Cancel', style: TextStyle(color: c.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('Read aloud', style: TextStyle(color: c.accent)),
          ),
        ],
      ),
    );
  }
}
