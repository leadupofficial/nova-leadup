import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/nova_theme.dart';
import '../../core/voice/wake_word_controller.dart';
import 'onboarding_service.dart';

/// The onboarding step that asks about the wake word.
///
/// The wake word is the product's flagship affordance and it is off until the
/// user opts in — but onboarding never asked. Every new user finished setup with
/// it disabled, and the only way to find it was Profile → Wake word listening.
/// Home used to advertise `or say "Hey Nova"` regardless, which made it worse:
/// the app named a phrase it was not listening for.
///
/// This is the ask. It sits after the companion step, where the rest of the
/// voice choices are made, and before the health step so the finish line is
/// unchanged. Skipping is a first-class choice: nothing here implies the
/// assistant is worse without it.
class WakeWordStepPage extends ConsumerStatefulWidget {
  const WakeWordStepPage({super.key});

  @override
  ConsumerState<WakeWordStepPage> createState() => _WakeWordStepPageState();
}

class _WakeWordStepPageState extends ConsumerState<WakeWordStepPage> {
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // `arm()` is the documented place to bring the Android foreground service
    // back after the OS killed it, and it is how the state is learned.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(wakeWordStateProvider.notifier).arm();
    });
  }

  Future<void> _turnOn() async {
    setState(() => _busy = true);
    try {
      await ref.read(wakeWordStateProvider.notifier).setEnabled(true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _continue() => context.go(OnboardingStep.healthSetup.routeName);

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final wake = ref.watch(wakeWordStateProvider);
    final phrase = wake.phrase;
    final on = wake.enabled;

    return Scaffold(
      backgroundColor: NovaTheme.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 8),
              Text('Wake word', style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 8),
              Text(
                phrase == null
                    // No model in this build: say so rather than offering a
                    // switch that would do nothing.
                    ? 'This build has no wake word installed, so NOVA can only '
                          'listen once you tap to talk.'
                    : 'Say "$phrase" and NOVA starts listening — even from your '
                          'pocket. Audio stays on the device until the phrase is '
                          'detected.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 24),
              if (phrase != null)
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: NovaTheme.surface,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: on ? NovaTheme.primary : c.border),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        on ? Icons.mic : Icons.mic_off,
                        color: on ? NovaTheme.primary : c.muted,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              on ? 'Listening for "$phrase"' : 'Wake word is off',
                              style: NovaTheme.sectionHeading(c),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              on
                                  ? 'NOVA is listening on this device.'
                                  : 'You can turn this on any time from your '
                                        'profile.',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      if (_busy)
                        const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      else if (!on)
                        TextButton(
                          onPressed: _turnOn,
                          child: const Text('Turn on'),
                        ),
                    ],
                  ),
                ),
              const Spacer(),
              FilledButton(
                onPressed: _continue,
                style: FilledButton.styleFrom(
                  backgroundColor: NovaTheme.primary,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                child: Text(on ? 'Continue' : 'Not now'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
