/// NOVA — Remote configuration delivered by the admin Control Center.
///
/// This is the client half of the operator control plane. Before it existed, the
/// app fetched **no** remote configuration of any kind: there was no feature flag,
/// kill switch, maintenance mode, minimum-version or force-update handling anywhere
/// in `lib/`. The server already had a `feature_flags` table with an admin screen, so
/// toggling a flag in the console changed a row and nothing else.
///
/// The contract is `GET /api/v1/device/bootstrap` (see
/// `services/api/src/routes/device-bootstrap.ts`). Design rules:
///
///  * **Unknown flags default to the caller's `fallback`, never to `false` blindly.**
///    A flag the server has not seeded must not switch off an existing feature, so
///    every lookup says what "absent" means.
///  * **A failed fetch is not the same as a disabled feature.** [RemoteConfig.unknown]
///    marks "we have not heard from the server", and [isEnabled] still consults the
///    fallback so a network blip cannot disable voice for a user mid-conversation.
///  * **`capabilities` is authoritative for go/no-go.** It already folds the kill
///    switches together server-side, so the client does not re-derive that logic and
///    cannot get it out of step.
library;

/// One flag's evaluation, including why the server decided it.
///
/// `reason` and `source` exist so a support engineer can answer "why does this user
/// not have proactive follow-ups" without a database session.
class RemoteFlag {
  const RemoteFlag({
    required this.key,
    required this.enabled,
    this.source = 'unknown',
    this.rolloutPercent,
    this.reason = '',
  });

  final String key;
  final bool enabled;

  /// `user_override` | `organization_override` | `environment_override` |
  /// `global_rollout` | `global` | `default`.
  final String source;
  final int? rolloutPercent;
  final String reason;

  factory RemoteFlag.fromJson(String key, Map<String, dynamic> json) {
    return RemoteFlag(
      key: key,
      enabled: json['enabled'] == true,
      source: (json['source'] as String?) ?? 'unknown',
      rolloutPercent: json['rolloutPercent'] is num
          ? (json['rolloutPercent'] as num).toInt()
          : null,
      reason: (json['reason'] as String?) ?? '',
    );
  }
}

/// Which capabilities the server says are usable right now.
///
/// Every field is already the *combined* answer of the relevant feature flag and its
/// emergency kill switch. A client must not try to combine them itself.
class RemoteCapabilities {
  const RemoteCapabilities({
    required this.ai,
    required this.voice,
    required this.stt,
    required this.tts,
    required this.avatar,
    required this.overlay,
    required this.notifications,
    required this.realtime,
    required this.memory,
    required this.tasks,
    required this.reminders,
    required this.proactive,
    required this.background,
  });

  final bool ai;
  final bool voice;
  final bool stt;
  final bool tts;
  final bool avatar;
  final bool overlay;
  final bool notifications;
  final bool realtime;
  final bool memory;
  final bool tasks;
  final bool reminders;
  final bool proactive;
  final bool background;

  /// Everything on. The default before the first successful fetch, and the value a
  /// caller uses to mean "assume the platform is healthy".
  static const RemoteCapabilities allEnabled = RemoteCapabilities(
    ai: true,
    voice: true,
    stt: true,
    tts: true,
    avatar: true,
    overlay: true,
    notifications: true,
    realtime: true,
    memory: true,
    tasks: true,
    reminders: true,
    proactive: true,
    background: true,
  );

  factory RemoteCapabilities.fromJson(Map<String, dynamic> json) {
    bool read(String key) => json[key] != false; // absent means enabled
    return RemoteCapabilities(
      ai: read('ai'),
      voice: read('voice'),
      stt: read('stt'),
      tts: read('tts'),
      avatar: read('avatar'),
      overlay: read('overlay'),
      notifications: read('notifications'),
      realtime: read('realtime'),
      memory: read('memory'),
      tasks: read('tasks'),
      reminders: read('reminders'),
      proactive: read('proactive'),
      background: read('background'),
    );
  }
}

/// Maintenance state, shown to the user as a blocking notice.
class RemoteMaintenance {
  const RemoteMaintenance({required this.enabled, required this.message});

  final bool enabled;
  final String message;

  static const RemoteMaintenance none = RemoteMaintenance(
    enabled: false,
    message: '',
  );

  factory RemoteMaintenance.fromJson(Map<String, dynamic> json) {
    return RemoteMaintenance(
      enabled: json['enabled'] == true,
      message: (json['message'] as String?) ?? '',
    );
  }
}

/// The version gate.
class RemoteVersionGate {
  const RemoteVersionGate({
    required this.minimum,
    required this.latest,
    required this.forceUpdate,
    required this.clientVersion,
    required this.updateRequired,
    required this.updateRecommended,
  });

  final String minimum;
  final String latest;
  final bool forceUpdate;
  final String? clientVersion;

