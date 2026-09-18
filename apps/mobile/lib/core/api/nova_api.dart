import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../config/api_config.dart';
import '../../services/network_service.dart';
import 'models.dart';

/// Error surfaced to the UI for any non-2xx feature call.
///
/// The app previously let pages swallow exceptions and render "nothing found",
/// which made a 401 indistinguishable from an empty list. Screens should render
/// [NovaApiException.message] instead.
class NovaApiException implements Exception {
  const NovaApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  bool get isUnauthorized => statusCode == 401;
  bool get isNotFound => statusCode == 404;

  @override
  String toString() => 'NovaApiException(${statusCode ?? '-'}): $message';
}

/// Thin typed wrapper over [NetworkService] for every feature the API actually
/// implements. Shapes were verified against the deployed server:
///
///   tasks         -> data.tasks[]
///   memories      -> data.memories[]
///   conversations -> data.conversations[]
///   reminders     -> data[]          (note: array directly under data)
///   settings      -> sub-resources, no root route
class NovaApi {
  NovaApi(this._network);

  final NetworkService _network;

  // ─── Tasks ────────────────────────────────────────────────────────────────

  Future<List<NovaTask>> listTasks({int limit = 50, String? status}) async {
    final data = await _get(
      ApiConfig.tasks,
      query: {'limit': limit, 'status': ?status},
    );
    return _list(data, 'tasks', NovaTask.fromJson);
  }

  Future<NovaTask> createTask({
    required String title,
    String? description,
    DateTime? dueAt,
    String? priority,
  }) async {
    final data = await _post(ApiConfig.tasks, {
      'title': title,
      if (description != null && description.isNotEmpty)
        'description': description,
      if (dueAt != null) 'dueAt': dueAt.toUtc().toIso8601String(),
      'priority': ?priority,
    });
    return NovaTask.fromJson(_object(data));
  }

  Future<NovaTask> updateTask(
    String id, {
    String? title,
    String? description,
    String? status,
    DateTime? dueAt,
  }) async {
    final data = await _patch(ApiConfig.task(id), {
      'title': ?title,
      'description': ?description,
      'status': ?status,
      if (dueAt != null) 'dueAt': dueAt.toUtc().toIso8601String(),
    });
    return NovaTask.fromJson(_object(data));
  }

  Future<NovaTask> completeTask(String id, {bool done = true}) =>
      updateTask(id, status: done ? 'completed' : 'pending');

  Future<void> deleteTask(String id) => _delete(ApiConfig.task(id));

  // ─── Memories ─────────────────────────────────────────────────────────────

  Future<List<NovaMemory>> listMemories({
    int limit = 50,
    String? query,
  }) async {
    final data = await _get(
      ApiConfig.memories,
      query: {'limit': limit, if (query != null && query.isNotEmpty) 'search': query},
    );
    return _list(data, 'memories', NovaMemory.fromJson);
  }

  Future<NovaMemory> createMemory({
    required String content,
    String? type,
    double? importance,
  }) async {
    final data = await _post(ApiConfig.memories, {
      'content': content,
      'type': ?type,
      'importance': ?importance,
    });
    return NovaMemory.fromJson(_object(data));
  }

  Future<NovaMemory> updateMemory(
    String id, {
    String? content,
    double? importance,
  }) async {
    final data = await _patch(ApiConfig.memory(id), {
      'content': ?content,
      'importance': ?importance,
    });
    return NovaMemory.fromJson(_object(data));
  }

  Future<void> deleteMemory(String id) => _delete(ApiConfig.memory(id));

  // ─── Conversations ────────────────────────────────────────────────────────

  Future<List<NovaConversation>> listConversations({int limit = 50}) async {
    final data = await _get(
      ApiConfig.conversations,
      query: {'limit': limit},
    );
    return _list(data, 'conversations', NovaConversation.fromJson);
  }

  Future<NovaConversation> createConversation({String? title}) async {
    final data = await _post(ApiConfig.conversations, {
      if (title != null && title.isNotEmpty) 'title': title,
    });
    return NovaConversation.fromJson(_object(data));
  }

  Future<NovaConversation> getConversation(String id) async {
    final data = await _get(ApiConfig.conversation(id));
    return NovaConversation.fromJson(_object(data));
  }

  Future<void> deleteConversation(String id) =>
      _delete(ApiConfig.conversation(id));

