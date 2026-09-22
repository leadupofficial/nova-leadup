import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

enum OnboardingStep {
  welcome,
  permissions,
  profileSetup,
  // Added from the OpenDesign export (`onboarding/companion.html`, blueprint
  // §5.4 "Create Your Companion"): name, personality, speech style and voice.
  // It writes the real `/api/v1/settings/persona` resource.
  companion,
  // Asks about the wake word. It is off until the user opts in, and onboarding
  // used to never ask — so every new user finished setup without the product's
  // flagship affordance and had to find it under Profile.
  wakeWord,
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
      case OnboardingStep.companion:
        return 3;
      case OnboardingStep.wakeWord:
        return 4;
      case OnboardingStep.healthSetup:
        return 5;
      case OnboardingStep.complete:
        return 6;
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
        return OnboardingStep.companion;
      case 4:
        return OnboardingStep.wakeWord;
      case 5:
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
      case OnboardingStep.companion:
        return '/onboarding/companion';
      case OnboardingStep.wakeWord:
        return '/onboarding/wakeword';
      case OnboardingStep.healthSetup:
        return '/onboarding/health';
      case OnboardingStep.complete:
        return '/onboarding/complete';
    }
  }
}

enum OnboardingStatus { notStarted, inProgress, complete }

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

  factory EmergencyContact.fromJson(Map<String, dynamic> json) =>
      EmergencyContact(
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

  factory ProfileFormData.fromJson(Map<String, dynamic> json) =>
      ProfileFormData(
        name: json['name'] as String?,
        avatarAsset: json['avatarAsset'] as String?,
        emergencyContacts:
            (json['emergencyContacts'] as List<dynamic>?)
                ?.map(
                  (e) => EmergencyContact.fromJson(e as Map<String, dynamic>),
                )
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
      enabledNotificationCategories:
          enabledNotificationCategories ?? this.enabledNotificationCategories,
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
    enabledNotificationCategories:
        (json['enabledNotificationCategories'] as List<dynamic>?)
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
  /// The companion chosen during onboarding, kept locally until an account
  /// exists to save it to.
  static const _personaKey = 'nova_onboarding_persona';

  /// The speech style the user picked on the companion step.
  ///
  /// Kept separately from [_personaKey] because the persona JSON is cleared once
  /// the companion step is left, and the completion greeting still needs to know
  /// which language to speak.
  static const _languagePolicyKey = 'nova_onboarding_language_policy';

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

  ProfileFormData? getProfile() =>
      _decode(_profileKey, ProfileFormData.fromJson);

  Future<void> saveHealth(HealthFormData health) async {
    await _prefs.setString(_healthKey, jsonEncode(health.toJson()));
  }

  HealthFormData? getHealth() => _decode(_healthKey, HealthFormData.fromJson);

  Future<void> saveGrantedPermissions(List<String> permissions) async {
    await _prefs.setStringList(_permissionsKey, permissions);
  }

  List<String> getGrantedPermissions() =>
      _prefs.getStringList(_permissionsKey) ?? const <String>[];

  /// Stores the companion the user configured before they had an account.
  ///
  /// `/settings/persona` is authenticated, and onboarding runs before sign-in,
  /// so on a fresh install the save always failed with "Missing or invalid
  /// authorization header" and the companion was silently lost. Keeping it here
  /// means the choice survives and can be pushed once the user signs in.
  Future<void> savePendingPersona(Map<String, dynamic> persona) async {
    await _prefs.setString(_personaKey, jsonEncode(persona));
  }

  Map<String, dynamic>? getPendingPersona() {
    final raw = _prefs.getString(_personaKey);
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> clearPendingPersona() async {
    await _prefs.remove(_personaKey);
  }

  /// Persists the speech style chosen on the companion step.
  Future<void> saveLanguagePolicy(String policy) async {
    final trimmed = policy.trim();
    if (trimmed.isEmpty) return;
    await _prefs.setString(_languagePolicyKey, trimmed);
  }

  /// The user's speech style (`auto` | `en` | `ta` | `tanglish`).
  ///
  /// Falls back to the pending companion's `languagePolicy` — the same field on
  /// [NovaPersona] — so a run that stored only the persona still greets in the
  /// chosen language. `auto` is the answer when nothing was chosen.
  String getLanguagePolicy() {
    final stored = _prefs.getString(_languagePolicyKey);
    if (stored != null && stored.trim().isNotEmpty) return stored.trim();
    final fromPersona = getPendingPersona()?['languagePolicy'];
    if (fromPersona is String && fromPersona.trim().isNotEmpty) {
      return fromPersona.trim();
    }
    return 'auto';
  }

  Future<void> clear() async {
    await _prefs.remove(_statusKey);
    await _prefs.remove(_stepKey);
    await _prefs.remove(_profileKey);
    await _prefs.remove(_healthKey);
    await _prefs.remove(_permissionsKey);
    await _prefs.remove(_personaKey);
    await _prefs.remove(_languagePolicyKey);
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
