import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_config.dart';
import '../core/theme/nova_theme.dart';
import '../features/onboarding/splash_page.dart' show NovaGradientText;
import '../services/analytics_service.dart';
import '../services/crash_reporting_service.dart';
import '../services/firebase_backends.dart';
import '../services/logger_service.dart';
import 'app.dart';
import 'bootstrap.dart';
import 'error_apps.dart';
import 'providers.dart';

/// Startup that always renders.
///
/// This file exists because of a device-confirmed defect: on a physical Android 16
/// device a cold start rendered **zero** frames. `main()` awaited
/// `FirebaseActivation.initialize()` before `runApp`, and `Firebase.initializeApp()`
/// — a platform channel with no timeout — never completed and never threw, so
/// neither branch of that method's `try`/`catch` printed, `runApp` was never
/// reached, and the native splash window stayed up for ever.
///
/// Three layers fix it, and all three are needed:
///
///   1. every awaited step is bounded by [BootstrapConfig] timeouts, so a hang
///      degrades exactly like a throw;
///   2. the root widget is installed synchronously, before any of it is awaited,
///      so the first Flutter frame does not depend on a platform channel;
///   3. a watchdog resolves the splash to the app (or a readable failure screen)
///      even if the bootstrap chain outlives every timeout in layer 1.
///
/// The invariants that made the old order worth having are preserved: bootstrap
/// still completes — or is abandoned by the watchdog — before the router that reads
/// `sharedPreferencesProvider` / `authRepositoryProvider` is built.

/// How startup is wired, and how long each of its phases may take.
///
/// Every field is injectable so the whole path is exercised by
/// `test/app/startup_test.dart` without Firebase, a platform channel or a socket.
@immutable
class BootstrapConfig {
  const BootstrapConfig({
    this.loadDependencies = bootstrapDependencies,
    this.initializeFirebase = FirebaseActivation.initialize,
    this.firebaseTimeout = const Duration(seconds: 5),
    this.reportingTimeout = const Duration(seconds: 5),
    this.dependenciesTimeout = const Duration(seconds: 10),
    this.watchdog = const Duration(seconds: 8),
  });

  /// Awaited, with [dependenciesTimeout], before the router is built.
  final Future<BootstrapDependencies> Function() loadDependencies;

  /// Awaited, with [firebaseTimeout], before crash reporting is wired up.
  final Future<FirebaseBackends?> Function() initializeFirebase;

  /// Bound on `Firebase.initializeApp()` and the collection toggles.
  final Duration firebaseTimeout;

  /// Bound on crash reporting / analytics / logger initialisation and on the
  /// pre-flight breadcrumb. None of these may hold up the first frame.
  final Duration reportingTimeout;

  /// Bound on [loadDependencies].
  final Duration dependenciesTimeout;

  /// The last resort: if bootstrap has still not resolved, render anyway.
  ///
  /// Deliberately shorter than the sum of the layer-1 budgets, because the user is
  /// staring at a splash screen the whole time.
  final Duration watchdog;

  static const BootstrapConfig defaults = BootstrapConfig();
}

/// What bootstrap produced, and why it did not when it failed.
typedef BootstrapResult = ({BootstrapDependencies? dependencies, Object? error});

/// Whether bootstrap genuinely finished, as opposed to being abandoned by the
/// watchdog. Read by tests and by the failure screen's diagnostics.
class BootstrapProbe {
  bool _completed = false;

  bool get completed => _completed;

  void markCompleted() => _completed = true;
}

/// The app could not start because `ApiConfig` rejected the build's configuration.
///
/// Carried through [BootstrapResult.error] so the root widget can tell "this build
/// is misconfigured" (reported, but not a bug in startup) from a genuine bootstrap
/// failure, without a second result type.
@immutable
class ConfigurationFailure implements Exception {
  const ConfigurationFailure(this.problems);

  final List<String> problems;

  @override
  String toString() => 'Invalid API configuration:\n- ${problems.join('\n- ')}';
}

