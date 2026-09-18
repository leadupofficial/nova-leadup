import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/theme/nova_theme.dart';
import '../../services/analytics_service.dart';
import 'onboarding_service.dart';

/// Collects the user's display name and an optional emergency contact.
class ProfilePage extends ConsumerStatefulWidget {
  const ProfilePage({super.key});

  @override
  ConsumerState<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends ConsumerState<ProfilePage> {
  late final TextEditingController _name;
  late final TextEditingController _contactName;
  late final TextEditingController _contactPhone;
  late final TextEditingController _contactRelationship;

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = ref.read(onboardingServiceProvider).getProfile();
    final contact = existing?.emergencyContacts.isNotEmpty == true
        ? existing!.emergencyContacts.first
        : null;

    _name = TextEditingController(text: existing?.name ?? '');
    _contactName = TextEditingController(text: contact?.name ?? '');
    _contactPhone = TextEditingController(text: contact?.phoneNumber ?? '');
    _contactRelationship = TextEditingController(text: contact?.relationship ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    _contactName.dispose();
    _contactPhone.dispose();
    _contactRelationship.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Please tell NOVA what to call you.');
      return;
    }

    final contactName = _contactName.text.trim();
    final contactPhone = _contactPhone.text.trim();
    if (contactName.isNotEmpty && contactPhone.isEmpty) {
      setState(() => _error = 'Add a phone number for the emergency contact, or clear the name.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final onboarding = ref.read(onboardingServiceProvider);
    final contacts = contactName.isEmpty
        ? const <EmergencyContact>[]
        : <EmergencyContact>[
            EmergencyContact(
              name: contactName,
              phoneNumber: contactPhone,
              relationship: _contactRelationship.text.trim().isEmpty
                  ? null
                  : _contactRelationship.text.trim(),
            ),
          ];

    try {
      await onboarding.saveProfile(
        ProfileFormData(name: name, emergencyContacts: contacts),
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
            const SizedBox(height: 32),
            Text(
              'Emergency contact',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: 4),
            const Text(
              'Optional. NOVA can reach them if you ask for help.',
              style: TextStyle(color: NovaTheme.onSurfaceVariant, fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contactName,
              textInputAction: TextInputAction.next,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Contact name',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contactPhone,
              keyboardType: TextInputType.phone,
              textInputAction: TextInputAction.next,
              decoration: const InputDecoration(
                labelText: 'Phone number',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contactRelationship,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _continue(),
              decoration: const InputDecoration(
                labelText: 'Relationship (optional)',
                hintText: 'Sister, friend, doctor...',
                border: OutlineInputBorder(),
              ),
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