  Future<List<NovaMessage>> listMessages(String conversationId) async {
    final data = await _get(ApiConfig.conversationMessages(conversationId));
    // This route returns either {messages: []} or a bare array depending on
    // revision, so accept both rather than assuming.
    if (data is List) {
      return data
          .whereType<Map>()
          .map((m) => NovaMessage.fromJson(Map<String, dynamic>.from(m)))
          .toList();
    }
    return _list(data, 'messages', NovaMessage.fromJson);
  }

  /// Sends a user message and returns the assistant's reply when one was
  /// generated.
  ///
  /// When the server stored the user turn but could not reach the AI provider it
  /// responds with `assistantMessage: null` and `assistantError`, so this
  /// returns a [NovaSendResult] rather than throwing — the user's message is
  /// never lost.
  Future<NovaSendResult> sendMessage(
    String conversationId,
    String content,
  ) async {
    final raw = await _postRaw(ApiConfig.conversationMessages(conversationId), {
      'role': 'user',
      'content': content,
    });
    final map = _asMap(raw);

    final userJson = map['userMessage'] ?? map['message'] ?? map['user'];
    final assistantJson = map['assistantMessage'] ?? map['assistant'];
    final error = map['assistantError'] ?? map['assistant_error'];

    return NovaSendResult(
      userMessage: userJson is Map
          ? NovaMessage.fromJson(Map<String, dynamic>.from(userJson))
          : NovaMessage(
              id: 'local-${DateTime.now().microsecondsSinceEpoch}',
              role: 'user',
              content: content,
              createdAt: DateTime.now(),
            ),
      assistantMessage: assistantJson is Map
          ? NovaMessage.fromJson(Map<String, dynamic>.from(assistantJson))
          : null,
      assistantError: error is String ? error : null,
    );
  }

  // ─── Reminders ────────────────────────────────────────────────────────────

  Future<List<NovaReminder>> listReminders({int limit = 50}) async {
    final data = await _get(ApiConfig.reminders, query: {'limit': limit});
    if (data is List) {
      return data
          .whereType<Map>()
          .map((m) => NovaReminder.fromJson(Map<String, dynamic>.from(m)))
          .toList();
    }
    return _list(data, 'reminders', NovaReminder.fromJson);
  }

  /// Creates a reminder.
  ///
  /// The server's `CreateReminderSchema` accepts `triggerAt` (canonical,
  /// `reminders.trigger_at`) or its `dueAt` alias, and has no `notes` field —
  /// the `reminders` table has no such column. This used to send `remindAt`,
  /// which zod stripped as an unknown key, so every create failed the schema's
  /// refine with 400 "triggerAt is required".
  Future<NovaReminder> createReminder({
    required String title,
    DateTime? remindAt,
    String? timezone,
    String? repeatRule,
    List<String>? notificationChannel,
  }) async {
    final data = await _post(ApiConfig.reminders, {
      'title': title,
      'triggerAt': ?remindAt?.toUtc().toIso8601String(),
      'timezone': ?timezone,
      'repeatRule': ?repeatRule,
      'notificationChannel': ?notificationChannel,
    });
    return NovaReminder.fromJson(_object(data));
  }

  /// Partially updates a reminder. Mirrors the server's `UpdateReminderSchema`.
  Future<NovaReminder> updateReminder(
    String id, {
    String? title,
    DateTime? remindAt,
    bool? dismissed,
    String? repeatRule,
  }) async {
    final data = await _patch(ApiConfig.reminder(id), {
      'title': ?title,
      'triggerAt': ?remindAt?.toUtc().toIso8601String(),
      'dismissed': ?dismissed,
      'repeatRule': ?repeatRule,
    });
    return NovaReminder.fromJson(_object(data));
  }

  Future<void> deleteReminder(String id) => _delete(ApiConfig.reminder(id));

  // ─── Settings ─────────────────────────────────────────────────────────────

  Future<NovaProfile> getProfile() async {
    final data = await _get(ApiConfig.settingsProfile);
    return NovaProfile.fromJson(_object(data));
  }

  Future<NovaProfile> updateProfile({
    String? name,
    String? phone,
    String? locale,
    String? timezone,
  }) async {
    final data = await _patch(ApiConfig.settingsProfile, {
      'name': ?name,
      'phone': ?phone,
      'locale': ?locale,
      'timezone': ?timezone,
    });
    return NovaProfile.fromJson(_object(data));
  }

  Future<NovaNotificationPrefs> getPreferences() async {
    final data = await _get(ApiConfig.settingsPreferences);
    return NovaNotificationPrefs.fromJson(_object(data));
  }

  Future<NovaNotificationPrefs> updatePreferences(
    NovaNotificationPrefs prefs,
  ) async {
    final data = await _patch(ApiConfig.settingsPreferences, prefs.toJson());
    return NovaNotificationPrefs.fromJson(_object(data));
  }

