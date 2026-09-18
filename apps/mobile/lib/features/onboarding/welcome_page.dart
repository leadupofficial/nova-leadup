import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/avatar/avatar_provider.dart';
import '../../core/theme/nova_theme.dart';
import '../../services/analytics_service.dart';
import 'onboarding_service.dart';

class WelcomePage extends ConsumerWidget {
  const WelcomePage({super.key});

  static const List<(IconData, String, String)> _highlights = [
    (
      Icons.mic_rounded,
      'Talk, don\'t type',
      'Speak naturally and NOVA handles the rest.',
    ),
    (
      Icons.memory_rounded,
      'Remembers context',
      'Your tasks, notes and preferences stay in one place.',
    ),
    (
      Icons.lock_rounded,
      'Private by default',
      'Wake word detection runs on your device, not in the cloud.',
    ),
  ];

  Future<void> _getStarted(BuildContext context, WidgetRef ref) async {
    final onboarding = ref.read(onboardingServiceProvider);
    await onboarding.setStatus(OnboardingStatus.inProgress);
    await onboarding.setCurrentStep(OnboardingStep.permissions);
    await ref.read(analyticsServiceProvider).logEvent(
          AnalyticsService.eventOnboardingStep,
          parameters: const <String, Object?>{'step': 'welcome', 'action': 'started'},
        );
    if (context.mounted) context.go(OnboardingStep.permissions.routeName);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Spacer(),
              const NovaAvatar(state: AvatarState.idle, size: 140),
              const SizedBox(height: 32),
              Text(
                'Meet NOVA',
                style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              Text(
                'A voice-first companion that keeps track of your day.',
                style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: NovaTheme.onSurfaceVariant,
                    ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 40),
              for (final (icon, title, subtitle) in _highlights)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color: NovaTheme.primary.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Icon(icon, color: NovaTheme.primary, size: 22),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 15,
                              ),
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
                    ],
                  ),
                ),
              const Spacer(),
              FilledButton(
                onPressed: () => _getStarted(context, ref),
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(56),
                ),
                child: const Text('Get started'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
