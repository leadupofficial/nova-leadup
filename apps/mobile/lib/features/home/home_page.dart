import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../notifications/nova_notifications_sheet.dart';
import '../../core/voice/voice_realtime_controller.dart';
import '../../core/voice/wake_word_controller.dart';
import '../../services/health_service.dart';
import '../auth/auth_controller.dart';
import '../reminders/notifications_blocked_notice.dart';
import '../reminders/reminder_sync.dart';

/// Re-checks backend reachability. Invalidated by the refresh action below.
final backendHealthProvider = FutureProvider<HealthCheckResult>(
  (ref) => ref.watch(healthServiceWithTimeoutProvider).check(),
);

/// Home dashboard — a port of the export's `home/home.html`.
///
/// Layout, in the order the design specifies:
///   `.top-bar` (menu / notification bell with badge / settings)
///   `.greeting` + `.name` + `.date`
///   `.avatar-container` with the `.avatar-status` pill
///   `.cta-primary`  "Tap to talk"  +  `or say "<installed wake word>"`
///   `.overview` with three `.stat-card`s
///
/// The previous version was a plain `ListView` of "Hi {name}", a gradient circle
/// and two status cards — none of the designed structure. It also showed no real
/// counts; the three stat cards below are wired to the tasks/memories/reminders
/// endpoints, which are genuinely DB-backed.
class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  /// "Today's Overview" — the three stat cards. Public so the layout test can
  /// assert this row and the floating overlay's sentence do not overlap.
  static const Key overviewRowKey = Key('home-overview-row');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final auth = ref.watch(authStateProvider);
    final avatar = ref.watch(avatarStateProvider);
    final wakeWord = ref.watch(wakeWordStateProvider);
    final health = ref.watch(backendHealthProvider);
    final overview = ref.watch(homeOverviewProvider);
    // The saved avatar appearance; the defaults hold until it resolves.
    final avatarPrefs = ref.watch(avatarPrefsProvider).asData?.value;
    // Whether a voice turn is actually in flight. This — not the wake word being
    // armed — is what may spend a continuous frame budget on this screen. The
    // armed state is permanent by design (that is the product), so treating it as
    // "live" pinned a core and rendered 61 fps on an idle Home screen (measured
    // on the OnePlus 9R at ~113 % of one core).
    final turnActive = ref.watch(voiceRealtimeProvider).isTurnActive;

    final name = auth.user?.displayName ?? 'there';

    return NovaScaffold(
      topBar: Row(
        children: [
          NovaIconButton(
            icon: Icons.menu_rounded,
            tooltip: 'Menu',
            onTap: () => _showMenu(context, ref),
          ),
          const Spacer(),
          NovaIconButton(
            icon: Icons.notifications_none_rounded,
            tooltip: 'Notifications',
            // The real unread count. A hardcoded `0` sat here while the server
            // held the true number, so the badge could never tell the user
            // anything — and the bell went to Profile rather than to the nudges.
            badge: _unreadBadge(ref.watch(unreadNotificationCountProvider)),
            onTap: () => showNovaNotificationsSheet(context),
          ),
          const SizedBox(width: 8),
          NovaIconButton(
            icon: Icons.settings_outlined,
            tooltip: 'Settings',
            onTap: () => context.go('/me'),
          ),
        ],
      ),
      refresh: () async {
        ref.invalidate(backendHealthProvider);
        ref.invalidate(homeOverviewProvider);
        await ref.read(wakeWordStateProvider.notifier).arm();
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_greeting(), style: NovaTheme.greeting(c)),
          const SizedBox(height: 4),
          Text(name, style: NovaTheme.heroName(c)),
          const SizedBox(height: 4),
          Text(_today(), style: NovaTheme.dateLine(c)),
          const SizedBox(height: 28),

          NovaAvatarHeroCard(
            state: _avatarFaceState(avatar, wakeWord),
            emotion: avatarPrefs?.emotion ?? 'neutral',
            animationDensity: NovaAvatarDensity.parse(
              avatarPrefs?.animationDensity,
            ),
            statusLabel: _statusLabel(avatar, wakeWord),
            statusTone: _statusTone(avatar, health, c),
            // The expression still says what the wake word is doing (the status
            // pill); only the motion is tied to a real turn.
            animate: turnActive,
            onTap: () => context.go('/converse'),
          ),
          const SizedBox(height: 20),

          NovaPrimaryButton(
            label: 'Tap to talk',
            icon: Icons.mic_none_rounded,
            onPressed: () => context.go('/converse'),
          ),
          const SizedBox(height: 14),
          Center(
            child: Text(
              // The phrase comes from the installed wake word the native service
              // reports, never from a hardcoded product name: this build listens
              // for `hey_nova`.
              _wakeWordLine(wakeWord),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
          const SizedBox(height: 32),

          Text("Today's Overview", style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: 16),
          overview.when(
            loading: () => const _OverviewSkeleton(),
            error: (e, _) => NovaStateView(
              icon: Icons.cloud_off_rounded,
              tone: NovaStateTone.error,
              title: 'Could not load your overview',
              message: _describe(e),
              actionLabel: 'Retry',
              onAction: () => ref.invalidate(homeOverviewProvider),
            ),
            data: (data) => Row(
              // The handle the layout test uses to prove the floating overlay's
              // sentence no longer lands on these cards.
              key: HomePage.overviewRowKey,
              children: [
                Expanded(
                  child: NovaStatCard(
                    icon: '🗓',
                    value: '${data.reminders}',
                    label: 'Reminders',
                    onTap: () => context.go('/tasks'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: NovaStatCard(
                    icon: '✅',
                    value: '${data.openTasks}',
                    label: 'Tasks',
                    onTap: () => context.go('/tasks'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: NovaStatCard(
                    icon: '💭',
                    value: '${data.memories}',
                    label: 'Memories',
                    onTap: () => context.go('/memory'),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 32),

          Text('Status', style: NovaTheme.sectionHeading(c)),
          const SizedBox(height: 12),
          _StatusCard(wakeWord: wakeWord),
          // A denied POST_NOTIFICATIONS means every reminder the reconciler arms
          // is discarded by Android at post time. Nothing else on this screen would
          // say so — the reconciler still reports `scheduled: N`.
          const _NotificationsStatusCard(),
          const SizedBox(height: 12),
          _BackendCard(health: health),
        ],
      ),
    );
  }

  String _greeting() {
    final h = DateTime.now().hour;
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  String _today() {
    const days = [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    final now = DateTime.now();
    return '${days[now.weekday - 1]}, ${months[now.month - 1]} ${now.day}';
  }

  /// The rig state for the hero card: the shared [avatarStateProvider], lifted
  /// to the wake-word "listening" face while the wake word is armed, and
  /// `warning` when that provider itself failed.
  /// The badge is hidden at zero rather than drawn as `0`, which is what the
  /// hardcoded value read as — a count of nothing that looked like a count.
  String? _unreadBadge(AsyncValue<int> count) {
    final value = count.asData?.value ?? 0;
    return value > 0 ? '$value' : null;
  }

  NovaAvatarFaceState _avatarFaceState(
    AsyncValue<AvatarState> avatar,
    WakeWordState wakeWord,
  ) {
    if (wakeWord.listening) return NovaAvatarFaceState.listening;
    return switch (avatar) {
      AsyncData(:final value) => faceStateForAvatar(value),
      AsyncError() => NovaAvatarFaceState.warning,
      _ => NovaAvatarFaceState.idle,
    };
  }

  /// The line under "Tap to talk".
  ///
  /// When the native service reports no installed wake word there is no phrase
  /// to name, so this says listening is off rather than advertising one.
  String _wakeWordLine(WakeWordState wakeWord) {
    final phrase = wakeWord.phrase;
    if (phrase == null) return 'Wake word is off';
    if (wakeWord.enabled && wakeWord.listening) {
      return 'Listening for "$phrase"';
    }
    return 'or say "$phrase"';
  }

  String _statusLabel(AsyncValue<AvatarState> avatar, WakeWordState wakeWord) {    if (wakeWord.listening) return NovaAvatarState.listening.label;
    return switch (avatar) {
      AsyncData(:final value) => switch (value) {
        AvatarState.idle => NovaAvatarState.idle.label,
        AvatarState.listening => NovaAvatarState.listening.label,
        AvatarState.thinking => NovaAvatarState.thinking.label,
        AvatarState.speaking => NovaAvatarState.speaking.label,
        AvatarState.sleeping => 'Resting',
        AvatarState.alert => 'Needs attention',
      },
      AsyncError() => 'Something went wrong',
      _ => 'Getting ready…',
    };
  }

  Color _statusTone(
    AsyncValue<AvatarState> avatar,
    AsyncValue<HealthCheckResult> health,
    NovaColors c,
  ) {
    if (health.hasError) return c.danger;
    if (avatar is AsyncError) return c.danger;
    if (avatar is AsyncData && avatar.value == AvatarState.alert) {
      return c.warning;
    }
    return c.success;
  }

  void _showMenu(BuildContext context, WidgetRef ref) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Theme.of(context).bottomSheetTheme.backgroundColor,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.auto_awesome_rounded),
              title: const Text('Memory'),
              onTap: () {
                Navigator.pop(sheetContext);
                context.go('/memory');
              },
            ),
            ListTile(
              leading: const Icon(Icons.check_circle_outline_rounded),
              title: const Text('Tasks & reminders'),
              onTap: () {
                Navigator.pop(sheetContext);
                context.go('/tasks');
              },
            ),
            ListTile(
              leading: const Icon(Icons.person_outline_rounded),
              title: const Text('Profile & settings'),
              onTap: () {
                Navigator.pop(sheetContext);
                context.go('/me');
              },
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.logout_rounded),
              title: const Text('Sign out'),
              onTap: () {
                Navigator.pop(sheetContext);
                ref.read(authStateProvider.notifier).logout();
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// Placeholder cards while the overview loads, sized like the real ones so the
/// layout does not jump.
class _OverviewSkeleton extends StatelessWidget {
  const _OverviewSkeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Row(
      children: List.generate(3, (i) {
        return Expanded(
          child: Padding(
            padding: EdgeInsets.only(right: i == 2 ? 0 : 10),
            child: Container(
              height: 92,
              decoration: BoxDecoration(
                color: c.surface,
                borderRadius: NovaRadius.rCard,
                border: Border.all(color: c.border),
              ),
              child: Center(
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.muted,
                  ),
                ),
              ),
            ),
          ),
        );
      }),
    );
  }
}

class _StatusCard extends ConsumerWidget {
  const _StatusCard({required this.wakeWord});

  final WakeWordState wakeWord;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final controller = ref.read(wakeWordStateProvider.notifier);
    // The row below is a *status* row: while the wake word is merely armed (its
    // normal state) it must not drive 60 fps. It waves only during a real turn.
    final turnActive = ref.watch(voiceRealtimeProvider).isTurnActive;
    final availability = wakeWord.availability;
    final supported = availability?.available ?? false;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.hearing_rounded, color: c.accent, size: 20),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Wake word',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (wakeWord.busy)
                SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.accent,
                  ),
                )
              else
                Switch(
                  value: wakeWord.enabled,
                  onChanged: supported ? controller.setEnabled : null,
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            // What the wake word is doing *now*. `availability.userMessage` describes
            // availability only — it cannot see the user's toggle or the native
            // service — so on its own it announced "Listening for <model>" on a device
            // where the wake word had never been switched on. `statusMessage` keeps the
            // native reason for a real failure and names the phrase humanised, the way
            // every other surface does.
            wakeWord.statusMessage,
            // Keyed so a test can read this row without depending on how many other
            // surfaces happen to show the same phrase.
            key: const Key('wake-word-status'),
            style: Theme.of(context).textTheme.bodySmall,
          ),
          if (wakeWord.listening) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                NovaWaveform(
                  bars: 4,
                  height: 14,
                  color: c.success,
                  // A status row, not a live meter: while the wake word is merely
                  // armed this must not render 60 fps. It still waves during a
                  // real turn.
                  animate: turnActive,
                ),
                const SizedBox(width: 10),
                Text(
                  'Listening in the background',
                  style: NovaTheme.chip(c).copyWith(color: c.success),
                ),
              ],
            ),
          ],
          if (wakeWord.error != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: c.danger.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(NovaRadius.control),
                border: Border.all(color: c.danger.withValues(alpha: 0.4)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.error_outline, color: c.danger, size: 18),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      wakeWord.error!,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall!.copyWith(color: c.danger),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// "Your reminders cannot reach you" — the reminders half of the Status card.
///
/// This is the same warning the reminders screen shows
/// ([NotificationsBlockedNotice]), rendered here because Home is where the user
/// looks when a reminder did not arrive. It is driven by the reconcile result —
/// what the last pass actually read from the OS — so both surfaces tell one
/// story from one source, and a pass that has not run yet says nothing rather
/// than guessing.
///
/// Nothing is shown on iOS (`osPermissionGranted` answers `true` there, so the
/// result can never be blocked), nor when the OS is posting notifications
/// normally. An earlier version of this defect had *no copy anywhere* that named
/// the blocked permission; the point of the card is that it is impossible to miss
/// and says which switch fixes it.
class _NotificationsStatusCard extends ConsumerWidget {
  const _NotificationsStatusCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ref.watch(reminderSyncProvider).lastResult;
    if (result == null || !result.notificationsBlocked) {
      return const SizedBox.shrink();
    }
    return const NotificationsBlockedNotice(
      title: 'Reminders cannot reach you',
      margin: EdgeInsets.only(top: 12),
    );
  }
}

