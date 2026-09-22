import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;
import '../briefing/briefing_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../../app/providers.dart';
import '../auth/auth_controller.dart';
import '../reminders/notification_delivery_cache.dart';
import '../reminders/reminder_sync.dart';

/// Profile & settings — port of `settings/profile.html`, `settings/privacy.html`
/// and `settings/integrations.html`.
///
/// Every switch here writes to a real endpoint
/// (`/api/v1/settings/{profile,preferences,privacy,persona}`) and the sheet stays
/// open with a saving indicator until the server confirms, so the UI never shows
/// a state the backend did not accept.
class MePage extends ConsumerWidget {
  const MePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final profile = ref.watch(profileProvider);
    final persona = ref.watch(personaProvider);

    return NovaScaffold(
      topBar: Row(
        children: [
          Expanded(child: Text('Profile', style: NovaTheme.heroName(c))),
          NovaIconButton(
            icon: Icons.logout_rounded,
            tooltip: 'Sign out',
            onTap: () => ref.read(authStateProvider.notifier).logout(),
          ),
        ],
      ),
      refresh: () async {
        ref.invalidate(profileProvider);
        ref.invalidate(personaProvider);
        ref.invalidate(notificationPrefsProvider);
        ref.invalidate(privacyPrefsProvider);
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── Identity ──────────────────────────────────────────────────────
          profile.when(
            loading: () => const NovaCard(
              child: SizedBox(
                height: 56,
                child: Center(child: CircularProgressIndicator()),
              ),
            ),
            error: (e, _) => NovaStateView(
              icon: Icons.cloud_off_rounded,
              tone: NovaStateTone.error,
              title: 'Could not load your profile',
              message: e.toString().replaceFirst(
                RegExp(r'^NovaApiException\(\d*\): '),
                '',
              ),
              actionLabel: 'Retry',
              onAction: () => ref.invalidate(profileProvider),
            ),
            data: (p) => NovaCard(
              child: Row(
                children: [
                  Container(
                    width: 52,
                    height: 52,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      gradient: c.accentGradient,
                      shape: BoxShape.circle,
                    ),
                    child: Text(
                      p.displayName.characters.first.toUpperCase(),
                      style: NovaTheme.heroName(
                        c,
                      ).copyWith(color: c.onAccent, fontSize: 22),
                    ),
                  ),
                  const SizedBox(width: NovaSpace.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          p.displayName,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 2),
                        Text(p.email, style: NovaTheme.msgLabel(c)),
                        // A "Verify email" pill used to render here whenever
                        // `emailVerified` was false — which was *every* account, since
                        // registration defaults it to false — with no way to verify.
                        // `services/api` exposes no verify-email or resend route
                        // (`routes/auth.ts` has login/register/refresh/logout/me only),
                        // so the pill promised an action that did not exist and could
                        // never be cleared. It is removed until the flow does; the
                        // account is fully usable without it, because nothing in the
                        // product gates on the flag.
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: NovaSpace.lg),

          // ── Companion ─────────────────────────────────────────────────────
          const NovaSectionHeader(title: 'Companion'),
          const SizedBox(height: NovaSpace.xs),
          NovaCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                persona.when(
                  loading: () => const ListTile(title: Text('Loading…')),
                  error: (e, _) => NovaListRow(
                    title: 'Companion name',
                    subtitle: 'Could not load — tap to retry',
                    icon: Icons.error_outline_rounded,
                    iconTone: c.danger,
                    onTap: () => ref.invalidate(personaProvider),
                  ),
                  data: (p) => NovaListRow(
                    title: p.name,
                    subtitle: 'Name, personality and speech style',
                    icon: Icons.auto_awesome_rounded,
                    onTap: () => _editPersona(context, ref, p),
                  ),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Avatar & appearance',
                  subtitle: 'Expression and animation density',
                  icon: Icons.face_retouching_natural_rounded,
                  onTap: () => _editAvatar(context, ref),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Wake word listening',
                  // Not "Say \"Hey Nova\"": no build ships a "hey nova"
                  // classifier, so naming that phrase here would advertise a
                  // wake word the microphone cannot hear. The exact installed
                  // phrase is on the wake-word screen.
                  subtitle: 'On-device listening, and the last phrase heard',
                  icon: Icons.hearing_rounded,
                  onTap: () => context.push('/wakeword'),
                ),
              ],
            ),
          ),
          const SizedBox(height: NovaSpace.lg),

          // ── Privacy & data ────────────────────────────────────────────────
          const NovaSectionHeader(title: 'Privacy & data'),
          const SizedBox(height: NovaSpace.xs),
          NovaCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                NovaListRow(
                  title: 'Privacy controls',
                  subtitle: 'What NOVA saves, and for how long',
                  icon: Icons.lock_outline_rounded,
                  onTap: () => _editPrivacy(context, ref),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Notifications',
                  subtitle: 'Reminders, nudges and briefings',
                  icon: Icons.notifications_none_rounded,
                  onTap: () => _editNotifications(context, ref),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Notification assistant',
                  // Reading the notification shade needs Android's notification
                  // listener. Saying "Read selected notifications" on iOS described a
                  // capability the build does not have; the row still leads to the
                  // screen, which now states the limit itself.
                  subtitle: defaultTargetPlatform == TargetPlatform.android
                      ? 'Read selected notifications — off by default'
                      : 'Android only — not available on this device',
                  icon: Icons.notifications_active_outlined,
                  onTap: () => context.push('/me/notifications'),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Daily briefing',
                  subtitle: 'Spoken summary of your day — off by default',
                  icon: Icons.wb_sunny_outlined,
                  onTap: () => context.push('/me/briefing'),
                ),
                Divider(height: 1, color: c.border),
                // Wake word (requirement 2, §5.16). The phrase is enforced by
                // the classifiers installed in the app bundle, so this row leads
                // to the screen that names the one that is actually installed —
                // today a single model, which that screen states plainly.
                NovaListRow(
                  title: 'Wake word',
                  subtitle: 'Which installed phrase NOVA listens for',
                  icon: Icons.record_voice_over_outlined,
                  onTap: () => context.push('/me/wake-word'),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Device control',
                  subtitle: 'Apps, dialler, media, brightness and DND',
                  icon: Icons.phonelink_setup_outlined,
                  onTap: () => context.push('/me/device-control'),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Call recordings',
                  subtitle: 'Summarise recordings your dialer already saved',
                  icon: Icons.voicemail_outlined,
                  onTap: () => context.push('/me/call-recordings'),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Integrations',
                  subtitle: 'Connected services and available tools',
                  icon: Icons.extension_outlined,
                  onTap: () => context.push('/me/integrations'),
                ),
              ],
            ),
          ),
          const SizedBox(height: NovaSpace.lg),

          // ── Account ───────────────────────────────────────────────────────
          const NovaSectionHeader(title: 'Account'),
          const SizedBox(height: NovaSpace.xs),
          NovaCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                NovaListRow(
                  title: 'Admin console',
                  subtitle: 'Users, audit log and system health',
                  icon: Icons.admin_panel_settings_outlined,
                  onTap: () => context.push('/admin'),
                ),
                Divider(height: 1, color: c.border),
                // Both rows below are store requirements, not conveniences:
                // App Review 5.1.1(i) / Play's User Data policy require the privacy
                // policy to be readable in-app, and App Review 5.1.1(v) / Play's
                // account-deletion requirement require an in-app deletion path for an
                // account created in the app. They sit together so a reviewer finds
                // both in one place.
                NovaListRow(
                  title: 'Privacy policy',
                  subtitle: 'What NOVA collects and who processes it',
                  icon: Icons.privacy_tip_outlined,
                  // Full path: these routes are children of `/me`, so a bare
                  // `/privacy-policy` matches nothing and renders go_router's
                  // "No screen matches" error page. Verified on a device.
                  onTap: () => context.push('/me/privacy-policy'),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Delete account',
                  subtitle: 'Permanently remove your account and its data',
                  icon: Icons.delete_forever_outlined,
                  iconTone: c.danger,
                  onTap: () => context.push('/me/delete-account'),
                ),
                Divider(height: 1, color: c.border),
                NovaListRow(
                  title: 'Sign out',
                  subtitle: 'Ends this session on this device',
                  icon: Icons.logout_rounded,
                  iconTone: c.danger,
                  trailing: const SizedBox.shrink(),
                  onTap: () async {
                    final confirmed = await showDialog<bool>(
                      context: context,
                      builder: (ctx) => AlertDialog(
                        icon: Icon(Icons.logout_rounded, color: c.danger),
                        title: const Text('Sign out?'),
                        content: const Text(
                          'You will need to sign in again to use NOVA on this device.',
                        ),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.of(ctx).pop(false),
                            child: const Text('Cancel'),
                          ),
                          TextButton(
                            onPressed: () => Navigator.of(ctx).pop(true),
                            child: Text(
                              'Sign out',
                              style: TextStyle(color: c.danger),
                            ),
                          ),
                        ],
                      ),
                    );
                    if (confirmed == true) {
                      await ref.read(authStateProvider.notifier).logout();
                    }
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// "Avatar & Appearance" from `settings/profile.html`.
  ///
  /// The avatars table stores an expression plus an animation density; the
  /// route upserts, so this both creates and edits. It previously accepted
  /// name/avatarUrl/isActive and discarded them, which is why nothing was
  /// wired to it before.
  static Future<void> _editAvatar(BuildContext context, WidgetRef ref) async {
    final current = await ref.read(avatarPrefsProvider.future);
    if (!context.mounted) return;

    var emotion = current.emotion;
    var density = current.animationDensity;
    var saving = false;
    String? error;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) {
          final c = sheetContext.nova;
          Future<void> save() async {
            setSheetState(() {
              saving = true;
              error = null;
            });
            try {
              await ref
                  .read(novaMutationsProvider)
                  .saveAvatar(
                    current.copyWith(
                      emotion: emotion,
                      animationDensity: density,
                    ),
                  );
              if (sheetContext.mounted) Navigator.pop(sheetContext);
            } catch (e) {
              if (!sheetContext.mounted) return;
              setSheetState(() {
                saving = false;
                error = e.toString();
              });
            }
          }

          return Padding(
            padding: EdgeInsets.only(
              left: NovaSpace.gutter,
              right: NovaSpace.gutter,
              top: NovaSpace.lg,
              bottom: MediaQuery.viewInsetsOf(sheetContext).bottom + NovaSpace.lg,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Avatar & appearance',
                  style: NovaTheme.sectionHeading(c),
                ),
                const SizedBox(height: NovaSpace.md),
                Text('Expression', style: NovaTheme.overline(c)),
                const SizedBox(height: NovaSpace.xs),
                Wrap(
                  spacing: NovaSpace.xs,
                  runSpacing: NovaSpace.xs,
                  children: [
                    for (final option in NovaAvatarPrefs.emotions)
                      _AvatarChoice(
                        label: option,
                        selected: emotion == option,
                        onTap: saving
                            ? null
                            : () => setSheetState(() => emotion = option),
                      ),
                  ],
                ),
                const SizedBox(height: NovaSpace.md),
                Text('Animation density', style: NovaTheme.overline(c)),
                const SizedBox(height: NovaSpace.xs),
                Wrap(
                  spacing: NovaSpace.xs,
                  runSpacing: NovaSpace.xs,
                  children: [
                    for (final option in NovaAvatarPrefs.densities)
                      _AvatarChoice(
                        label: option,
                        selected: density == option,
                        onTap: saving
                            ? null
                            : () => setSheetState(() => density = option),
                      ),
                  ],
                ),
                if (error != null) ...[
                  const SizedBox(height: NovaSpace.sm),
                  Text(
                    error!,
                    style: Theme.of(
                      sheetContext,
                    ).textTheme.bodySmall!.copyWith(color: c.danger),
                  ),
                ],
                const SizedBox(height: NovaSpace.lg),
                NovaPrimaryButton(
                  label: 'Save',
                  busy: saving,
                  onPressed: saving ? null : save,
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  static Future<void> _editPrivacy(BuildContext context, WidgetRef ref) async {
    final current = await ref.read(privacyPrefsProvider.future);
    if (!context.mounted) return;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => _ToggleSheet<NovaPrivacyPrefs>(
        title: 'Privacy controls',
        initial: current,
        toggles: [
          _Toggle('saveConversations', '💬', 'Save conversations',
              (p) => p.saveConversations),
          _Toggle('saveRecordings', '🎙', 'Save recordings',
              (p) => p.saveRecordings),
          _Toggle('saveTranscripts', '📝', 'Save transcripts',
              (p) => p.saveTranscripts),
          _Toggle('saveMemories', '💭', 'Save memories',
              (p) => p.saveMemories),
          // Both of these are refused by the API and shown here as unavailable, for
          // the same reason: this build has no on-device speech-to-text or language
          // model, so turning cloud processing off, or on-device processing on, would
          // change nothing about where the audio goes. A privacy switch that cannot be
          // honoured is worse than no switch, because the user believes it.
          _Toggle('cloudProcessing', '☁️', 'Cloud processing',
              (p) => p.cloudProcessing,
              unavailableReason:
                  'Required — NOVA transcribes and answers on its servers. Use "Save recordings" and "Save transcripts" to control what is kept.'),
          _Toggle('localProcessing', '📱', 'On-device processing',
              (p) => p.localProcessing,
              unavailableReason:
                  'Not available in this build — there is no on-device model yet.'),
        ],
        apply: (p, key, value) => switch (key) {
          'saveConversations' => p.copyWith(saveConversations: value),
          'saveRecordings' => p.copyWith(saveRecordings: value),
          'saveTranscripts' => p.copyWith(saveTranscripts: value),
          'saveMemories' => p.copyWith(saveMemories: value),
          'cloudProcessing' => p.copyWith(cloudProcessing: value),
          'localProcessing' => p.copyWith(localProcessing: value),
          _ => p,
        },
        // `settings/privacy.html` also has an Auto-delete section. Both fields
        // are supported by the API and the model but were never exposed, so a
        // supported privacy control was unreachable.
        extras: (p, update) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: NovaSpace.sm),
            Divider(height: 1, color: context.nova.border),
            const SizedBox(height: NovaSpace.md),
            Text('Auto-delete', style: NovaTheme.sectionHeading(context.nova)),
            const SizedBox(height: NovaSpace.sm),
            _RetentionRow(
              label: 'Delete recordings after',
              choices: const [30, 60, 90],
              value: p.autoDeleteRecordingsDays,
              onChanged: (days) => update(
                days == null
                    ? p.copyWith(clearAutoDeleteRecordingsDays: true)
                    : p.copyWith(autoDeleteRecordingsDays: days),
              ),
            ),
            const SizedBox(height: NovaSpace.sm),
            _RetentionRow(
              label: 'Delete transcripts after',
              choices: const [7, 30, 90],
              value: p.autoDeleteTranscriptsDays,
              onChanged: (days) => update(
                days == null
                    ? p.copyWith(clearAutoDeleteTranscriptsDays: true)
                    : p.copyWith(autoDeleteTranscriptsDays: days),
              ),
            ),
          ],
        ),
        save: (p) => ref.read(novaMutationsProvider).savePrivacy(p),
      ),
    );
  }

  static Future<void> _editNotifications(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final current = await ref.read(notificationPrefsProvider.future);
    if (!context.mounted) return;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => _ToggleSheet<NovaNotificationPrefs>(
        title: 'Notifications',
        initial: current,
        // Field names verified against GET /api/v1/settings/preferences, which
        // nests these under `notifications`.
        //
        // Only the two channels the app can actually deliver are offered here.
        // `email` and `sms` were rendered as working switches, but there is no mail
        // or SMS provider anywhere in the monorepo — no nodemailer/SendGrid/Twilio
        // dependency, and the only SMS code is an unreferenced stub in
        // `services/notifications`. A user could turn "SMS notifications" on and
        // nothing would ever be sent, which is a false capability claim under Play's
        // Deceptive Behavior policy and App Review 2.3.1(a). `push` is relabelled:
        // there is no `firebase_messaging` and no device-token registration, so what
        // actually delivers a reminder is a *local* scheduled notification.
        // The two fields still round-trip through the preferences API untouched.
        toggles: [
          _Toggle('push', '🔔', 'Device notifications', (p) => p.push),
          _Toggle('inApp', '📱', 'In-app notifications', (p) => p.inApp),
        ],
        // Both switches are now the real gate: turning them off writes the local value
        // the reminder and briefing reconcilers read, so it cancels the alarms already
        // armed rather than only affecting reminders created afterwards. Reminder
        // delivery itself is a local alarm, so the device's notification permission
        // still has to be granted for anything to appear at all.
        note:
            'Turning both off stops reminders and the daily briefing on this device. '
            'They still need your notification permission in system settings to appear '
            'at all. Email and SMS alerts are not available, so they are not offered '
            'here.',
        apply: (p, key, value) => switch (key) {
          'push' => p.copyWith(push: value),
          'inApp' => p.copyWith(inApp: value),
          _ => p,
        },
        save: (p) async {
          await ref.read(novaMutationsProvider).saveNotificationPrefs(p);
          // Mirror the choice locally, because the reminder reconciler arms a *local*
          // alarm and cannot await a network round trip to decide whether to cancel
          // one. Without this the switches stored a preference that changed nothing.
          await cacheNotificationDelivery(
            ref.read(sharedPreferencesProvider),
            push: p.push,
            inApp: p.inApp,
          );
          // The gate caches its answer for the session, so it has to be told the answer
          // changed — otherwise the reconcilers keep reading the old value and a switch
          // turned off here would not cancel anything until a restart.
          ref.invalidate(notificationDeliveryEnabledProvider);
          // Re-run reconciliation so turning delivery off cancels what is already
          // armed rather than only affecting reminders created afterwards.
          //
          // Both reconcilers, not just the reminder one. The daily briefing is armed by
          // `BriefingReconciler` from `DailyBriefingController`, and the note on this
          // sheet promises that turning both switches off "stops reminders and the daily
          // briefing on this device". Nothing invalidated the briefing controller, so an
          // armed briefing went on firing every morning — across restarts and sign-outs —
          // until the user happened to open the Daily briefing screen. The promise and
          // the code disagreed, and the promise was the one users read.
          ref.invalidate(reminderSyncProvider);
          ref.invalidate(dailyBriefingProvider);
        },
      ),
    );
  }

  static Future<void> _editPersona(
    BuildContext context,
    WidgetRef ref,
    NovaPersona persona,
  ) async {
    final c = context.nova;
    final controller = TextEditingController(text: persona.name);
    // `personality` is the API field; there is no `tone`.
    var personality = persona.personality;
    var voiceSpeed = persona.voiceSpeed;
    var languagePolicy = persona.languagePolicy;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) => Padding(
          padding: EdgeInsets.only(
            left: NovaSpace.gutter,
            right: NovaSpace.gutter,
            top: NovaSpace.lg,
            bottom: MediaQuery.viewInsetsOf(sheetContext).bottom + NovaSpace.lg,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Companion', style: NovaTheme.sectionHeading(c)),
              const SizedBox(height: NovaSpace.md),
              NovaTextField(
                controller: controller,
                label: 'Name',
                hint: 'Nova',
              ),
              const SizedBox(height: NovaSpace.md),
              Text('Personality', style: NovaTheme.overline(c)),
              const SizedBox(height: NovaSpace.xs),
              Wrap(
                spacing: NovaSpace.xs,
                children: ['friendly', 'professional', 'executive', 'companion']
                    .map(
                      (t) => NovaChip(
                        label: t,
                        selected: personality == t,
                        onTap: () => setSheetState(() => personality = t),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: NovaSpace.md),
              Text('Speech style', style: NovaTheme.overline(c)),
              const SizedBox(height: NovaSpace.xs),
              Wrap(
                spacing: NovaSpace.xs,
                children: const [
                  ('auto', 'Auto Tamil–English'),
                  ('ta', 'Tamil'),
                  ('en', 'English'),
                  ('tanglish', 'Tanglish'),
                ]
                    .map(
                      (e) => NovaChip(
                        label: e.$2,
                        selected: languagePolicy == e.$1,
                        onTap: () =>
                            setSheetState(() => languagePolicy = e.$1),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: NovaSpace.md),
              Text('Voice speed · $voiceSpeed%',
                  style: NovaTheme.overline(c)),
              Slider(
                value: voiceSpeed.toDouble(),
                min: 50,
                max: 200,
                divisions: 15,
                activeColor: c.accent,
                label: '$voiceSpeed%',
                onChanged: (v) =>
                    setSheetState(() => voiceSpeed = v.round()),
              ),
              NovaPrimaryButton(
                label: 'Save',
                onPressed: () async {
                  final updated = persona.copyWith(
                    name: controller.text.trim().isEmpty
                        ? 'Nova'
                        : controller.text.trim(),
                    personality: personality,
                    languagePolicy: languagePolicy,
                    voiceSpeed: voiceSpeed,
                  );
                  await ref.read(novaMutationsProvider).savePersona(updated);
                  if (sheetContext.mounted) Navigator.pop(sheetContext);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Declaration of one switch in a [_ToggleSheet].
class _Toggle<T> {
  const _Toggle(this.key, this.emoji, this.label, this.read, {this.unavailableReason});

  final String key;
  final String emoji;
  final String label;
  final bool Function(T) read;

  /// Set when the deployment cannot honour this preference at all.
  ///
  /// The switch renders disabled with this text instead of toggling, and the API
  /// refuses the same values with a 409 — both halves say the same thing, so the app
  /// cannot imply a privacy control it does not have. "On-device processing" claims the
  /// audio never leaves the phone, and "Cloud processing: off" claims the same, while
  /// every turn is still sent to a provider.
  final String? unavailableReason;
}

/// A generic settings sheet of switches that saves through [save].
///
/// Shows a spinner while the write is in flight and only closes on success, so a
/// failed save leaves the sheet open with the values the server rejected.
/// One chip in the avatar sheet.
class _AvatarChoice extends StatelessWidget {
  const _AvatarChoice({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Opacity(
        opacity: onTap == null ? 0.5 : 1,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? c.accent.withValues(alpha: 0.16) : c.surface,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: selected ? c.accent : c.border),
          ),
          child: Text(
            label,
            style: Theme.of(context).textTheme.bodySmall!.copyWith(
              color: selected ? c.accent : c.fg,
              fontWeight: selected ? NovaType.wSemiBold : NovaType.wRegular,
            ),
          ),
        ),
      ),
    );
  }
}

/// One `settings/privacy.html` auto-delete row: a label and a row of day
/// choices plus "Never". `null` means never auto-delete, which is how both the
/// model and the API represent it.
class _RetentionRow extends StatelessWidget {
  const _RetentionRow({
    required this.label,
    required this.choices,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final List<int> choices;
  final int? value;
  final ValueChanged<int?> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 6),
        Wrap(
          spacing: NovaSpace.xs,
          runSpacing: NovaSpace.xs,
          children: [
            for (final days in choices)
              _choice(context, '$days days', value == days, () => onChanged(days)),
            _choice(context, 'Never', value == null, () => onChanged(null)),
          ],
        ),
      ],
    );
  }

  Widget _choice(
    BuildContext context,
    String label,
    bool selected,
    VoidCallback onTap,
  ) {
    final c = context.nova;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? c.accent.withValues(alpha: 0.16) : c.surface,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? c.accent : c.border),
        ),
        child: Text(
          label,
          style: Theme.of(context).textTheme.bodySmall!.copyWith(
            color: selected ? c.accent : c.fg,
            fontWeight: selected ? NovaType.wSemiBold : NovaType.wRegular,
          ),
        ),
      ),
    );
  }
}

