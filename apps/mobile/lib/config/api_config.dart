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
  /// The single NOVA deployment.
  ///
  /// Both debug and release builds default to this host, deliberately. The previous
  /// defaults were `http://10.0.2.2:3001` for debug (the Android *emulator's* alias for
  /// the host loopback, which resolves to nothing on a real phone) and
  /// `https://api.nova.leadup.tech` for release (a host that is not reachable). Debug and
  /// release now behave identically, so what you test on a device is what ships.
  ///
  /// Point a build somewhere else explicitly when you need to:
  ///   flutter build apk --debug --dart-define=API_URL=http://localhost:3001
  static const String _defaultProdUrl = 'https://nova.leadup.in';

  static const String _defaultStagingUrl = 'https://staging-api.nova.leadup.tech';

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
  ///
  /// Order of precedence: explicit `--dart-define=API_URL`, then staging when selected,
  /// then the single production host — for debug and release alike.
  static String get resolvedBaseUrl {
    final raw = _apiUrlOverride.isNotEmpty
        ? _apiUrlOverride
        : switch (currentEnvironment) {
            Environment.production => _defaultProdUrl,
            Environment.staging => _defaultStagingUrl,
            // Debug builds also target the real server so a test build exercises the
            // same API as a release build. Opt into a local API with
            // --dart-define=API_URL=http://localhost:3001.
            Environment.development => _defaultProdUrl,
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
  static String get me => '$baseUrl/api/v1/auth/me';
  static String get conversations => '$baseUrl/api/v1/conversations';
  static String get chat => '$baseUrl/api/v1/chat';
  static String get tasks => '$baseUrl/api/v1/tasks';
  static String get memories => '$baseUrl/api/v1/memories';
  static String get reminders => '$baseUrl/api/v1/reminders';
  static String get notifications => '$baseUrl/api/v1/notifications';
  static String get activity => '$baseUrl/api/v1/activity';
  static String get recordings => '$baseUrl/api/v1/recordings';
  static String get tools => '$baseUrl/api/v1/tools';
  static String get approvals => '$baseUrl/api/v1/tools/approvals';
  static String get consent => '$baseUrl/api/v1/consent';

  /// `services/api` mounts settings as sub-resources, so there is no
  /// `GET /api/v1/settings` — that path 404s. Each screen targets its own path.
  static String get settingsProfile => '$baseUrl/api/v1/settings/profile';
  static String get settingsPreferences =>
      '$baseUrl/api/v1/settings/preferences';
  static String get settingsPrivacy => '$baseUrl/api/v1/settings/privacy';
  static String get settingsPersona => '$baseUrl/api/v1/settings/persona';
  static String get settingsAvatars => '$baseUrl/api/v1/settings/avatars';
  static String get settingsCompanion => '$baseUrl/api/v1/settings/companion';

  // ── Path builders ─────────────────────────────────────────────────────────
  /// Conversations: `/conversations/:id`
  static String conversation(String id) => '$conversations/$id';

  /// Messages within a conversation: `/conversations/:id/messages`
  static String conversationMessages(String id) =>
      '${conversation(id)}/messages';

  static String task(String id) => '$tasks/$id';
  static String memory(String id) => '$memories/$id';
  static String reminder(String id) => '$reminders/$id';
  static String avatar(String id) => '$settingsAvatars/$id';
  static String recording(String id) => '$recordings/$id';
  static String recordingSummary(String id) => '${recording(id)}/summary';
  static String approvalDecision(String id) => '$approvals/$id/decide';
}
