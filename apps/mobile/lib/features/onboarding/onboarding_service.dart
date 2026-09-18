import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

enum OnboardingStep {
  welcome,
  permissions,
  profileSetup,
  healthSetup,
  complete;

  int get stepIndex {
    switch (this) {
      case OnboardingStep.welcome:
        return 0;
      case OnboardingStep.permissions:
        return 1;
      case OnboardingStep.profileSetup:
        return 2;
      case OnboardingStep.healthSetup:
        return 3;
      case OnboardingStep.complete:
        return 4;
    }
  }

  static OnboardingStep fromIndex(int index) {
    switch (index) {
      case 0:
        return OnboardingStep.welcome;
      case 1:
        return OnboardingStep.permissions;
      case 2:
        return OnboardingStep.profileSetup;
      case 3:
        return OnboardingStep.healthSetup;
      default:
        return OnboardingStep.complete;
    }
  }

  String get routeName {
    switch (this) {
      case OnboardingStep.welcome:
        return '/onboarding/welcome';
      case OnboardingStep.permissions:
        return '/onboarding/permissions';
      case OnboardingStep.profileSetup:
        return '/onboarding/profile';
      case OnboardingStep.healthSetup:
        return '/onboarding/health';
      case OnboardingStep.complete:
        return '/onboarding/complete';
    }
  }
}

enum OnboardingStatus {
  notStarted,
  inProgress,
  complete,
}

class EmergencyContact {
  final String name;
  final String phoneNumber;
  final String? relationship;

  const EmergencyContact({
    required this.name,
    required this.phoneNumber,
    this.relationship,
  });

  Map<String, dynamic> toJson() => {
        'name': name,
        'phoneNumber': phoneNumber,
        if (relationship != null) 'relationship': relationship,
      };

  factory EmergencyContact.fromJson(Map<String, dynamic> json) => EmergencyContact(
        name: json['name'] as String,
        phoneNumber: json['phoneNumber'] as String,
        relationship: json['relationship'] as String?,
      );
}

class ProfileFormData {
  final String? name;
  final String? avatarAsset;
  final List<EmergencyContact> emergencyContacts;

  const ProfileFormData({
    this.name,
    this.avatarAsset,
    this.emergencyContacts = const [],
  });

  ProfileFormData copyWith({
    String? name,
    String? avatarAsset,
    List<EmergencyContact>? emergencyContacts,
  }) {
    return ProfileFormData(
      name: name ?? this.name,
      avatarAsset: avatarAsset ?? this.avatarAsset,
      emergencyContacts: emergencyContacts ?? this.emergencyContacts,
    );
  }

  Map<String, dynamic> toJson() => {
        if (name != null) 'name': name,
        if (avatarAsset != null) 'avatarAsset': avatarAsset,
        'emergencyContacts': emergencyContacts.map((c) => c.toJson()).toList(),
      };

  factory ProfileFormData.fromJson(Map<String, dynamic> json) => ProfileFormData(
        name: json['name'] as String?,
        avatarAsset: json['avatarAsset'] as String?,
        emergencyContacts: (json['emergencyContacts'] as List<dynamic>?)
                ?.map((e) => EmergencyContact.fromJson(e as Map<String, dynamic>))
                .toList() ??
            const [],
      );
}

class HealthFormData {
  final int dailyStepGoal;
  final bool notificationsEnabled;
  final bool voiceCommandsEnabled;
  final bool healthDataAccess;
  final List<String> enabledNotificationCategories;

  const HealthFormData({
    this.dailyStepGoal = 10000,
    this.notificationsEnabled = true,
    this.voiceCommandsEnabled = true,
    this.healthDataAccess = false,
    this.enabledNotificationCategories = const [],
  });

  HealthFormData copyWith({
    int? dailyStepGoal,
    bool? notificationsEnabled,
    bool? voiceCommandsEnabled,
    bool? healthDataAccess,
    List<String>? enabledNotificationCategories,
  }) {
    return HealthFormData(
      dailyStepGoal: dailyStepGoal ?? this.dailyStepGoal,
      notificationsEnabled: notificationsEnabled ?? this.notificationsEnabled,
      voiceCommandsEnabled: voiceCommandsEnabled ?? this.voiceCommandsEnabled,
      healthDataAccess: healthDataAccess ?? this.healthDataAccess,
      enabledNotificationCategories: enabledNotificationCategories ?? this.enabledNotificationCategories,
    );
  }

