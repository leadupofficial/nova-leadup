import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import 'onboarding_service.dart';

/// Create Your Companion — port of `onboarding/companion.html` (blueprint §5.4).
///
/// This is a real write, not a mock: the form posts to
/// `PUT /api/v1/settings/persona`, whose verified schema is
/// `{name, personality, voiceSpeed, voiceTone, languagePolicy, wakeWordEnabled}`.
///
/// NOTE ON FIDELITY: the export also shows a "Response length" control
/// (Brief / Balanced / Detailed). The persona API has no field for it, and zod
/// strips unknown keys, so shipping it would create a control that appears to
/// save and silently does nothing — the exact dead-control defect found in the
/// admin console. It is omitted until the server has somewhere to put it.
class CompanionPage extends ConsumerStatefulWidget {
  const CompanionPage({super.key});

  @override
  ConsumerState<CompanionPage> createState() => _CompanionPageState();
}

class _CompanionPageState extends ConsumerState<CompanionPage> {
  final _name = TextEditingController();
  String _personality = 'friendly';
  String _languagePolicy = 'auto';
  int _voiceSpeed = 100;
  bool _saving = false;
  String? _error;
  bool _loaded = false;

  static const _personalities = <(String, String, String)>[
    ('friendly', 'Friendly', 'Warm and conversational'),
    ('professional', 'Professional', 'Direct and businesslike'),
    ('executive', 'Executive', 'Terse, decision-oriented'),
    ('companion', 'Companion', 'Chatty and encouraging'),
  ];

  static const _speechStyles = <(String, String)>[
    ('auto', 'Auto Tamil–English'),
    ('ta', 'Tamil'),
    ('en', 'English'),
    ('tanglish', 'Tanglish'),
  ];

  @override
  void initState() {
    super.initState();
    // Prefill from whatever is already stored so re-running onboarding does not
    // silently reset the user's companion.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        final persona = await ref.read(personaProvider.future);
        if (!mounted) return;
        setState(() {
          _name.text = persona.name;
          _personality = persona.personality;
          _languagePolicy = persona.languagePolicy;
          _voiceSpeed = persona.voiceSpeed;
          _loaded = true;
        });
      } catch (_) {
        if (mounted) setState(() => _loaded = true);
      }
    });
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return NovaScaffold(
      topBar: Row(
        children: [
          NovaIconButton(
            icon: Icons.arrow_back_rounded,
            size: 36,
            tooltip: 'Back',
            onTap: () => context.go(OnboardingStep.profileSetup.routeName),
          ),
          const Spacer(),
          Text('Create companion', style: NovaTheme.sectionHeading(c)),
          const Spacer(),
          const SizedBox(width: 36),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Name your\ncompanion',
            style: NovaTheme.heroName(c).copyWith(fontSize: 34, height: 1.1),
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'Make it yours. Everything can be changed later.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 28),

          Text('Companion name', style: NovaTheme.overline(c)),
          const SizedBox(height: 6),
          NovaTextField(
            controller: _name,
            hint: 'NOVA',
            enabled: _loaded,
          ),
          const SizedBox(height: 20),

          Text('Personality', style: NovaTheme.overline(c)),
          const SizedBox(height: NovaSpace.xs),
          ..._personalities.map(
            (p) => Padding(
              padding: const EdgeInsets.only(bottom: NovaSpace.xs),
              child: _RadioOption(
                label: p.$2,
                hint: p.$3,
                selected: _personality == p.$1,
                onTap: () => setState(() => _personality = p.$1),
              ),
            ),
          ),
          const SizedBox(height: 12),

          Text('Speech style', style: NovaTheme.overline(c)),
          const SizedBox(height: NovaSpace.xs),
          Wrap(
            spacing: NovaSpace.xs,
            runSpacing: NovaSpace.xs,
            children: _speechStyles
                .map(
                  (s) => NovaChip(
                    label: s.$2,
                    selected: _languagePolicy == s.$1,
                    onTap: () => setState(() => _languagePolicy = s.$1),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 20),

          Text('Voice speed · $_voiceSpeed%', style: NovaTheme.overline(c)),
          Slider(
            value: _voiceSpeed.toDouble(),
            min: 50,
            max: 200,
            divisions: 15,
            activeColor: c.accent,
            label: '$_voiceSpeed%',
            onChanged: (v) => setState(() => _voiceSpeed = v.round()),
          ),
          const SizedBox(height: 12),

          Text('Preview', style: NovaTheme.overline(c)),
          const SizedBox(height: NovaSpace.xs),
          NovaAvatarHeroCard(
            statusLabel: _name.text.isEmpty ? 'Ready' : _name.text,
            faceSize: 72,
          ),
          const SizedBox(height: 24),

          if (_error != null) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(NovaSpace.sm),
              decoration: BoxDecoration(
                color: c.danger.withValues(alpha: 0.12),
                borderRadius: NovaRadius.rControl,
                border: Border.all(color: c.danger.withValues(alpha: 0.4)),
              ),
              child: Text(
                _error!,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.danger),
              ),
            ),
            const SizedBox(height: NovaSpace.md),
          ],

          NovaPrimaryButton(
            label: 'Create companion',
            busy: _saving,
            onPressed: _saving || !_loaded ? null : _save,
          ),
          const SizedBox(height: NovaSpace.sm),
          Center(
            child: TextButton(
              onPressed: _saving
                  ? null
                  : () => _advance(context, ref, save: false),
              child: Text(
                'Skip for now',
                style: NovaTheme.chip(c).copyWith(color: c.muted),
              ),
            ),
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
      final persona = NovaPersona(
        name: _name.text.trim().isEmpty ? 'Nova' : _name.text.trim(),
        personality: _personality,
        languagePolicy: _languagePolicy,
        voiceSpeed: _voiceSpeed,
      );
      await ref.read(novaMutationsProvider).savePersona(persona);
      if (!mounted) return;
      await _advance(context, ref, save: false);
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

  Future<void> _advance(
    BuildContext context,
    WidgetRef ref, {
    required bool save,
  }) async {
    await ref
        .read(onboardingServiceProvider)
        .setCurrentStep(OnboardingStep.healthSetup);
    if (context.mounted) context.go(OnboardingStep.healthSetup.routeName);
  }
}

/// `.radio-opt` — a selectable row with a radio dot, label and hint.
class _RadioOption extends StatelessWidget {
  const _RadioOption({
    required this.label,
    required this.selected,
    required this.onTap,
    this.hint,
  });

  final String label;
  final String? hint;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: NovaRadius.rCard,
        child: AnimatedContainer(
          duration: NovaMotion.uiMin,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: selected
                ? c.accent.withValues(alpha: 0.08)
                : c.surface,
            borderRadius: NovaRadius.rCard,
            border: Border.all(color: selected ? c.accent : c.border),
          ),
          child: Row(
            children: [
              Container(
                width: 20,
                height: 20,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: selected ? c.accent : c.muted,
                    width: 2,
                  ),
                ),
                child: selected
                    ? Center(
                        child: Container(
                          width: 10,
                          height: 10,
                          decoration: BoxDecoration(
                            color: c.accent,
                            shape: BoxShape.circle,
                          ),
                        ),
                      )
                    : null,
              ),
              const SizedBox(width: NovaSpace.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      label,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    if (hint != null)
                      Text(hint!, style: Theme.of(context).textTheme.bodySmall),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
