import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/theme/nova_theme.dart';
import '../../services/analytics_service.dart';
import '../reminders/notification_delivery_cache.dart';
import 'onboarding_greeting.dart';
import 'onboarding_service.dart';

/// Final onboarding step: notification and voice preferences.
///
/// The class and route keep the `health` name because the persisted
/// [HealthFormData] record and its key are part of stored state; the step no longer
/// asks for anything health-related — see the note in `build`.
class HealthPage extends ConsumerStatefulWidget {
  const HealthPage({super.key});

  @override
  ConsumerState<HealthPage> createState() => _HealthPageState();
}

class _HealthPageState extends ConsumerState<HealthPage> {
  late int _stepGoal;
  late bool _notificationsEnabled;

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = ref.read(onboardingServiceProvider).getHealth();
    _stepGoal = existing?.dailyStepGoal ?? 10000;
    _notificationsEnabled = existing?.notificationsEnabled ?? true;
  }

  Future<void> _finish() async {
    setState(() {
      _saving = true;
      _error = null;
    });

    final onboarding = ref.read(onboardingServiceProvider);
    final storedHealth = onboarding.getHealth();

    try {
      // Mirror the choice where delivery actually reads it. Without this the switch
      // stored a preference that no code consulted, so a user who turned notifications
      // off here still got every reminder.
      await cacheNotificationDelivery(
        ref.read(sharedPreferencesProvider),
        push: _notificationsEnabled,
        inApp: _notificationsEnabled,
      );

      await onboarding.saveHealth(
        HealthFormData(
          // Written as an explicit `false` / default rather than echoing a stored
          // value: the app has no health integration, and the published policy states
          // "No health, fitness or step data". Round-tripping a previously stored
          // `true` would have kept a claim the app cannot honour.
          dailyStepGoal: _stepGoal,
          notificationsEnabled: _notificationsEnabled,
          // Carried through untouched: the switch that used to set it was removed
          // because nothing read it, and dropping the stored value would be a silent
          // change for anyone who had already answered.
          voiceCommandsEnabled: storedHealth?.voiceCommandsEnabled ?? true,
          healthDataAccess: false,
          // `'health'` was one of the three notification categories. There is no
          // health feature to notify about, so the category contradicted the Data
          // safety form and the in-app policy for no benefit.
          enabledNotificationCategories: _notificationsEnabled
              ? const <String>['reminders', 'agent']
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

      // Speak the welcome in the language the user chose. This is
      // fire-and-forget on purpose: the device engine is app-wide and keeps
      // talking across the navigation to /login, so the screen does not wait for
      // an utterance to finish. The messenger is captured first because the
      // result arrives after this route is gone.
      final messenger = ScaffoldMessenger.of(context);
      final deviceLanguage = WidgetsBinding.instance.platformDispatcher.locale.languageCode;
      unawaited(
        ref
            .read(onboardingGreetingProvider)
            .speakOnce(deviceLanguageCode: deviceLanguage)
            .then((result) {
              final notice = result.notice;
              if (notice == null) return;
              messenger.showSnackBar(SnackBar(content: Text(notice)));
            }),
      );

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
            // The "Daily step goal" slider and the "Share health data" switch were
            // removed here before the first store submission. Both collected a
            // preference for data the app has no way to read: there is no Health
            // Connect integration, no `ACTIVITY_RECOGNITION` permission, no
            // pedometer/sensors dependency and no step API anywhere in `lib/`. Asking
            // the user to "Share health data — Steps and activity inform your daily
            // summary" was therefore a false claim, and it contradicted the Data Safety
            // form, which must not declare health data. `HealthFormData` keeps the two
            // fields so previously stored values still round-trip; nothing is collected.
            // Both of these were written to `SharedPreferences` and read by nothing —
            // the same shape as the privacy switches fixed in the previous round.
            //
            // "Notifications" is now the real gate: it writes the same local value the
            // reminder and briefing reconcilers read, so turning it off here actually
            // stops an alert arriving rather than only recording an opinion. (The
            // account-level `push` / `inApp` pair lives in Profile → Notifications,
            // which is where it can be changed once an account exists.)
            SwitchListTile(
              value: _notificationsEnabled,
              onChanged: (value) => setState(() => _notificationsEnabled = value),
              title: const Text('Notifications'),
              subtitle: const Text('Reminders and briefings on this device'),
              activeThumbColor: NovaTheme.primary,
            ),
            // "Voice commands — Let NOVA act on spoken requests" was REMOVED. There is
            // no global voice-action switch to honour: nothing in the app consults it,
            // and the only thing that acts on speech is the device-control screen,
            // where every action already goes through its own explicit confirmation
            // sheet — a per-action guard that is strictly better than one blanket
            // toggle, and one the user can actually see. Keeping a switch that changed
            // nothing would have been the same false claim this file has already had to
            // remove twice. `HealthFormData` keeps the field so previously stored values
            // still round-trip.
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
