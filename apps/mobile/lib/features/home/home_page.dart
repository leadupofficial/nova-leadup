import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../../core/voice/wake_word_controller.dart';
import '../../services/health_service.dart';
import '../auth/auth_controller.dart';

/// Re-checks backend reachability. Invalidated by the refresh action below.
final backendHealthProvider = FutureProvider<HealthCheckResult>(
  (ref) => ref.watch(healthServiceProvider).check(),
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
            badge: '0',
            onTap: () => context.go('/me'),
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
              // The phrase comes from the installed classifier the native
              // service reports, never from a hardcoded product name: this
              // build listens for `hey_jarvis`.
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
  /// When the native service reports no installed classifier there is no phrase
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
            availability == null
                ? 'Checking availability…'
                : availability.userMessage,
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
                  animate: true,
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
