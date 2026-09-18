import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/theme/nova_theme.dart';
import '../../services/analytics_service.dart';
import 'onboarding_service.dart';

/// Final onboarding step: activity goal, notification and voice preferences.
class HealthPage extends ConsumerStatefulWidget {
  const HealthPage({super.key});

  @override
  ConsumerState<HealthPage> createState() => _HealthPageState();
}

class _HealthPageState extends ConsumerState<HealthPage> {
  late int _stepGoal;
  late bool _notificationsEnabled;
  late bool _voiceCommandsEnabled;
  late bool _healthDataAccess;

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = ref.read(onboardingServiceProvider).getHealth();
    _stepGoal = existing?.dailyStepGoal ?? 10000;
    _notificationsEnabled = existing?.notificationsEnabled ?? true;
    _voiceCommandsEnabled = existing?.voiceCommandsEnabled ?? true;
    _healthDataAccess = existing?.healthDataAccess ?? false;
  }

  Future<void> _finish() async {
    setState(() {
      _saving = true;
      _error = null;
    });

    final onboarding = ref.read(onboardingServiceProvider);

    try {
      await onboarding.saveHealth(
        HealthFormData(
          dailyStepGoal: _stepGoal,
          notificationsEnabled: _notificationsEnabled,
          voiceCommandsEnabled: _voiceCommandsEnabled,
          healthDataAccess: _healthDataAccess,
          enabledNotificationCategories: _notificationsEnabled
              ? const <String>['reminders', 'health', 'agent']
              : const <String>[],
        ),
      );
      await onboarding.setCurrentStep(OnboardingStep.complete);
      await onboarding.setStatus(OnboardingStatus.complete);
      await ref.read(analyticsServiceProvider).logEvent(
            AnalyticsService.eventOnboardingStep,
            parameters: const <String, Object?>{'step': 'health', 'action': 'completed'},
          );

      if (!mounted) return;
      context.go('/login');
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = 'Could not save your preferences: $error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Your preferences'),
        backgroundColor: Colors.transparent,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              'Daily step goal',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: 4),
            Text(
              '$_stepGoal steps',
              style: const TextStyle(color: NovaTheme.onSurfaceVariant),
            ),
            Slider(
              value: _stepGoal.toDouble(),
              min: 2000,
              max: 30000,
              divisions: 28,
              label: '$_stepGoal',
              activeColor: NovaTheme.primary,
              onChanged: (value) => setState(() => _stepGoal = value.round()),
            ),
            const SizedBox(height: 16),
            SwitchListTile(
              value: _notificationsEnabled,
              onChanged: (value) => setState(() => _notificationsEnabled = value),
              title: const Text('Notifications'),
              subtitle: const Text('Reminders, nudges and agent updates'),
              activeThumbColor: NovaTheme.primary,
            ),
            SwitchListTile(
              value: _voiceCommandsEnabled,
              onChanged: (value) => setState(() => _voiceCommandsEnabled = value),
              title: const Text('Voice commands'),
              subtitle: const Text('Let NOVA act on spoken requests'),
              activeThumbColor: NovaTheme.primary,
            ),
            SwitchListTile(
              value: _healthDataAccess,
              onChanged: (value) => setState(() => _healthDataAccess = value),
              title: const Text('Share health data'),
              subtitle: const Text('Steps and activity inform your daily summary'),
              activeThumbColor: NovaTheme.primary,
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(
                _error!,
                style: const TextStyle(color: NovaTheme.error, fontSize: 13),
              ),
            ],
            const SizedBox(height: 32),
            FilledButton(
              onPressed: _saving ? null : _finish,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(56),
              ),
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Finish setup'),
            ),
          ],
        ),
      ),
    );
  }
}