class _BackendCard extends ConsumerWidget {
  const _BackendCard({required this.health});

  final AsyncValue<HealthCheckResult> health;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;

    return health.when(
      loading: () => const NovaCard(
        child: Row(
          children: [
            SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 12),
            Text('Checking connection…'),
          ],
        ),
      ),
      error: (e, _) => NovaCard(
        child: Row(
          children: [
            Icon(Icons.cloud_off_rounded, color: c.danger, size: 20),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Not reachable',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 2),
                  Text('${e.runtimeType}', style: NovaTheme.msgLabel(c)),
                ],
              ),
            ),
            NovaIconButton(
              icon: Icons.refresh_rounded,
              size: 36,
              onTap: () => ref.invalidate(backendHealthProvider),
            ),
          ],
        ),
      ),
      data: (result) {
        final ok = result.healthy;
        return NovaCard(
          child: Row(
            children: [
              Icon(
                ok ? Icons.check_circle_rounded : Icons.error_outline_rounded,
                color: ok ? c.success : c.danger,
                size: 20,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      ok ? 'Connected' : 'Not reachable',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 2),
                    Text(result.endpoint, style: NovaTheme.msgLabel(c)),
                  ],
                ),
              ),
              NovaIconButton(
                icon: Icons.refresh_rounded,
                size: 36,
                onTap: () => ref.invalidate(backendHealthProvider),
              ),
            ],
          ),
        );
      },
    );
  }
}

String _describe(Object error) {
  final message = error.toString();
  if (message.contains('401')) {
    return 'Your session expired. Sign out and back in.';
  }
  return message.length > 160 ? '${message.substring(0, 157)}…' : message;
}