  /// Computed server-side from `minimum` — the client is too old to be supported.
  final bool updateRequired;

  /// Computed server-side from `latest` — a newer build exists but this one works.
  final bool updateRecommended;

  static const RemoteVersionGate none = RemoteVersionGate(
    minimum: '0.0.0',
    latest: '0.0.0',
    forceUpdate: false,
    clientVersion: null,
    updateRequired: false,
    updateRecommended: false,
  );

  factory RemoteVersionGate.fromJson(Map<String, dynamic> json) {
    return RemoteVersionGate(
      minimum: (json['minimum'] as String?) ?? '0.0.0',
      latest: (json['latest'] as String?) ?? '0.0.0',
      forceUpdate: json['forceUpdate'] == true,
      clientVersion: json['clientVersion'] as String?,
      updateRequired: json['updateRequired'] == true,
      updateRecommended: json['updateRecommended'] == true,
    );
  }
}

/// The whole remote-configuration document.
class RemoteConfig {
  const RemoteConfig({
    required this.flags,
    required this.flagDetails,
    required this.maintenance,
    required this.version,
    required this.capabilities,
    required this.publicConfig,
    required this.fetchedAt,
    required this.ttlSeconds,
    required this.unknown,
  });

  final Map<String, bool> flags;
  final Map<String, RemoteFlag> flagDetails;
  final RemoteMaintenance maintenance;
  final RemoteVersionGate version;
  final RemoteCapabilities capabilities;

  /// Public configuration only. The server never sends anything in the
  /// `private` or `secret` scope through this document.
  final Map<String, String?> publicConfig;

  final DateTime fetchedAt;
  final int ttlSeconds;

  /// True when the document is a placeholder because no fetch has succeeded yet.
  ///
  /// Kept distinct from "the server said everything is off" so the UI never tells a
  /// user a feature is disabled when the truth is that NOVA could not be reached.
  final bool unknown;

  /// A placeholder used before the first fetch, and as the value returned when a
  /// fetch fails and no earlier document exists.
  static final RemoteConfig placeholder = RemoteConfig(
    flags: const <String, bool>{},
    flagDetails: const <String, RemoteFlag>{},
    maintenance: RemoteMaintenance.none,
    version: RemoteVersionGate.none,
    capabilities: RemoteCapabilities.allEnabled,
    publicConfig: const <String, String?>{},
    fetchedAt: DateTime.fromMillisecondsSinceEpoch(0),
    ttlSeconds: 60,
    unknown: true,
  );

  bool get isStale =>
      unknown || DateTime.now().difference(fetchedAt).inSeconds > ttlSeconds;

  factory RemoteConfig.fromJson(Map<String, dynamic> json) {
    final rawFlags = (json['flags'] as Map?) ?? const <String, dynamic>{};
    final flags = <String, bool>{};
    rawFlags.forEach((key, value) {
      flags['$key'] = value == true;
    });

    final details = <String, RemoteFlag>{};
    final rawDetails = json['flagDetails'];
    if (rawDetails is List) {
      for (final entry in rawDetails) {
        if (entry is Map) {
          final map = entry.cast<String, dynamic>();
          final key = map['key'] as String?;
          if (key != null) details[key] = RemoteFlag.fromJson(key, map);
        }
      }
    }

    final rawConfig = (json['config'] as Map?) ?? const <String, dynamic>{};
    final publicConfig = <String, String?>{};
    rawConfig.forEach((key, value) {
      publicConfig['$key'] = value?.toString();
    });

    return RemoteConfig(
      flags: flags,
      flagDetails: details,
      maintenance: RemoteMaintenance.fromJson(
        ((json['maintenance'] as Map?) ?? const <String, dynamic>{})
            .cast<String, dynamic>(),
      ),
      version: RemoteVersionGate.fromJson(
        ((json['version'] as Map?) ?? const <String, dynamic>{})
            .cast<String, dynamic>(),
      ),
      capabilities: RemoteCapabilities.fromJson(
        ((json['capabilities'] as Map?) ?? const <String, dynamic>{})
            .cast<String, dynamic>(),
      ),
      publicConfig: publicConfig,
      fetchedAt: DateTime.now(),
      ttlSeconds: (json['ttlSeconds'] as num?)?.toInt() ?? 60,
      unknown: false,
    );
  }

  /// Whether a flag is on, given what "no flag" should mean.
  ///
  /// [fallback] is required rather than defaulted: the whole point is that the caller
  /// states the pre-flag behaviour, so introducing a flag can never silently disable a
  /// feature for users the server has not decided about.
  bool isEnabled(String key, {required bool fallback}) {
    if (unknown) return fallback;
    return flags[key] ?? fallback;
  }

  /// The evaluation record for a flag, when the server supplied one.
  RemoteFlag? detailFor(String key) => flagDetails[key];

  /// A public config value, or null when unset.
  String? configValue(String key) => publicConfig[key];
}