class _ToggleSheet<T> extends StatefulWidget {
  const _ToggleSheet({
    required this.title,
    required this.initial,
    required this.toggles,
    required this.apply,
    required this.save,
    this.extras,
    this.note,
  });

  final String title;
  final T initial;
  final List<_Toggle<T>> toggles;
  final T Function(T current, String key, bool value) apply;
  final Future<void> Function(T value) save;

  /// Optional line rendered under the toggles, for sheets that have to say what
  /// they deliberately do not offer.
  final String? note;

  /// Optional extra controls rendered under the toggles, for sheets that have
  /// more than booleans. Receives the current value and a setter.
  final Widget Function(T value, void Function(T value) update)? extras;

  @override
  State<_ToggleSheet<T>> createState() => _ToggleSheetState<T>();
}

class _ToggleSheetState<T> extends State<_ToggleSheet<T>> {
  late T _value = widget.initial;
  bool _saving = false;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return Padding(
      padding: EdgeInsets.only(
        left: NovaSpace.gutter,
        right: NovaSpace.gutter,
        top: NovaSpace.lg,
        bottom: MediaQuery.viewInsetsOf(context).bottom + NovaSpace.lg,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.title, style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: NovaSpace.md),
          ...widget.toggles.map((t) {
            final blocked = t.unavailableReason != null;
            return SwitchListTile(
              contentPadding: EdgeInsets.zero,
              secondary: Text(t.emoji, style: const TextStyle(fontSize: 18)),
              title: Text(t.label),
              // A switch the deployment cannot honour is disabled and says why, rather
              // than moving and changing nothing.
              subtitle: blocked
                  ? Text(
                      t.unavailableReason!,
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall!
                          .copyWith(color: c.muted, height: 1.35),
                    )
                  : null,
              value: blocked ? (t.key == 'cloudProcessing') : t.read(_value),
              onChanged: (_saving || blocked)
                  ? null
                  : (v) => setState(() => _value = widget.apply(_value, t.key, v)),
            );
          }),
          if (widget.note != null)
            Padding(
              padding: const EdgeInsets.only(top: NovaSpace.xs),
              child: Text(
                widget.note!,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.muted, height: 1.4),
              ),
            ),
          if (widget.extras != null)
            widget.extras!(
              _value,
              (v) => setState(() => _value = v),
            ),
          if (_error != null) ...[
            const SizedBox(height: NovaSpace.xs),
            Text(
              _error!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.danger),
            ),
          ],
          const SizedBox(height: NovaSpace.md),
          NovaPrimaryButton(
            label: 'Save changes',
            busy: _saving,
            onPressed: _saving ? null : _save,
          ),
        ],
      ),
    );
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.save(_value);
      if (mounted) Navigator.pop(context);
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
}