  Future<NovaPrivacyPrefs> getPrivacy() async {
    final data = await _get(ApiConfig.settingsPrivacy);
    return NovaPrivacyPrefs.fromJson(_object(data));
  }

  Future<NovaPrivacyPrefs> updatePrivacy(NovaPrivacyPrefs prefs) async {
    final data = await _patch(ApiConfig.settingsPrivacy, prefs.toJson());
    return NovaPrivacyPrefs.fromJson(_object(data));
  }

  Future<NovaPersona> getPersona() async {
    final data = await _get(ApiConfig.settingsPersona);
    return NovaPersona.fromJson(_object(data));
  }

  Future<NovaPersona> updatePersona(NovaPersona persona) async {
    final data = await _put(ApiConfig.settingsPersona, persona.toJson());
    return NovaPersona.fromJson(_object(data));
  }

  /// Companion settings (name, voice, wake word). Returns the raw map because
  /// the server owns the shape and the screen only reflects it.
  Future<Map<String, dynamic>> getCompanion() async {
    final data = await _get(ApiConfig.settingsCompanion);
    return _asMap(data);
  }

  // ─── Activity centre (audit_logs) ─────────────────────────────────────────

  Future<List<NovaActivityItem>> listActivity({
    int limit = 50,
    String? action,
    String? outcome,
  }) async {
    final data = await _get(
      ApiConfig.activity,
      query: {
        'limit': limit,
        'action': ?action,
        'outcome': ?outcome,
      },
    );
    return _list(data, 'activity', NovaActivityItem.fromJson);
  }

  // ─── Recordings & summaries ───────────────────────────────────────────────

  Future<List<NovaRecording>> listRecordings({int limit = 50}) async {
    final data = await _get(ApiConfig.recordings, query: {'limit': limit});
    return _list(data, 'recordings', NovaRecording.fromJson);
  }

  Future<NovaRecording> createRecording({
    required String title,
    String? language,
    List<String>? participants,
  }) async {
    final data = await _post(ApiConfig.recordings, {
      'title': title,
      'language': ?language,
      'participants': ?participants,
    });
    return NovaRecording.fromJson(_object(data));
  }

  /// One recording plus its transcript and summary, as the detail route returns
  /// them. `transcript` is a plain string; `summary` may be null when the
  /// pipeline has not run yet.
  Future<NovaRecordingDetail> getRecording(String id) async {
    final data = await _get(ApiConfig.recording(id));
    final map = _asMap(data);
    final recJson = map['recording'] is Map
        ? Map<String, dynamic>.from(map['recording'] as Map)
        : map;
    final summaryJson = map['summary'];
    final transcript = map['transcript'];
    return NovaRecordingDetail(
      recording: NovaRecording.fromJson(recJson),
      transcript: transcript is String
          ? transcript
          : (transcript is Map ? transcript['fullText'] as String? : null),
      summary: summaryJson is Map
          ? NovaRecordingSummary.fromJson(
              Map<String, dynamic>.from(summaryJson),
            )
          : null,
    );
  }

  Future<NovaRecording> updateRecording(
    String id, {
    String? title,
    int? durationSeconds,
    String? status,
    bool? consentRecorded,
  }) async {
    final data = await _patch(ApiConfig.recording(id), {
      'title': ?title,
      'durationSeconds': ?durationSeconds,
      'status': ?status,
      'consentRecorded': ?consentRecorded,
    });
    return NovaRecording.fromJson(_object(data));
  }

  Future<void> deleteRecording(String id) =>
      _delete(ApiConfig.recording(id));

  Future<NovaRecordingSummary?> getRecordingSummary(String id) async {
    final data = await _get(ApiConfig.recordingSummary(id));
    final map = _asMap(data);
    if (map.isEmpty) return null;
    return NovaRecordingSummary.fromJson(map);
  }

  // ─── Tools & approvals ────────────────────────────────────────────────────

  Future<List<NovaToolDefinition>> listTools() async {
    final data = await _get(ApiConfig.tools);
    return _list(data, 'tools', NovaToolDefinition.fromJson);
  }

  Future<List<NovaToolApproval>> listApprovals({String? status}) async {
    final data = await _get(
      ApiConfig.approvals,
      query: {'status': ?status},
    );
    return _list(data, 'approvals', NovaToolApproval.fromJson);
  }

