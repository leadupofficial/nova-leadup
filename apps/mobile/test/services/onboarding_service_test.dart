import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/onboarding/onboarding_service.dart';

void main() {
  group('OnboardingStep', () {
    test('stepIndex returns correct values', () {
      expect(OnboardingStep.welcome.stepIndex, 0);
      expect(OnboardingStep.permissions.stepIndex, 1);
      expect(OnboardingStep.profileSetup.stepIndex, 2);
      // `companion` was inserted from the OpenDesign export, shifting the two
      // steps after it.
      expect(OnboardingStep.companion.stepIndex, 3);
      expect(OnboardingStep.healthSetup.stepIndex, 4);
      expect(OnboardingStep.complete.stepIndex, 5);
    });

    test('fromIndex maps correctly', () {
      expect(OnboardingStep.fromIndex(0), OnboardingStep.welcome);
      expect(OnboardingStep.fromIndex(1), OnboardingStep.permissions);
      expect(OnboardingStep.fromIndex(2), OnboardingStep.profileSetup);
      expect(OnboardingStep.fromIndex(3), OnboardingStep.companion);
      expect(OnboardingStep.fromIndex(4), OnboardingStep.healthSetup);
      expect(OnboardingStep.fromIndex(99), OnboardingStep.complete);
    });

    test('routeName returns correct routes', () {
      expect(OnboardingStep.welcome.routeName, '/onboarding/welcome');
      expect(OnboardingStep.permissions.routeName, '/onboarding/permissions');
      expect(OnboardingStep.profileSetup.routeName, '/onboarding/profile');
      expect(OnboardingStep.companion.routeName, '/onboarding/companion');
      expect(OnboardingStep.healthSetup.routeName, '/onboarding/health');
      expect(OnboardingStep.complete.routeName, '/onboarding/complete');
    });
  });

  group('OnboardingFormData', () {
    test('defaults are correct', () {
      final data = const OnboardingFormData();
      expect(data.profile.name, isNull);
      expect(data.health.dailyStepGoal, 10000);
      expect(data.grantedPermissions, isEmpty);
    });

    test('copyWith creates updated copy', () {
      final data = const OnboardingFormData();
      final updated = data.copyWith(
        profile: const ProfileFormData(name: 'Test'),
        health: const HealthFormData(dailyStepGoal: 5000),
      );

      expect(updated.profile.name, 'Test');
      expect(updated.health.dailyStepGoal, 5000);
      expect(updated.grantedPermissions, isEmpty);
    });
  });

  group('HealthFormData', () {
    test('defaults are correct', () {
      final health = const HealthFormData();
      expect(health.dailyStepGoal, 10000);
      expect(health.notificationsEnabled, isTrue);
      expect(health.voiceCommandsEnabled, isTrue);
      expect(health.healthDataAccess, isFalse);
      expect(health.enabledNotificationCategories, isEmpty);
    });

    test('toJson produces correct map', () {
      final health = const HealthFormData(
        dailyStepGoal: 8000,
        healthDataAccess: true,
      );

      final json = health.toJson();
      expect(json['dailyStepGoal'], 8000);
      expect(json['healthDataAccess'], isTrue);
      expect(json['notificationsEnabled'], isTrue);
    });

    test('fromJson parses correctly', () {
      final health = HealthFormData.fromJson({
        'dailyStepGoal': 5000,
        'notificationsEnabled': false,
        'voiceCommandsEnabled': false,
        'healthDataAccess': true,
        'enabledNotificationCategories': ['step', 'heart'],
      });

      expect(health.dailyStepGoal, 5000);
      expect(health.notificationsEnabled, isFalse);
      expect(health.voiceCommandsEnabled, isFalse);
      expect(health.healthDataAccess, isTrue);
      expect(health.enabledNotificationCategories, containsAll(['step', 'heart']));
    });

    test('fromJson uses defaults for missing keys', () {
      final health = HealthFormData.fromJson({});

      expect(health.dailyStepGoal, 10000);
      expect(health.notificationsEnabled, isTrue);
      expect(health.voiceCommandsEnabled, isTrue);
      expect(health.healthDataAccess, isFalse);
    });
  });

  group('ProfileFormData', () {
    test('defaults are correct', () {
      final profile = const ProfileFormData();
      expect(profile.name, isNull);
      expect(profile.avatarAsset, isNull);
      expect(profile.emergencyContacts, isEmpty);
    });

    test('copyWith creates updated copy', () {
      final profile = const ProfileFormData();
      final updated = profile.copyWith(
        name: 'Alice',
        avatarAsset: 'avatar.png',
      );

      expect(updated.name, 'Alice');
      expect(updated.avatarAsset, 'avatar.png');
    });
  });

  group('EmergencyContact', () {
    test('creates with required fields', () {
      final contact = const EmergencyContact(
        name: 'Bob',
        phoneNumber: '555-1234',
        relationship: 'Friend',
      );

      expect(contact.name, 'Bob');
      expect(contact.phoneNumber, '555-1234');
      expect(contact.relationship, 'Friend');
    });

    test('toJson/fromJson round-trips', () {
      final original = const EmergencyContact(
        name: 'Bob',
        phoneNumber: '555-1234',
      );

      final json = original.toJson();
      final restored = EmergencyContact.fromJson(json);

      expect(restored.name, 'Bob');
      expect(restored.phoneNumber, '555-1234');
      expect(restored.relationship, isNull);
    });
  });

  group('OnboardingService', () {
    test('OnboardingStatus.values contains expected states', () {
      expect(OnboardingStatus.values, contains(OnboardingStatus.notStarted));
      expect(OnboardingStatus.values, contains(OnboardingStatus.inProgress));
      expect(OnboardingStatus.values, contains(OnboardingStatus.complete));
    });
  });
}
