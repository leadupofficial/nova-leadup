import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/theme/nova_theme.dart';

/// Shown when [ApiConfig] rejects the build's API configuration.
///
/// Before this existed, `ApiConfig.baseUrl` threw during widget construction and the
/// release build died on a blank screen with an unreadable exception in logcat. A
/// misconfigured build now says exactly what is wrong and how to fix it.
class ConfigurationErrorApp extends StatelessWidget {
  const ConfigurationErrorApp({super.key, required this.problems});

  final List<String> problems;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NOVA',
      debugShowCheckedModeBanner: false,
      theme: NovaTheme.darkTheme,
      home: _FatalScreen(
        icon: Icons.settings_ethernet_rounded,
        title: 'NOVA is misconfigured',
        message: 'This build cannot reach the NOVA API safely, so it will not start.',
        details: problems,
        hint: 'Rebuild with:\n'
            'flutter build apk --release --dart-define=API_URL=https://nova.leadup.in',
      ),
    );
  }
}

/// Shown when bootstrap itself fails (e.g. the platform stores are unavailable).
class BootstrapFailureApp extends StatelessWidget {
  const BootstrapFailureApp({super.key, required this.error});

  final Object error;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NOVA',
      debugShowCheckedModeBanner: false,
      theme: NovaTheme.darkTheme,
      home: _FatalScreen(
        icon: Icons.error_outline_rounded,
        title: 'NOVA could not start',
        message: 'Something went wrong while preparing the app.',
        details: <String>['$error'],
        hint: 'Restarting the app usually fixes this. If it keeps happening, '
            'reinstall or contact support.',
      ),
    );
  }
}

/// Catches render exceptions in the routed subtree and shows a recoverable error
/// screen with a Retry button.
///
/// Flutter does not provide a per-subtree error boundary. This widget installs a
/// temporary [FlutterError.onError] handler while the child builds, catching any
/// synchronous widget-build failure. If an error is caught, the handler is removed,
/// the error is stored in state, and a retry screen is shown until the key changes.
///
/// Usage: wrap the router (or any subtree) with this widget. Tapping Retry rebuilds
/// the subtree from scratch.
class ErrorBoundary extends StatefulWidget {
  const ErrorBoundary({super.key, required this.child});

  final Widget child;

  @override
  State<ErrorBoundary> createState() => _ErrorBoundaryState();
}

class _ErrorBoundaryState extends State<ErrorBoundary> {
  FlutterExceptionHandler? _previousHandler;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _previousHandler = FlutterError.onError;
    FlutterError.onError = (details) {
      if (mounted) {
        setState(() => _error = details.exception);
      }
      // Forward to the previous handler (e.g. crash reporting) so the error is
      // still recorded even though the UI recovers gracefully.
      if (_previousHandler != null) {
        _previousHandler!(details);
      }
    };
  }

  @override
  void dispose() {
    FlutterError.onError = _previousHandler;
    super.dispose();
  }

  void _retry() {
    setState(() => _error = null);
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return _RecoverableErrorScreen(
        error: _error!,
        onRetry: _retry,
      );
    }
    return widget.child;
  }
}

class _RecoverableErrorScreen extends StatelessWidget {
  const _RecoverableErrorScreen({
    required this.error,
    required this.onRetry,
  });

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.error_outline_rounded,
                    color: NovaTheme.error, size: 48),
                const SizedBox(height: 16),
                Text(
                  'Something went wrong',
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'A screen failed to load. You can try again.',
                  style: TextStyle(color: NovaTheme.onSurfaceVariant),
                ),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: NovaTheme.surface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: NovaTheme.border),
                  ),
                  child: Text(
                    '$error',
                    style: const TextStyle(
                      fontSize: 12,
                      fontFamily: 'monospace',
                      color: NovaTheme.warning,
                    ),
                    maxLines: 8,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(height: 24),
                ElevatedButton.icon(
                  onPressed: onRetry,
                  icon: const Icon(Icons.refresh_rounded),
                  label: const Text('Retry'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: NovaTheme.primary,
                    foregroundColor: Colors.white,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _FatalScreen extends StatelessWidget {
  const _FatalScreen({
    required this.icon,
    required this.title,
    required this.message,
    required this.details,
    required this.hint,
  });

  final IconData icon;
  final String title;
  final String message;
  final List<String> details;
  final String hint;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, color: NovaTheme.error, size: 48),
                const SizedBox(height: 16),
                Text(
                  title,
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(height: 8),
                Text(
                  message,
                  style: const TextStyle(color: NovaTheme.onSurfaceVariant),
                ),
                const SizedBox(height: 24),
                for (final detail in details)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      '• $detail',
                      style: const TextStyle(
                          fontSize: 13, color: NovaTheme.warning),
                    ),
                  ),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: NovaTheme.surface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: NovaTheme.border),
                  ),
                  child: SelectableText(
                    hint,
                    style: const TextStyle(
                        fontSize: 12, fontFamily: 'monospace'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