/// Runs the pre-`runApp` work, bounded at every step.
///
/// **Never throws.** `CrashReportingService.installGlobalHandlers()` runs first and
/// `runZonedGuarded` wraps it, so an escaping error would still be reported — but a
/// bootstrap that can escape is a bootstrap that can skip `runApp` again, so every
/// failure is turned into a [BootstrapResult] here.
///
/// Note the deliberate change from the old order: `ApiConfig.validate()` is still a
/// fail-fast check that renders its own screen, but it no longer runs before the
/// first frame. Nothing is lost by that — the splash reads no base URL, so no code
/// path can reach a misconfigured URL in the meantime.
Future<BootstrapResult> runBootstrap(BootstrapConfig config) async {
  final crashReporting = CrashReportingService();
  final analytics = AnalyticsService.instance;

  try {
    // Firebase first, so crash reporting is live before anything else can fail —
    // the intent of the original order, now bounded.
    FirebaseBackends? firebase;
    try {
      firebase = await config
          .initializeFirebase()
          .timeout(config.firebaseTimeout);
    } catch (error, stackTrace) {
      // FirebaseActivation already returns null on failure and logs it. This
      // catches the other half of its contract: a *hang*, where no branch ever
      // runs. The app continues on the console backends either way.
      debugPrint('[Bootstrap] Firebase setup did not complete: $error');
      await _ignoringHang(
        crashReporting.recordError(
          error,
          stackTrace,
          reason: 'firebase initialisation',
        ),
        config.reportingTimeout,
      );
    }

    // Wrapped for the same reason as Firebase: these are platform channels too.
    await _ignoringHang(
      crashReporting
          .initialize(enabled: !kDebugMode, backend: firebase?.crash)
          .timeout(config.reportingTimeout),
      config.reportingTimeout,
    );
    crashReporting.installGlobalHandlers();
    await _ignoringHang(
      analytics
          .initialize(enabled: !kDebugMode, backend: firebase?.analytics)
          .timeout(config.reportingTimeout),
      config.reportingTimeout,
    );
    // Synchronous in practice (it flushes a queue); bounded so a later
    // implementation cannot quietly reintroduce the hang.
    await _ignoringHang(
      LoggerService().initialize().timeout(config.reportingTimeout),
      config.reportingTimeout,
    );
    await _ignoringHang(
      crashReporting.log('Bootstrap started'),
      config.reportingTimeout,
    );

    final problems = ApiConfig.validate();
    if (problems.isNotEmpty) {
      await _ignoringHang(
        crashReporting.log('Refusing to start: ${problems.join(" | ")}'),
        config.reportingTimeout,
      );
      return (dependencies: null, error: ConfigurationFailure(problems));
    }

    return (
      dependencies: await config
          .loadDependencies()
          .timeout(config.dependenciesTimeout),
      error: null,
    );
  } catch (error, stackTrace) {
    // A swallowed failure is how the original defect stayed invisible: log it,
    // report it, and return it so the caller can render a screen that says so.
    debugPrint('[Bootstrap] failed: $error\n$stackTrace');
    await _ignoringHang(
      crashReporting.recordError(
        error,
        stackTrace,
        reason: 'bootstrap',
        fatal: true,
      ),
      config.reportingTimeout,
    );
    return (dependencies: null, error: error);
  }
}

/// Awaits [future] but returns control after [budget], swallowing its failure.
///
/// `Future.timeout` is used throughout rather than a cancellable wrapper on
/// purpose: none of the underlying operations has a cancel path, and pretending to
/// cancel one would only leak a future that resolves later against a tree that has
/// already moved on.
Future<void> _ignoringHang(Future<void>? future, Duration budget) async {
  if (future == null) return;
  try {
    await future.timeout(budget);
  } catch (error) {
    debugPrint('[Bootstrap] a reporting call failed after $budget: $error');
  }
}

/// Handle to the installed root, so tests can assert the first frame without
/// reaching into `runApp`.
class NovaBootstrapRoot {
  NovaBootstrapRoot({BootstrapProbe? probe}) : probe = probe ?? BootstrapProbe();

  /// Records whether bootstrap finished before the watchdog fired.
  final BootstrapProbe probe;
}

/// Installs the root widget synchronously, then bootstraps behind it.
///
/// Returns as soon as the splash is on screen. [installRoot] defaults to `runApp`;
/// tests pass a function that forwards to `WidgetTester.pumpWidget` instead.
NovaBootstrapRoot runNovaApp({
  BootstrapConfig config = BootstrapConfig.defaults,
  ValueChanged<Widget> installRoot = runApp,
  BootstrapProbe? probe,
}) {
  final root = NovaBootstrapRoot(probe: probe);

  // Layer 2: `runApp` happens here, before anything is awaited. The previous
  // implementation awaited a platform channel first, which is why the device
  // rendered zero frames.
  installRoot(
    _NovaBootstrapper(
      config: config,
      bootstrap: runBootstrap(config),
      probe: root.probe,
    ),
  );

  return root;
}

/// Splash first, then the app (or a readable failure screen) once bootstrap
/// resolves — and unconditionally when the watchdog fires.
class _NovaBootstrapper extends StatefulWidget {
  const _NovaBootstrapper({
    required this.config,
    required this.bootstrap,
    required this.probe,
  });

  final BootstrapConfig config;
  final Future<BootstrapResult> bootstrap;
  final BootstrapProbe probe;

