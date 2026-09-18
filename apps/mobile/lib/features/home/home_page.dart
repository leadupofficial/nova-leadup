import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/avatar/avatar_provider.dart';
import '../../core/theme/nova_theme.dart';
import '../../core/voice/wake_word_controller.dart';
import '../../services/health_service.dart';
import '../auth/auth_controller.dart';

/// Re-checks backend reachability. Invalidated by the refresh action below.
final backendHealthProvider = FutureProvider<HealthCheckResult>(
  (ref) => ref.watch(healthServiceProvider).check(),
);

class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authStateProvider);
    final avatar = ref.watch(avatarStateProvider);
    final wakeWord = ref.watch(wakeWordStateProvider);
    final health = ref.watch(backendHealthProvider);

    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('NOVA'),
        actions: [
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(authStateProvider.notifier).logout(),
          ),
        ],
      ),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(backendHealthProvider);
            await ref.read(wakeWordStateProvider.notifier).arm();
          },
          child: ListView(
            padding: const EdgeInsets.all(24),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              Text(
                'Hi ${auth.user?.displayName ?? 'there'}',
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
              ),
              const SizedBox(height: 4),
              Text(
                switch (avatar) {
                  AsyncData(:final value) => _avatarCaption(value),
                  AsyncError() => 'Something went wrong.',
                  _ => 'Getting ready...',
                },
                style: const TextStyle(color: NovaTheme.onSurfaceVariant),
              ),
              const SizedBox(height: 24),
              NovaAvatar(
                state: switch (avatar) {
                  AsyncData(:final value) => value,
                  _ => AvatarState.idle,
                },
                size: 160,
              ),
              const SizedBox(height: 32),
              _WakeWordCard(state: wakeWord),
              const SizedBox(height: 16),
              _BackendCard(health: health),
            ],
          ),
        ),
      ),
    );
  }

  String _avatarCaption(AvatarState state) {
    switch (state) {
      case AvatarState.idle:
        return 'Ready when you are.';
      case AvatarState.listening:
        return 'Listening...';
      case AvatarState.thinking:
        return 'Thinking...';
      case AvatarState.speaking:
        return 'Speaking...';
      case AvatarState.sleeping:
        return 'Resting.';
      case AvatarState.alert:
        return 'Something needs your attention.';
    }
  }
}

class _WakeWordCard extends ConsumerWidget {
  const _WakeWordCard({required this.state});

  final WakeWordState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.read(wakeWordStateProvider.notifier);
    final availability = state.availability;
    final supported = availability?.available ?? false;

    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.hearing_rounded, color: NovaTheme.primary),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  'Wake word',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                ),
              ),
              if (state.busy)
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Switch(
                  value: state.enabled,
                  activeThumbColor: NovaTheme.primary,
                  onChanged: supported ? controller.setEnabled : null,
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            availability == null
                ? 'Checking availability...'
                : availability.userMessage,
            style: const TextStyle(color: NovaTheme.onSurfaceVariant, fontSize: 13),
          ),
          if (state.listening) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: const BoxDecoration(
                    color: NovaTheme.success,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
                const Text(
                  'Listening in the background',
                  style: TextStyle(color: NovaTheme.success, fontSize: 13),
                ),
              ],
            ),
          ],
          if (state.error != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: NovaTheme.error.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: NovaTheme.error.withValues(alpha: 0.4)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.error_outline, color: NovaTheme.error, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      state.error!,
                      style: const TextStyle(color: NovaTheme.error, fontSize: 13),
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
    final (IconData icon, Color color, String title, String subtitle) = switch (health) {
      AsyncData(:final value) when value.healthy => (
          Icons.cloud_done_rounded,
          NovaTheme.success,
          'Connected',
          value.endpoint,
        ),
      AsyncData(:final value) => (
          Icons.cloud_off_rounded,
          NovaTheme.error,
          'Not reachable',
          value.error ?? 'Unknown error',
        ),
      AsyncError(:final error) => (
          Icons.cloud_off_rounded,
          NovaTheme.error,
          'Not reachable',
          '$error',
        ),
      _ => (
          Icons.cloud_queue_rounded,
          NovaTheme.onSurfaceVariant,
          'Checking...',
          'Contacting the NOVA API',
        ),
    };

    return _Card(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: NovaTheme.onSurfaceVariant,
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Re-check',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: () => ref.invalidate(backendHealthProvider),
          ),
        ],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: NovaTheme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: NovaTheme.border),
      ),
      child: child,
    );
  }
}