  /// Confirms or denies a pending side-effecting action. The blueprint requires
  /// this to happen *before* anything external occurs (§5.7).
  Future<NovaToolApproval> decideApproval(
    String id, {
    required bool approve,
  }) async {
    final data = await _post(ApiConfig.approvalDecision(id), {
      'decision': approve ? 'approve' : 'deny',
    });
    return NovaToolApproval.fromJson(_object(data));
  }

  // ─── Consent ──────────────────────────────────────────────────────────────

  Future<List<NovaConsentRecord>> listConsent() async {
    final data = await _get(ApiConfig.consent);
    return _list(data, 'consent', NovaConsentRecord.fromJson);
  }

  Future<NovaConsentRecord> recordConsent({
    required String purpose,
    required bool granted,
    String? method,
  }) async {
    final data = await _post(ApiConfig.consent, {
      'purpose': purpose,
      'granted': granted,
      'method': ?method,
    });
    return NovaConsentRecord.fromJson(_object(data));
  }

  // ─── Transport helpers ────────────────────────────────────────────────────

  Future<dynamic> _get(String url, {Map<String, dynamic>? query}) =>
      _guard(() => _network.get<dynamic>(
            url,
            queryParameters: query,
          ));

  Future<dynamic> _post(String url, Map<String, dynamic> body) =>
      _guard(() => _network.post<dynamic>(url, data: body));

  Future<dynamic> _put(String url, Map<String, dynamic> body) =>
      _guard(() => _network.put<dynamic>(url, data: body));

  Future<dynamic> _patch(String url, Map<String, dynamic> body) =>
      _guard(() => _network.patch<dynamic>(url, data: body));

  Future<void> _delete(String url) async {
    await _guard(() => _network.delete<dynamic>(url));
  }

  /// Returns the unwrapped `data` payload (object or list).
  Future<dynamic> _guard(Future<Response<dynamic>> Function() call) async {
    final Response<dynamic> response;
    try {
      response = await call();
    } on NetworkException catch (e) {
      throw NovaApiException(e.message, statusCode: e.statusCode);
    } on DioException catch (e) {
      throw NovaApiException(
        _messageFromDio(e),
        statusCode: e.response?.statusCode,
      );
    }
    return _unwrap(response.data, response.statusCode);
  }

  /// Like [_guard] but returns the unwrapped data without throwing on a
  /// non-fatal payload — used by [sendMessage].
  Future<dynamic> _postRaw(String url, Map<String, dynamic> body) =>
      _guard(() => _network.post<dynamic>(url, data: body));

  dynamic _unwrap(dynamic raw, int? statusCode) {
    if (raw is Map) {
      final body = Map<String, dynamic>.from(raw);
      if (body.containsKey('success')) {
        if (body['success'] == false) {
          throw NovaApiException(
            (body['error'] ?? 'The server rejected the request').toString(),
            statusCode: statusCode,
          );
        }
        return body['data'];
      }
      if (body.containsKey('error')) {
        throw NovaApiException(
          body['error'].toString(),
          statusCode: statusCode,
        );
      }
      return body;
    }
    return raw;
  }

  Map<String, dynamic> _asMap(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return const {};
  }

  Map<String, dynamic> _object(dynamic data) {
    if (data is Map) {
      // Some routes nest the entity under its own key.
      final map = Map<String, dynamic>.from(data);
      for (final key in ['task', 'memory', 'conversation', 'reminder', 'profile']) {
        final inner = map[key];
        if (inner is Map && map.length == 1) {
          return Map<String, dynamic>.from(inner);
        }
      }
      return map;
    }
    return const {};
  }

  List<T> _list<T>(
    dynamic data,
    String key,
    T Function(Map<String, dynamic>) parse,
  ) {
    dynamic raw = data;
    if (data is Map) {
      raw = data[key] ?? const [];
    }
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((m) => parse(Map<String, dynamic>.from(m)))
        .toList();
  }

  String _messageFromDio(DioException e) {
    final data = e.response?.data;
    if (data is Map) {
      for (final k in ['detail', 'title', 'message', 'error']) {
        final v = data[k];
        if (v is String && v.isNotEmpty) return v;
      }
    }
    return switch (e.type) {
      DioExceptionType.connectionTimeout => 'The server took too long to respond.',
      DioExceptionType.receiveTimeout => 'The server took too long to respond.',
      DioExceptionType.connectionError => 'Cannot reach the NOVA server.',
      _ => 'Request failed.',
    };
  }
}

/// The app-wide API client. Uses the authenticated [networkServiceProvider], so
/// the bearer token and transparent 401 refresh are applied automatically.
final novaApiProvider = Provider<NovaApi>(
  (ref) => NovaApi(ref.watch(networkServiceProvider)),
);