  Map<String, dynamic> toJson() => {
        'dailyStepGoal': dailyStepGoal,
        'notificationsEnabled': notificationsEnabled,
        'voiceCommandsEnabled': voiceCommandsEnabled,
        'healthDataAccess': healthDataAccess,
        'enabledNotificationCategories': enabledNotificationCategories,
      };

  factory HealthFormData.fromJson(Map<String, dynamic> json) => HealthFormData(
        dailyStepGoal: json['dailyStepGoal'] as int? ?? 10000,
        notificationsEnabled: json['notificationsEnabled'] as bool? ?? true,
        voiceCommandsEnabled: json['voiceCommandsEnabled'] as bool? ?? true,
        healthDataAccess: json['healthDataAccess'] as bool? ?? false,
        enabledNotificationCategories: (json['enabledNotificationCategories'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
      );
}

class OnboardingFormData {
  final ProfileFormData profile;
  final HealthFormData health;
  final List<String> grantedPermissions;

  const OnboardingFormData({
    this.profile = const ProfileFormData(),
    this.health = const HealthFormData(),
    this.grantedPermissions = const [],
  });

  OnboardingFormData copyWith({
    ProfileFormData? profile,
    HealthFormData? health,
    List<String>? grantedPermissions,
  }) {
    return OnboardingFormData(
      profile: profile ?? this.profile,
      health: health ?? this.health,
      grantedPermissions: grantedPermissions ?? this.grantedPermissions,
    );
  }
}

class OnboardingService {
  static const _statusKey = 'nova_onboarding_status';
  static const _stepKey = 'nova_onboarding_step';
  static const _profileKey = 'nova_onboarding_profile';
  static const _healthKey = 'nova_onboarding_health';
  static const _permissionsKey = 'nova_onboarding_permissions';

  final SharedPreferences _prefs;

  OnboardingService(this._prefs);

  OnboardingStatus getStatus() {
    final val = _prefs.getString(_statusKey);
    if (val == 'complete') return OnboardingStatus.complete;
    if (val == 'inProgress') return OnboardingStatus.inProgress;
    return OnboardingStatus.notStarted;
  }

  Future<void> setStatus(OnboardingStatus status) async {
    await _prefs.setString(_statusKey, status.name);
  }

  OnboardingStep getCurrentStep() {
    final idx = _prefs.getInt(_stepKey) ?? 0;
    return OnboardingStep.fromIndex(idx);
  }

  Future<void> setCurrentStep(OnboardingStep step) async {
    await _prefs.setInt(_stepKey, step.stepIndex);
  }

  /// The step the user should resume at.
  ///
  /// A `notStarted` status always restarts at welcome: the stored step index can be
  /// left over from an abandoned run, and resuming mid-flow without having started
  /// would skip the introduction entirely.
  OnboardingStep resumeStep() {
    switch (getStatus()) {
      case OnboardingStatus.notStarted:
        return OnboardingStep.welcome;
      case OnboardingStatus.inProgress:
        return getCurrentStep();
      case OnboardingStatus.complete:
        return OnboardingStep.complete;
    }
  }

  // --- Persisted form data -------------------------------------------------
  // Without these the profile and health forms collected input and then dropped it,
  // so the answers never reached the app.

  Future<void> saveProfile(ProfileFormData profile) async {
    await _prefs.setString(_profileKey, jsonEncode(profile.toJson()));
  }

  ProfileFormData? getProfile() => _decode(_profileKey, ProfileFormData.fromJson);

  Future<void> saveHealth(HealthFormData health) async {
    await _prefs.setString(_healthKey, jsonEncode(health.toJson()));
  }

  HealthFormData? getHealth() => _decode(_healthKey, HealthFormData.fromJson);

  Future<void> saveGrantedPermissions(List<String> permissions) async {
    await _prefs.setStringList(_permissionsKey, permissions);
  }

  List<String> getGrantedPermissions() =>
      _prefs.getStringList(_permissionsKey) ?? const <String>[];

  Future<void> clear() async {
    await _prefs.remove(_statusKey);
    await _prefs.remove(_stepKey);
    await _prefs.remove(_profileKey);
    await _prefs.remove(_healthKey);
    await _prefs.remove(_permissionsKey);
  }

  T? _decode<T>(String key, T Function(Map<String, dynamic>) fromJson) {
    final raw = _prefs.getString(key);
    if (raw == null) return null;
    try {
      return fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      // Corrupt or schema-changed payload: treat as absent rather than crashing.
      return null;
    }
  }
}
