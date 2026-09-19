import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/onboarding/onboarding_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The onboarding forms collected profile and health data that was then thrown away:
/// `OnboardingService` only persisted the status and the step index. These tests pin
/// the persistence that now actually keeps the answers.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<OnboardingService> serviceWith([Map<String, Object> values = const {}]) async {
    SharedPreferences.setMockInitialValues(values);
    return OnboardingService(await SharedPreferences.getInstance());
  }

  group('resumeStep', () {
    test('a notStarted status always restarts at welcome', () async {
      // A stale step index from an abandoned run must not drop the user mid-flow.
      final service = await serviceWith(<String, Object>{
        'nova_onboarding_step': OnboardingStep.healthSetup.stepIndex,
      });

      expect(service.getStatus(), OnboardingStatus.notStarted);
      expect(service.resumeStep(), OnboardingStep.welcome);
    });

    test('inProgress resumes at the stored step', () async {
      final service = await serviceWith(<String, Object>{
        'nova_onboarding_status': 'inProgress',
        'nova_onboarding_step': OnboardingStep.profileSetup.stepIndex,
      });

      expect(service.resumeStep(), OnboardingStep.profileSetup);
    });

    test('complete resumes at complete', () async {
      final service = await serviceWith(<String, Object>{
        'nova_onboarding_status': 'complete',
      });

      expect(service.resumeStep(), OnboardingStep.complete);
    });
  });

  group('profile persistence', () {
    test('round-trips the name and emergency contacts', () async {
      final service = await serviceWith();

      await service.saveProfile(
        const ProfileFormData(
          name: 'Alex',
          emergencyContacts: <EmergencyContact>[
            EmergencyContact(name: 'Sam', phoneNumber: '+911234567890', relationship: 'Sister'),
          ],
        ),
      );

      final restored = service.getProfile();
      expect(restored, isNotNull);
      expect(restored!.name, 'Alex');
      expect(restored.emergencyContacts, hasLength(1));
      expect(restored.emergencyContacts.single.phoneNumber, '+911234567890');
      expect(restored.emergencyContacts.single.relationship, 'Sister');
    });

    test('returns null when nothing was saved', () async {
      final service = await serviceWith();
      expect(service.getProfile(), isNull);
    });

    test('survives a corrupt payload instead of throwing', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'nova_onboarding_profile': 'not json at all',
      });
      final service = OnboardingService(await SharedPreferences.getInstance());

      expect(service.getProfile(), isNull);
    });
  });

  group('health persistence', () {
    test('round-trips the goal and toggles', () async {
      final service = await serviceWith();

      await service.saveHealth(
        const HealthFormData(
          dailyStepGoal: 12500,
          notificationsEnabled: false,
          voiceCommandsEnabled: true,
          healthDataAccess: true,
          enabledNotificationCategories: <String>['health'],
        ),
      );

      final restored = service.getHealth();
      expect(restored, isNotNull);
      expect(restored!.dailyStepGoal, 12500);
      expect(restored.notificationsEnabled, isFalse);
      expect(restored.voiceCommandsEnabled, isTrue);
      expect(restored.healthDataAccess, isTrue);
      expect(restored.enabledNotificationCategories, <String>['health']);
    });

    test('defaults are applied for a missing payload', () async {
      final service = await serviceWith();
      expect(service.getHealth(), isNull);
    });
  });

  group('granted permissions', () {
    test('round-trip', () async {
      final service = await serviceWith();

      expect(service.getGrantedPermissions(), isEmpty);

      await service.saveGrantedPermissions(<String>['microphone', 'notifications']);

      expect(
        service.getGrantedPermissions(),
        <String>['microphone', 'notifications'],
      );
    });
  });

  group('language policy', () {
    test('round-trips the chosen speech style', () async {
      final service = await serviceWith();

      expect(service.getLanguagePolicy(), 'auto');
      await service.saveLanguagePolicy('ta');

      expect(service.getLanguagePolicy(), 'ta');
    });

    test('falls back to the pending companion persona', () async {
      // The policy also lives on `NovaPersona.languagePolicy`, and a run that
      // stored only the companion must still greet in the chosen language.
      final service = await serviceWith();
      await service.savePendingPersona(<String, dynamic>{
        'name': 'Nova',
        'languagePolicy': 'tanglish',
      });

      expect(service.getLanguagePolicy(), 'tanglish');
    });

    test('an explicitly saved policy wins over the persona', () async {
      final service = await serviceWith();
      await service.savePendingPersona(<String, dynamic>{
        'languagePolicy': 'ta',
      });
      await service.saveLanguagePolicy('en');

      expect(service.getLanguagePolicy(), 'en');
    });

    test('clear removes the stored policy', () async {
      final service = await serviceWith();
      await service.saveLanguagePolicy('ta');

      await service.clear();

      expect(service.getLanguagePolicy(), 'auto');
    });
  });

  group('clear', () {
    test('removes every onboarding key', () async {
      final service = await serviceWith();
      await service.setStatus(OnboardingStatus.complete);
      await service.setCurrentStep(OnboardingStep.healthSetup);
      await service.saveProfile(const ProfileFormData(name: 'Alex'));
      await service.saveHealth(const HealthFormData());
      await service.saveGrantedPermissions(<String>['microphone']);

      await service.clear();

      expect(service.getStatus(), OnboardingStatus.notStarted);
      expect(service.getCurrentStep(), OnboardingStep.welcome);
      expect(service.getProfile(), isNull);
      expect(service.getHealth(), isNull);
      expect(service.getGrantedPermissions(), isEmpty);
    });
  });
}
