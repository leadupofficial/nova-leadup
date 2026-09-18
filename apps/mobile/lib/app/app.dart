import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme/nova_theme.dart';
import '../core/voice/wake_word_controller.dart';
import '../services/analytics_service.dart';
import 'providers.dart';
import 'router.dart';

/// Root widget. Owns the router, the theme and the app-lifecycle hooks.
class NovaApp extends ConsumerStatefulWidget {
  const NovaApp({super.key});

  @override
  ConsumerState<NovaApp> createState() => _NovaAppState();
}

class _NovaAppState extends ConsumerState<NovaApp> {
  late final AppLifecycleListener _lifecycleListener;

  @override
  void initState() {
    super.initState();
    _lifecycleListener = AppLifecycleListener(
      onResume: _onResume,
      onDetach: _onDetach,
    );
  }

  @override
  void dispose() {
    _lifecycleListener.dispose();
    super.dispose();
  }

  /// Re-arms wake word listening when the app comes back to the foreground.
  ///
  /// This is the reliable re-arm point: the Android foreground service can be killed
  /// under memory pressure, and Android 15+ does not permit restarting a
  /// `microphone`-type foreground service from a `BOOT_COMPLETED` receiver.
  void _onResume() {
    ref.read(wakeWordStateProvider.notifier).arm();
  }

  void _onDetach() {
    // Best-effort; the platform may kill the process before this completes.
    ref.read(analyticsServiceProvider).logEvent(AnalyticsService.eventAppOpen);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'NOVA',
      debugShowCheckedModeBanner: false,
      theme: NovaTheme.darkTheme,
      routerConfig: ref.watch(routerProvider),
      // Clamp accessibility text scaling so the layouts stay usable at very large
      // system font sizes instead of overflowing.
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        maxScaleFactor: 1.3,
        child: child ?? const SizedBox.shrink(),
      ),
    );
  }
}
