/// NOVA — Remote configuration provider.
///
/// Fetches `/api/v1/device/bootstrap` and exposes the operator-controlled document
/// (feature flags, kill switches, maintenance state, version gate) to the rest of the
/// app.
///
/// Behaviour that matters:
///
///  * **It never throws into the widget tree.** A failed fetch keeps the last good
///    document, or the permissive placeholder if there has never been one. An
///    operator's kill switch should be obeyed; a flaky network should not be
///    mistaken for one.
///  * **It sends the access token when there is one**, so per-user flag overrides
///    apply. Without a token the server serves environment-scoped configuration, and
///    that is still useful (maintenance and the version gate work pre-login).
///  * **It refreshes on app resume and after sign-in**, because there is no push
///    channel: the Flutter app has no FCM integration, so polling at sensible moments
///    is the only way a configuration change reaches a device. The server states the
///    same limitation to the operator.
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/api_config.dart';
import '../api/version_info.dart';
import '../../app/providers.dart';
import 'remote_config.dart';

/// The bootstrap endpoint, derived from the shared base URL so an `--dart-define`
/// override applies here as it does everywhere else.
String get bootstrapEndpoint => '${ApiConfig.baseUrl}/api/v1/device/bootstrap';

/// Fetches the document. Separated from the notifier so it can be unit-tested with a
/// stub client.
class RemoteConfigApi {
  RemoteConfigApi(this._dio);

  final Dio _dio;

  Future<RemoteConfig> fetch({String? accessToken}) async {
    final version = await NovaVersionInfo.current();
    final response = await _dio.get<Map<String, dynamic>>(
      bootstrapEndpoint,
      queryParameters: <String, dynamic>{
        'version': version.version,
        'platform': version.platform,
      },
      options: Options(
        headers: accessToken == null || accessToken.isEmpty
            ? null
            : <String, dynamic>{'Authorization': 'Bearer $accessToken'},
      ),
    );

    final body = response.data;
    if (body == null) {
      throw const FormatException('Empty bootstrap response');
    }
    final data = body['data'];
    if (data is! Map) {
      throw const FormatException('Bootstrap response has no data object');
    }
    return RemoteConfig.fromJson(data.cast<String, dynamic>());
  }
}

final remoteConfigApiProvider = Provider<RemoteConfigApi>(
  (ref) => RemoteConfigApi(ref.watch(dioProvider)),
);

@immutable
class RemoteConfigState {
  const RemoteConfigState({
    required this.config,
    this.loading = false,
    this.lastError,
    this.lastFetchedAt,
  });

  final RemoteConfig config;
  final bool loading;
  final String? lastError;
  final DateTime? lastFetchedAt;

  RemoteConfigState copyWith({
    RemoteConfig? config,
    bool? loading,
    String? lastError,
    DateTime? lastFetchedAt,
    bool clearError = false,
  }) {
    return RemoteConfigState(
      config: config ?? this.config,
      loading: loading ?? this.loading,
      lastError: clearError ? null : (lastError ?? this.lastError),
      lastFetchedAt: lastFetchedAt ?? this.lastFetchedAt,
    );
  }
}

/// Holds the current document and refreshes it.
///
/// This is a Riverpod 3 `Notifier` (the app is on `flutter_riverpod ^3.4.3`, where
/// `StateNotifierProvider` no longer exists). `build()` returns the permissive
/// placeholder rather than fetching: the first fetch is triggered explicitly by the
/// app after the first frame, so remote configuration can never delay startup — the
/// failure mode `startup.dart` was written to eliminate.
class RemoteConfigController extends Notifier<RemoteConfigState> {
  /// Guards against overlapping fetches when resume, sign-in and a manual refresh
  /// coincide.
  Future<RemoteConfig>? _inFlight;

  @override
  RemoteConfigState build() => RemoteConfigState(config: RemoteConfig.placeholder);

  /// Fetches, unless a fetch is already running — in which case it joins that one.
  ///
  /// Joining rather than returning early means a caller that needs a fresh document
  /// (the post-login refresh) still gets one, instead of being handed a stale value by
  /// an unlucky race with the resume handler.
  Future<RemoteConfig> refresh({bool force = false}) {
    final existing = _inFlight;
    if (existing != null) return existing;
    if (!force && !state.config.isStale) {
      return Future<RemoteConfig>.value(state.config);
    }

    final future = _fetch().whenComplete(() => _inFlight = null);
    _inFlight = future;
    return future;
  }

  Future<RemoteConfig> _fetch() async {
    state = state.copyWith(loading: true);
    try {
      String? token;
      try {
        // `currentToken` is the repository's cached session; it is synchronous and
        // returns null before sign-in.
        token = ref.read(authRepositoryProvider).currentToken?.accessToken;
      } catch (_) {
        // No session yet (pre-login). Anonymous configuration is still valid.
        token = null;
      }

      final config = await ref.read(remoteConfigApiProvider).fetch(accessToken: token);
      state = RemoteConfigState(
        config: config,
        loading: false,
        lastFetchedAt: config.fetchedAt,
      );
      return config;
    } catch (error) {
      // Keep whatever we already had. Clearing to the placeholder would drop a
      // previously-received maintenance notice or kill switch on a transient error,
      // which is the wrong direction for a control-plane signal.
      state = state.copyWith(
        loading: false,
        lastError: error.toString(),
      );
      return state.config;
    }
  }
}

final remoteConfigProvider =
    NotifierProvider<RemoteConfigController, RemoteConfigState>(
  RemoteConfigController.new,
);

/// Convenience: the resolved capabilities, defaulting to permissive before the first
/// successful fetch.
final remoteCapabilitiesProvider = Provider<RemoteCapabilities>(
  (ref) => ref.watch(remoteConfigProvider).config.capabilities,
);

/// Reads one flag with an explicit fallback for "the server has no opinion".
///
/// Prefer this over reading `config.flags` directly: a raw map lookup returns null for
/// an unseeded flag, and treating null as false is how a flag rollout accidentally
/// becomes a feature removal.
bool remoteFlagEnabled(WidgetRef ref, String key, {required bool fallback}) {
  return ref.watch(remoteConfigProvider).config.isEnabled(key, fallback: fallback);
}

/// Whether the realtime voice pipeline may start a turn.
///
/// Exposed as its own provider so hot paths (the voice controller's `startTurn`) can
/// read a plain bool instead of reaching into the document, and so the "voice is
/// allowed" question has exactly one definition for both the UI and the controller.
///
/// Unknown configuration is treated as **enabled**: the placeholder document reports
/// all capabilities on, because a fetch that has not happened yet must not silently
/// disable voice.
final voiceCapabilityEnabledProvider = Provider<bool>((ref) {
  final config = ref.watch(remoteConfigProvider).config;
  return config.capabilities.voice && !config.maintenance.enabled;
});

/// Whether NOVA may run proactively for this user, combining the flag and the kill
/// switch. Read by any surface that advertises proactive behaviour.
final proactiveCapabilityEnabledProvider = Provider<bool>((ref) {
  final config = ref.watch(remoteConfigProvider).config;
  return config.capabilities.proactive && !config.maintenance.enabled;
});

/// Whether the wake word may be armed. The kill switch is the server-side switch; the
/// user's own preference is separate and still respected by the controller.
final wakeWordCapabilityEnabledProvider = Provider<bool>((ref) {
  final config = ref.watch(remoteConfigProvider).config;
  return config.isEnabled('WAKE_WORD', fallback: true) &&
      !config.maintenance.enabled;
});
