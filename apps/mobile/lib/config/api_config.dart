import 'package:flutter/foundation.dart';

enum Environment {
  development,
  staging,
  production,
}

/// Central API endpoint configuration with release-safety validation.
///
/// The previous implementation only rejected `localhost`/`127.0.0.1` in release
/// builds. It never required HTTPS, so a release build compiled with
/// `--dart-define=API_URL=http://api.example.com` would happily send credentials
/// and audio in the clear. [validateUrl] now enforces HTTPS for every release host,
/// and the platform-level counterpart lives in
/// `android/app/src/main/res/xml/network_security_config.xml`.
class ApiConfig {
  static const String _defaultProdUrl = 'https://api.nova.leadup.tech';
  static const String _defaultStagingUrl = 'https://staging-api.nova.leadup.tech';
  static const String _defaultDevUrl = 'http://10.0.2.2:3001';

  /// Build-time override: `--dart-define=API_URL=https://...`.
  static const String _apiUrlOverride =
      String.fromEnvironment('API_URL', defaultValue: '');

  /// Build-time environment selector: `--dart-define=STAGING=true`.
  static const bool _stagingOverride =
      bool.fromEnvironment('STAGING', defaultValue: false);

  /// Hosts that a release build must never talk to.
  static const List<String> forbiddenReleaseHosts = <String>[
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '10.0.2.2', // Android emulator alias for the host loopback
    '10.0.3.2', // Genymotion equivalent
  ];

  static Environment get currentEnvironment {
    if (kReleaseMode) return Environment.production;
    if (_stagingOverride) return Environment.staging;
    return Environment.development;
  }

  /// The configured base URL before validation, with any trailing slash removed.
  static String get resolvedBaseUrl {
    final raw = _apiUrlOverride.isNotEmpty
        ? _apiUrlOverride
        : switch (currentEnvironment) {
            Environment.production => _defaultProdUrl,
            Environment.staging => _defaultStagingUrl,
            Environment.development => _defaultDevUrl,
          };
    return raw.endsWith('/') ? raw.substring(0, raw.length - 1) : raw;
  }

  /// The validated base URL.
  ///
  /// Throws [StateError] when the configuration is unsafe. Callers that need to
  /// render a friendly failure screen instead of crashing should use [validate].
  static String get baseUrl {
    final url = resolvedBaseUrl;
    final problems = validateUrl(url);
    if (problems.isNotEmpty) {
      throw StateError('Invalid API configuration:\n- ${problems.join('\n- ')}');
    }
    return url;
  }

  /// Returns a list of configuration problems. Empty means the URL is acceptable.
  static List<String> validateUrl(String url) {
    final problems = <String>[];

    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      problems.add('"$url" is not an absolute URL (expected e.g. https://api.example.com).');
      return problems;
    }

    if (uri.scheme != 'http' && uri.scheme != 'https') {
      problems.add('Unsupported scheme "${uri.scheme}" in "$url"; expected http or https.');
    }

    if (kReleaseMode) {
      // Release builds must be encrypted end to end.
      if (uri.scheme != 'https') {
        problems.add(
          'Release builds must use HTTPS, but the API URL is "$url". '
          'Pass --dart-define=API_URL=https://your-api-host.',
        );
      }
      if (forbiddenReleaseHosts.contains(uri.host.toLowerCase())) {
        problems.add(
          'Release builds must not point at a local host, but the API URL host is '
          '"${uri.host}". Pass --dart-define=API_URL=https://your-api-host.',
        );
      }
    }

    return problems;
  }

  /// Validates the resolved configuration. Empty list means "safe to use".
  static List<String> validate() => validateUrl(resolvedBaseUrl);

  /// Convenience for building the WebSocket endpoint that mirrors [baseUrl].
  static String get voiceWs {
    final uri = Uri.parse(baseUrl);
    return uri
        .replace(
          scheme: uri.scheme == 'https' ? 'wss' : 'ws',
          path: '/api/v1/voice/stream',
        )
        .toString();
  }

  // Endpoints
  static String get health => '$baseUrl/health';
  static String get healthz => '$baseUrl/healthz';
  static String get authLogin => '$baseUrl/api/v1/auth/login';
  static String get authRegister => '$baseUrl/api/v1/auth/register';
  static String get authRefresh => '$baseUrl/api/v1/auth/refresh';
  static String get authLogout => '$baseUrl/api/v1/auth/logout';
  static String get conversations => '$baseUrl/api/v1/conversations';
  static String get tasks => '$baseUrl/api/v1/tasks';
  static String get memories => '$baseUrl/api/v1/memories';
  static String get notifications => '$baseUrl/api/v1/notifications';
}
