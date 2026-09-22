import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/theme/nova_theme.dart';
import '../../services/analytics_service.dart';
import 'onboarding_service.dart';

/// Collects the user's display name.
///
/// It used to also collect an emergency contact (a third party's name, phone and
/// relationship). Nothing in the app ever read that back, so the screen promised an
/// escalation path that does not exist and stored someone else's phone number without
/// the privacy policy mentioning it. The fields are gone; a value stored by an older
/// build is carried through untouched rather than silently deleted.
class ProfilePage extends ConsumerStatefulWidget {
  const ProfilePage({super.key});

  @override
  ConsumerState<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends ConsumerState<ProfilePage> {
  late final TextEditingController _name;

  /// Contacts already stored on this device, preserved verbatim. Empty for anyone
  /// who onboarded after the fields were removed.
  List<EmergencyContact> _existingContacts = const <EmergencyContact>[];

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = ref.read(onboardingServiceProvider).getProfile();
    _existingContacts = existing?.emergencyContacts ?? const <EmergencyContact>[];
    _name = TextEditingController(text: existing?.name ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Please tell NOVA what to call you.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final onboarding = ref.read(onboardingServiceProvider);

    try {
      await onboarding.saveProfile(
        // The stored contacts are passed straight back: this screen can no longer
        // change them, and dropping them would destroy data the user did enter.
        ProfileFormData(name: name, emergencyContacts: _existingContacts),
      );
      await onboarding.setCurrentStep(OnboardingStep.companion);
      await ref.read(analyticsServiceProvider).logEvent(
            AnalyticsService.eventOnboardingStep,
            parameters: const <String, Object?>{'step': 'profile', 'action': 'completed'},
          );
      if (!mounted) return;
      context.go(OnboardingStep.companion.routeName);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = 'Could not save your profile: $error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('About you'),
        backgroundColor: Colors.transparent,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              'What should NOVA call you?',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _name,
              textInputAction: TextInputAction.next,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Name',
                hintText: 'Alex',
                border: OutlineInputBorder(),
              ),
            ),
            // The "Emergency contact" block (name / phone / relationship) was removed
            // here. It collected a *third party's* name and phone number, stored them
            // on the device, and nothing in the app ever read them back — no call, no
            // message, no escalation path. The copy promised "NOVA can reach them if
            // you ask for help", which no code implemented, and the number was never
            // mentioned in the privacy policy. That is a false capability claim
            // (Play Deceptive Behavior; App Review 2.3.1(a)) on top of an undisclosed
            // collection of someone else's personal data. `ProfileFormData` keeps the
            // field so previously stored values still round-trip; nothing new is
            // collected. Re-add the UI together with the escalation flow behind it.
            const SizedBox(height: 32),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(
                _error!,
                style: const TextStyle(color: NovaTheme.error, fontSize: 13),
              ),
            ],
            const SizedBox(height: 32),
            FilledButton(
              onPressed: _saving ? null : _continue,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(56),
              ),
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Continue'),
            ),
          ],
        ),
      ),
    );
  }
}
