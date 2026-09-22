import 'dart:async';

import 'package:flutter/material.dart';

import 'app/startup.dart';
import 'services/crash_reporting_service.dart';

/// NOVA's entry point.
///
/// This used to be a stub that rendered a centred "NOVA" label with no routing, no
/// providers and no auth wiring, so none of the services in `lib/` were ever reached.
///
/// **Startup order is a correctness property here.** It used to be a linear list of
/// `await`s — `FirebaseActivation.initialize()`, crash reporting, analytics, the
/// logger, `ApiConfig.validate()`, `bootstrapDependencies()` — every one of them in
/// front of `runApp`. On a physical Android 16 device the first of those,
/// `Firebase.initializeApp()`, never completed and never threw, so `runApp` was
/// never reached, the native splash window stayed up, and `dumpsys gfxinfo` reported
/// `Total frames rendered: 0` after thirty seconds.
///
/// The order now is:
///   1. the Flutter binding, synchronously;
///   2. the global error handlers, synchronously, so anything after this is
///      reported rather than silently dropped;
///   3. `runNovaApp`, which installs the root widget **synchronously** and shows a
///      real splash frame;
///   4. bootstrap behind that frame, bounded at every step and watched by a
///      watchdog, which then swaps in the app or a readable failure screen.
///
/// See `lib/app/startup.dart` for the three layers and why each one is needed.
void main() {
  runZonedGuarded<Future<void>>(
    () async {
      WidgetsFlutterBinding.ensureInitialized();

      final crashReporting = CrashReportingService();
      crashReporting.installGlobalHandlers();

      // Returns as soon as the splash is on screen; bootstrap continues behind it.
      runNovaApp();

      await crashReporting.log('NOVA process started');
    },
    (error, stackTrace) {
      // Anything that escapes the zone above (including errors thrown before the
      // Flutter binding was attached).
      unawaited(
        CrashReportingService()
            .recordError(
              error,
              stackTrace,
              reason: 'Uncaught zone error',
              fatal: true,
            )
            // A report that hangs must not become a second hang.
            .timeout(const Duration(seconds: 5))
            .catchError((Object reportingFailure) {
          debugPrint('[Crashlytics] zone-error report failed: $reportingFailure');
        }),
      );
    },
  );
}