  @override
  State<_NovaBootstrapper> createState() => _NovaBootstrapperState();
}

class _NovaBootstrapperState extends State<_NovaBootstrapper> {
  Timer? _watchdog;
  bool _settled = false;
  Object? _error;
  BootstrapDependencies? _dependencies;
  Widget? _app;

  @override
  void initState() {
    super.initState();

    // Layer 3. `_resolve` is idempotent, so whichever of the bootstrap and the
    // watchdog arrives first wins and the other becomes a no-op.
    _watchdog = Timer(widget.config.watchdog, () {
      _resolve(
        TimeoutException(
          'NOVA did not finish starting within '
          '${widget.config.watchdog.inSeconds}s.',
          widget.config.watchdog,
        ),
      );
    });

    widget.bootstrap.then(
      (result) {
        widget.probe.markCompleted();
        _resolve(result.error, dependencies: result.dependencies);
      },
      // runBootstrap does not throw; this is the belt to that pair of braces.
      onError: (Object error) => _resolve(error),
    );
  }

  void _resolve(Object? error, {BootstrapDependencies? dependencies}) {
    if (_settled) {
      // The watchdog already gave the user a screen. Still report the late
      // outcome, so a bootstrap that hangs and then fails is not invisible.
      if (error != null) {
        debugPrint('[Bootstrap] resolved after the watchdog fired: $error');
      }
      return;
    }
    _settled = true;
    _watchdog?.cancel();
    _watchdog = null;
    if (!mounted) return;
    // setState, so the frame that replaces the splash is scheduled by Flutter
    // rather than by a callback that might land outside the build phase.
    setState(() {
      _error = error;
      _dependencies = dependencies;
    });
  }

  @override
  void dispose() {
    _watchdog?.cancel();
    super.dispose();
  }

  Widget _buildApp(BootstrapDependencies dependencies) {
    // Built once. ProviderScope's overrides are assembled here rather than in a
    // helper because Riverpod does not export the `Override` type used by
    // `ProviderScope.overrides`, but does infer it from a list literal.
    return _app ??= ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(dependencies.preferences),
        secureStorageProvider.overrideWithValue(dependencies.secureStorage),
        authRepositoryProvider.overrideWithValue(dependencies.authRepository),
        onboardingServiceProvider
            .overrideWithValue(dependencies.onboardingService),
        networkInfoServiceProvider
            .overrideWithValue(dependencies.networkInfoService),
        crashReportingServiceProvider
            .overrideWithValue(CrashReportingService()),
        analyticsServiceProvider.overrideWithValue(AnalyticsService.instance),
      ],
      child: const NovaApp(),
    );
  }

  Widget _failure(Object error) {
    if (error is ConfigurationFailure) {
      return ConfigurationErrorApp(problems: error.problems);
    }
    return BootstrapFailureApp(error: error);
  }

  @override
  Widget build(BuildContext context) {
    if (!_settled) return const _BootstrapSplash();

    final error = _error;
    if (error != null) {
      return KeyedSubtree(
        key: const ValueKey<String>('nova-bootstrap-failure'),
        child: _failure(error),
      );
    }

    final dependencies = _dependencies;
    if (dependencies == null) {
      // Only reachable if bootstrap reported success without dependencies, which
      // BootstrapFailureApp surfaces rather than rendering a broken router.
      return const KeyedSubtree(
        key: ValueKey<String>('nova-bootstrap-failure'),
        child: BootstrapFailureApp(
          error: 'Bootstrap completed without the platform stores.',
        ),
      );
    }

    return KeyedSubtree(
      key: const ValueKey<String>('nova-bootstrap-app'),
      child: _buildApp(dependencies),
    );
  }
}

/// The frame the user gets while bootstrap runs.
///
/// Renders standalone (its own [MaterialApp]) so it is a real, complete frame even
/// though no provider has been installed yet — which is the point of rendering
/// before bootstrap resolves. Deliberately static: an animated splash is wasted work
/// in the one phase whose job is to be short, and another aura is one more thing
/// that can go wrong before the first frame.
class _BootstrapSplash extends StatelessWidget {
  const _BootstrapSplash();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NOVA',
      debugShowCheckedModeBanner: false,
      theme: NovaTheme.darkTheme,
      home: Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              NovaGradientText(
                'NOVA',
                style: Theme.of(context).textTheme.displayLarge!.copyWith(
                      fontSize: 44,
                      letterSpacing: -1.76,
                    ),
              ),
              const SizedBox(height: 24),
              const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(height: 16),
              Text(
                'STARTING UP',
                style: Theme.of(context)
                    .textTheme
                    .labelSmall!
                    .copyWith(letterSpacing: 0.96),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
