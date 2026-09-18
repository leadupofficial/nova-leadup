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
            'flutter build apk --release --dart-define=API_URL=https://api.nova.leadup.tech',
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
                      style: const TextStyle(fontSize: 13, color: NovaTheme.warning),
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
                    style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
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
