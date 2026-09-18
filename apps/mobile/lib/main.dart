import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'app/bootstrap.dart';
import 'app/error_apps.dart';
import 'app/providers.dart';
import 'config/api_config.dart';
import 'services/analytics_service.dart';
import 'services/crash_reporting_service.dart';
import 'services/firebase_backends.dart';
import 'services/logger_service.dart';

/// NOVA's entry point.
///
/// This used to be a stub that rendered a centred "NOVA" label with no routing, no
/// providers and no auth wiring, so none of the services in `lib/` were ever reached.
///
/// Bootstrap order matters:
///   1. Crash reporting and its global error handlers, so anything that fails after
///      this point is reported rather than silently dropped.
///   2. A fail-fast API configuration check that renders a readable screen.
///   3. Await the platform stores, restore the persisted session, and inject the
///      results as Riverpod overrides. This is what lets the router decide the first
///      screen synchronously.
void main() {
  runZonedGuarded<Future<void>>(
    () async {
      WidgetsFlutterBinding.ensureInitialized();

      final crashReporting = CrashReportingService();
      final analytics = AnalyticsService.instance;

      // Firebase is initialised first so that crash reporting is live before anything
      // else in bootstrap can fail. It returns null when Firebase is unavailable (a
      // build without google-services.json, or no Play services on the device), in
      // which case both services keep their console backends — the app still runs.
      final firebase = await FirebaseActivation.initialize();

      await crashReporting.initialize(
        enabled: !kDebugMode,
        backend: firebase?.crash,
      );
      crashReporting.installGlobalHandlers();
      await analytics.initialize(
        enabled: !kDebugMode,
        backend: firebase?.analytics,
      );
      await LoggerService().initialize();

      await crashReporting.log('Bootstrap started');

      // Fail fast, and legibly, on an unsafe API configuration (e.g. a release build
      // pointed at http://). Previously this threw from inside the widget tree and
      // produced a blank screen.
      final configurationProblems = ApiConfig.validate();
      if (configurationProblems.isNotEmpty) {
        await crashReporting.log(
          'Refusing to start: ${configurationProblems.join(" | ")}',
        );
        runApp(ConfigurationErrorApp(problems: configurationProblems));
        return;
      }

      try {
        final dependencies = await bootstrapDependencies();
        runApp(
          ProviderScope(
            // The list type is inferred from `ProviderScope.overrides`, because
            // Riverpod does not export the `Override` type for explicit annotation.
            overrides: [
              sharedPreferencesProvider.overrideWithValue(dependencies.preferences),
              secureStorageProvider.overrideWithValue(dependencies.secureStorage),
              authRepositoryProvider.overrideWithValue(dependencies.authRepository),
              onboardingServiceProvider.overrideWithValue(dependencies.onboardingService),
              networkInfoServiceProvider.overrideWithValue(dependencies.networkInfoService),
              crashReportingServiceProvider.overrideWithValue(crashReporting),
              analyticsServiceProvider.overrideWithValue(analytics),
            ],
            child: const NovaApp(),
          ),
        );
      } catch (error, stackTrace) {
        await crashReporting.recordError(
          error,
          stackTrace,
          reason: 'bootstrap',
          fatal: true,
        );
        runApp(BootstrapFailureApp(error: error));
      }
    },
    (error, stackTrace) {
      // Anything that escapes the zone above (including errors thrown before the
      // Flutter binding was attached).
      unawaited(
        CrashReportingService().recordError(
          error,
          stackTrace,
          reason: 'Uncaught zone error',
          fatal: true,
        ),
      );
    },
  );
}
