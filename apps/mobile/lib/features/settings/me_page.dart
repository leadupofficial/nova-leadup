import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../auth/auth_controller.dart';

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
                        if (!p.emailVerified) ...[
                          const SizedBox(height: 6),
                          NovaStatusPill(
                            label: 'Verify email',
                            tone: c.warning,
                            animate: false,
                            icon: Icons.mark_email_unread_outlined,
                          ),
                        ],
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
                  title: 'Wake word',
                  subtitle: 'Say "Hey Nova" to start listening',
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
                NovaListRow(
                  title: 'Sign out',
                  subtitle: 'Ends this session on this device',
                  icon: Icons.logout_rounded,
                  iconTone: c.danger,
                  trailing: const SizedBox.shrink(),
                  onTap: () => ref.read(authStateProvider.notifier).logout(),
                ),
              ],
            ),
          ),
        ],
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
          _Toggle('cloudProcessing', '☁️', 'Cloud processing',
              (p) => p.cloudProcessing),
          _Toggle('localProcessing', '📱', 'On-device processing',
              (p) => p.localProcessing),
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
        toggles: [
          _Toggle('push', '🔔', 'Push notifications', (p) => p.push),
          _Toggle('inApp', '📱', 'In-app notifications', (p) => p.inApp),
          _Toggle('email', '✉️', 'Email notifications', (p) => p.email),
          _Toggle('sms', '💬', 'SMS notifications', (p) => p.sms),
        ],
        apply: (p, key, value) => switch (key) {
          'push' => p.copyWith(push: value),
          'inApp' => p.copyWith(inApp: value),
          'email' => p.copyWith(email: value),
          'sms' => p.copyWith(sms: value),
          _ => p,
        },
        save: (p) => ref.read(novaMutationsProvider).saveNotificationPrefs(p),
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
  const _Toggle(this.key, this.emoji, this.label, this.read);

  final String key;
  final String emoji;
  final String label;
  final bool Function(T) read;
}

/// A generic settings sheet of switches that saves through [save].
///
/// Shows a spinner while the write is in flight and only closes on success, so a
/// failed save leaves the sheet open with the values the server rejected.
class _ToggleSheet<T> extends StatefulWidget {
  const _ToggleSheet({
    required this.title,
    required this.initial,
    required this.toggles,
    required this.apply,
    required this.save,
  });

  final String title;
  final T initial;
  final List<_Toggle<T>> toggles;
  final T Function(T current, String key, bool value) apply;
  final Future<void> Function(T value) save;

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
            return SwitchListTile(
              contentPadding: EdgeInsets.zero,
              secondary: Text(t.emoji, style: const TextStyle(fontSize: 18)),
              title: Text(t.label),
              value: t.read(_value),
              onChanged: _saving
                  ? null
                  : (v) => setState(() => _value = widget.apply(_value, t.key, v)),
            );
          }),
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
