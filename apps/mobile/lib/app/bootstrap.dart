import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/network/network_info_service.dart';
import '../features/auth/auth_repository.dart';
import '../features/onboarding/onboarding_service.dart';

/// Everything that requires asynchronous setup, resolved once before `runApp`.
///
/// The values are injected through `ProviderScope.overrides`, which is why the app can
/// route on the very first frame: [AuthRepository.restore] has already loaded the
/// persisted session, so `authStateProvider` is synchronously correct and the router
/// needs no loading gate.
///
/// The override list is assembled in `main.dart` (rather than returned from here)
/// because Riverpod does not export the `Override` type used by
/// `ProviderScope.overrides`, but does infer it from a list literal.
class BootstrapDependencies {
  const BootstrapDependencies({
    required this.preferences,
    required this.secureStorage,
    required this.authRepository,
    required this.onboardingService,
    required this.networkInfoService,
  });

  final SharedPreferences preferences;
  final FlutterSecureStorage secureStorage;
  final AuthRepository authRepository;
  final OnboardingService onboardingService;
  final NetworkInfoService networkInfoService;
}

Future<BootstrapDependencies> bootstrapDependencies() async {
  final preferences = await SharedPreferences.getInstance();
  const secureStorage = FlutterSecureStorage();

  final authRepository = AuthRepository(secureStorage);
  await authRepository.restore();

  return BootstrapDependencies(
    preferences: preferences,
    secureStorage: secureStorage,
    authRepository: authRepository,
    onboardingService: OnboardingService(preferences),
    networkInfoService: NetworkInfoServiceImpl(),
  );
}
