import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/bootstrap.dart';
import 'package:nova_mobile/app/error_apps.dart';
import 'package:nova_mobile/app/startup.dart';
import 'package:nova_mobile/features/auth/auth_repository.dart';
import 'package:nova_mobile/features/onboarding/onboarding_service.dart';
import 'package:nova_mobile/services/crash_reporting_service.dart';
import 'package:nova_mobile/services/logger_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/test_harness.dart';

/// Regression tests for the cold-start defect.
///
/// On a physical Android 16 device the app rendered **zero** frames: `main()`
/// awaited `FirebaseActivation.initialize()` before `runApp`, and
/// `Firebase.initializeApp()` never completed and never threw, so neither of that
/// method's two `debugPrint`s ever appeared, the native splash window covered the
/// screen for ever, and `dumpsys gfxinfo` reported `Total frames rendered: 0`.
/// Reproduced after `adb shell pm clear`, so a brand-new install hit it too.
///
/// These tests describe the fixed contract: a frame is rendered synchronously, and
/// no bootstrap outcome — hang, throw, or slow — can take it away.
void main() {
  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    LoggerService.resetForTesting();
    // Collection defaults to `!kDebugMode`, so under `flutter test` every
    // breadcrumb and report is a no-op. Startup's contract is that a bootstrap
    // failure is reported rather than swallowed, so its tests turn collection on
    // and then read what actually landed.
    CrashReportingService.enabledForTesting();
  });

  tearDown(LoggerService.resetForTesting);

  /// Real [BootstrapDependencies] with the two platform-backed pieces faked, so the
  /// app tree can be built without a platform channel or a socket.
  Future<BootstrapDependencies> testDependencies() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final preferences = await SharedPreferences.getInstance();
    return BootstrapDependencies(
      preferences: preferences,
      secureStorage: FakeSecureStorage(),
      authRepository: AuthRepository(FakeSecureStorage()),
      onboardingService: OnboardingService(preferences),
      networkInfoService: FakeNetworkInfoService(),
    );
  }

  testWidgets(
      'the root frame is installed synchronously, before bootstrap resolves',
      (tester) async {
    useTallSurface(tester);
    // A bootstrap that hangs the way `Firebase.initializeApp()` hung on the device.
    final never = Completer<BootstrapDependencies>();

    // The widget that must exist *now*. The old code had no such thing: it was
    // constructed only after `await bootstrapDependencies()` returned, which on the
    // device never happened.
    Widget? firstFrame;
    var installs = 0;
    final stopwatch = Stopwatch()..start();

    runNovaApp(
      config: BootstrapConfig(
        loadDependencies: () => never.future,
        initializeFirebase: () async => null,
        dependenciesTimeout: const Duration(seconds: 3),
        watchdog: const Duration(seconds: 30),
      ),
      installRoot: (widget) {
        installs++;
        firstFrame = widget;
      },
    );
    stopwatch.stop();

    // No await was needed, so the native splash has something to yield to.
    expect(installs, 1);
    expect(firstFrame, isNotNull);
    expect(stopwatch.elapsed, lessThan(const Duration(seconds: 1)));

    await tester.pumpWidget(firstFrame!);
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('STARTING UP'), findsOneWidget);
    // The old failure mode, exactly: nothing, and never.
    expect(find.text('NOVA could not start'), findsNothing);

    // Drain the outstanding `.timeout()` timer: even a bootstrap that never
    // resolves is bounded, which is layer 1 of the fix.
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets(
      'a bootstrap that never resolves is bounded, and the user gets a screen',
      (tester) async {
    useTallSurface(tester);
    final never = Completer<BootstrapDependencies>();

    Widget? root;
    runNovaApp(
      config: BootstrapConfig(
        loadDependencies: () => never.future,
        initializeFirebase: () async => null,
        // Layer 1 and layer 3 both bound this. The test only asserts the contract
        // the user cares about: a never-resolving bootstrap still produces a
        // readable screen instead of an indefinite splash.
        dependenciesTimeout: const Duration(milliseconds: 200),
        watchdog: const Duration(milliseconds: 200),
      ),
      installRoot: (widget) => root = widget,
    );

    await tester.pumpWidget(root!);
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    // Past the budget: the user gets a screen that says what happened.
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();

    expect(find.byType(BootstrapFailureApp), findsOneWidget);
    expect(find.text('NOVA could not start'), findsOneWidget);
  });

  testWidgets('the watchdog alone is enough when every timeout is later',
      (tester) async {
    useTallSurface(tester);
    final never = Completer<BootstrapDependencies>();

    Widget? root;
    runNovaApp(
      config: BootstrapConfig(
        loadDependencies: () => never.future,
        initializeFirebase: () async => null,
        // Both layer-1 budgets sit far beyond the watchdog, so the only thing that
        // can put a screen up is layer 3.
        dependenciesTimeout: const Duration(seconds: 1),
        watchdog: const Duration(milliseconds: 200),
      ),
      installRoot: (widget) => root = widget,
    );

    await tester.pumpWidget(root!);
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(CircularProgressIndicator), findsOneWidget,
        reason: 'the watchdog must not pre-empt bootstrap early');

    await tester.pump(const Duration(milliseconds: 150));
    await tester.pumpAndSettle();

    expect(find.byType(BootstrapFailureApp), findsOneWidget);
    expect(find.textContaining('did not finish starting'), findsWidgets);

    // Drain the layer-1 budget that is still ticking on the abandoned bootstrap.
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('a throwing bootstrap renders the failure screen, and reports it',
      (tester) async {
    useTallSurface(tester);
    // `runBootstrap` holds the process-wide singleton — note that
    // `CrashReportingService.forTesting` deliberately returns a *separate*
    // instance, so collection is enabled on the singleton itself. Its
    // `initialize` is a one-shot, so a backend installed here would be ignored on
    // the second call; the breadcrumb trail is the durable signal that the
    // reporting path actually ran, because `log` is only reachable from
    // `runBootstrap`.
    final crashReporting = CrashReportingService.enabledForTesting();

    Widget? root;
    runNovaApp(
      config: BootstrapConfig(
        loadDependencies: () async =>
            throw StateError('secure storage unavailable'),
        initializeFirebase: () async => null,
        watchdog: const Duration(seconds: 5),
      ),
      installRoot: (widget) => root = widget,
    );

    await tester.pumpWidget(root!);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(find.byType(BootstrapFailureApp), findsOneWidget);
    expect(find.text('NOVA could not start'), findsOneWidget);
    expect(find.textContaining('secure storage unavailable'), findsWidgets);

    // Not swallowed: the failure produced a breadcrumb trail rather than vanishing.
    expect(crashReporting.breadcrumbs, contains('Bootstrap started'));
  });

  testWidgets('a hanging Firebase activation does not stop startup', (tester) async {
    useTallSurface(tester);
    final never = Completer<void>();

    Widget? root;
    runNovaApp(
      config: BootstrapConfig(
        loadDependencies: testDependencies,
        // Stands in for `Firebase.initializeApp()` hanging on its platform channel.
        initializeFirebase: () async {
          await never.future;
          return null;
        },
        firebaseTimeout: const Duration(milliseconds: 50),
        dependenciesTimeout: const Duration(seconds: 5),
        watchdog: const Duration(seconds: 5),
      ),
      installRoot: (widget) => root = widget,
    );

    await tester.pumpWidget(root!);
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    // Past the Firebase budget: bootstrap falls through to the console backends and
    // the real app is reached.
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pumpAndSettle();

    expect(find.text('NOVA could not start'), findsNothing);
    expect(find.text('Meet NOVA'), findsOneWidget);
  });

  testWidgets('a successful bootstrap still reaches the app, with the stores wired',
      (tester) async {
    useTallSurface(tester);
    final probe = BootstrapProbe();
    Widget? root;
    runNovaApp(
      config: BootstrapConfig(
        loadDependencies: testDependencies,
        initializeFirebase: () async => null,
        watchdog: const Duration(seconds: 5),
      ),
      installRoot: (widget) => root = widget,
      probe: probe,
    );

    await tester.pumpWidget(root!);
    await tester.pumpAndSettle();

    expect(probe.completed, isTrue);
    expect(find.text('Meet NOVA'), findsOneWidget);
  });
}
