import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
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
/// Reads the unread count out of whatever `GET /notifications/unread-count`
/// returned.
///
/// `_get` already unwraps the `{success, data}` envelope, so the answer arrives as
/// `{count: N}` — reading `data['data']` instead returned null on every call and
/// the bell silently showed nothing. A raw envelope is still tolerated, so this
/// cannot quietly answer zero if that unwrapping ever changes.
int parseUnreadCount(dynamic data) {
  if (data is Map) {
    final body = Map<String, dynamic>.from(data);
    final nested = body['data'];
    final map = nested is Map ? Map<String, dynamic>.from(nested) : body;
    // Total on purpose: a missing or unexpected value must leave the badge empty,
    // never throw inside a widget build. `count(*)::int` has been a number every
    // time it has been seen, and a string is still read rather than rejected.
    final value = map['count'];
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value) ?? 0;
    return 0;
  }
  return 0;
}

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

  /// Creates a task.
  ///
  /// `CreateTaskSchema` requires BOTH `priority` and `status` — neither has a
  /// default — so sending only a title returns 400 "Multiple validation
  /// errors" and no task was ever created. They are defaulted here rather than
  /// left to the caller.
  Future<NovaTask> createTask({
    required String title,
    String? description,
    DateTime? dueAt,
    String? priority,
    String status = 'pending',
  }) async {
    final data = await _post(ApiConfig.tasks, {
      'title': title,
      if (description != null && description.isNotEmpty)
        'description': description,
      if (dueAt != null) 'dueAt': dueAt.toUtc().toIso8601String(),
      'priority': priority ?? 'medium',
      'status': status,
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
      // The server's MemoryListQuerySchema reads `search`; the dedicated
      // /memories/search endpoint reads `query`. Both are correct for their
      // own route — this one is the list.
      query: {
        'limit': limit,
        if (query != null && query.isNotEmpty) 'search': query,
      },
    );
    return _list(data, 'memories', NovaMemory.fromJson);
  }

  /// Searches memories.
  ///
  /// `MemorySearchSchema` requires `query`; this used to send `search`, which
  /// made every search answer 400 "Required".
  Future<List<NovaMemory>> searchMemories({
    required String query,
    int limit = 20,
    String? category,
  }) async {
    final data = await _get(
      ApiConfig.memorySearch,
      query: {
        'query': query,
        'limit': limit,
        if (category != null && category.isNotEmpty) 'category': category,
      },
    );
    return _list(data, 'memories', NovaMemory.fromJson);
  }

  /// Creates a memory.
  ///
  /// `CreateMemorySchema` requires `category` and `sourceType` — it has no
  /// `type` field at all, and zod stripped it, so every create answered 400.
  Future<NovaMemory> createMemory({
    required String content,
    String category = 'fact',
    String sourceType = 'manual',
    double? importance,
  }) async {
    final data = await _post(ApiConfig.memories, {
      'content': content,
      'category': category,
      'sourceType': sourceType,
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
    String content, {
    String? language,
  }) async {
    final raw = await _postRaw(ApiConfig.conversationMessages(conversationId), {
      'role': 'user',
      'content': content,
      // The server uses this to instruct the model which language to answer in.
      // Without it the reply language was left to inference on every turn.
      'language': ?language,
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

  // ─── Daily briefing ───────────────────────────────────────────────────────

  /// Fetches the daily briefing (§9.4).
  ///
  /// The server returns text that is already speakable, so this method does no
  /// formatting of its own — the caller only decides whether and when to read
  /// it aloud. `language` is the app's language policy (`en`, `ta`, `hi`,
  /// `tanglish`, `auto`), which the server uses to write the briefing in the
  /// user's own language.
  Future<NovaBriefing> getBriefing({String? language}) async {
    final data = await _get(
      ApiConfig.briefing,
      query: {
        if (language != null && language.isNotEmpty) 'language': language,
      },
    );
    return NovaBriefing.fromJson(_asMap(data));
  }

  // ─── Reminders ────────────────────────────────────────────────────────────

  /// One page of reminders, plus the cursor for the next one.
  ///
  /// `GET /api/v1/reminders` is cursor-paginated: it answers
  /// `{reminders, pagination: {nextCursor, prevCursor, hasMore, total}}`. This used
  /// to be the whole client surface, with a default limit of 50 and no cursor —
  /// so a user with 51 reminders had a "list" that was missing one, and the
  /// reconciler read that absence as a deletion and cancelled the alarm.
  Future<NovaReminderPage> listReminderPage({
    int limit = 50,
    String? cursor,
  }) async {
    final data = await _get(
      ApiConfig.reminders,
      query: {'limit': limit, 'cursor': ?cursor},
    );

    final reminders = data is List
        ? data
              .whereType<Map>()
              .map((m) => NovaReminder.fromJson(Map<String, dynamic>.from(m)))
              .toList()
        : _list(data, 'reminders', NovaReminder.fromJson);

    final pagination = data is Map
        ? _asMap(data['pagination'])
        : const <String, dynamic>{};

    // `hasMore` alone is not enough: a next page without a cursor to reach it is
    // the same as no next page, and treating it as one would loop.
    String? nextCursor;
    if (pagination['hasMore'] == true) {
      final next = pagination['nextCursor'];
      if (next is String && next.isNotEmpty) nextCursor = next;
    }

    return NovaReminderPage(
      reminders: reminders,
      nextCursor: nextCursor,
      hasMore: nextCursor != null,
    );
  }

  /// Every reminder the account has, by following the server's cursor.
  ///
  /// [maxPages] bounds the loop so a server that never runs out of pages cannot
  /// hang a sync. Two further guards exist because a bad cursor must not become an
  /// infinite one: a page that returns nothing new stops the walk, and a cursor
  /// that does not change stops it too.
  ///
  /// A failure **after** the first page is not thrown: the pages already read are
  /// returned with `complete: false`, because a partial list is still worth
  /// scheduling from and the caller must be able to tell that it is partial. A
  /// failure on the *first* page is thrown, since there is nothing to reconcile and
  /// a sync that quietly did nothing would be worse than one that reports an error.
  Future<NovaReminderList> listAllReminders({
    int limit = 50,
    int maxPages = 40,
  }) async {
    final all = <NovaReminder>[];
    final seen = <String>{};
    String? cursor;

    for (var page = 0; page < maxPages; page++) {
      final NovaReminderPage result;
      try {
        result = await listReminderPage(limit: limit, cursor: cursor);
      } catch (error) {
        if (page == 0) rethrow;
        debugPrint(
          '[NovaApi] reminder page ${page + 1} failed; returning an incomplete list '
          'so nothing is cancelled on the strength of it: $error',
        );
        return NovaReminderList(reminders: all, complete: false);
      }

      final before = seen.length;
      for (final reminder in result.reminders) {
        if (seen.add(reminder.id)) all.add(reminder);
      }

      if (!result.hasMore || result.nextCursor == null) {
        return NovaReminderList(reminders: all, complete: true);
      }
      if (seen.length == before || result.nextCursor == cursor) {
        // The server repeated a page or handed back the cursor it was given.
        // Walking on would loop until `maxPages` for no new data.
        debugPrint(
          '[NovaApi] reminder pagination did not advance; stopping with an '
          'incomplete list',
        );
        return NovaReminderList(reminders: all, complete: false);
      }
      cursor = result.nextCursor;
    }

    debugPrint(
      '[NovaApi] reminder pagination hit the $maxPages-page bound; returning an '
      'incomplete list',
    );
    return NovaReminderList(reminders: all, complete: false);
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

  /// Reports that the user opened this reminder's notification.
  ///
  /// This is the only delivery signal the platform offers: Android arms the alarm and
  /// fires it with the app closed, so nothing in Dart observes the firing itself,
  /// whereas a tap wakes the app. The server records it as an *acknowledgement* — see
  /// `reminders.triggered_at` and migration 0010 — and counts each reminder once, so
  /// calling this twice is harmless.
  ///
  /// Returns the instant the server recorded, or `null` when it had already recorded
  /// an acknowledgement (which is a success, not a failure).
  Future<DateTime?> acknowledgeReminder(String id) async {
    final data = await _post(
      ApiConfig.reminderAcknowledge(id),
      const <String, dynamic>{},
    );
    final recorded = _object(data)['triggeredAt'];
    return recorded is String ? DateTime.tryParse(recorded) : null;
  }

  // ─── Voice ────────────────────────────────────────────────────────────────

  /// Transcribes base64-encoded audio. The server routes by [language]:
  /// Deepgram for English, Sarvam for the Indian languages it covers.
  Future<String> transcribeAudio({
    required String audioBase64,
    String language = 'en',
  }) async {
    final data = await _post(ApiConfig.voiceStt, {
      'audioData': audioBase64,
      'language': language,
    });
    return (_object(data)['transcript'] ?? '').toString();
  }

  /// Synthesises speech and returns the decoded audio bytes.
  ///
  /// The server answers `audioData: null` with a `provider: 'fallback'` and an
  /// `error` field when no TTS provider could serve the request; that is
  /// reported as [NovaApiException] rather than silently returning no audio.
  Future<List<int>> synthesizeSpeech({
    required String text,
    String language = 'en',
    String? voiceId,
  }) async {
    final data = await _post(ApiConfig.voiceTts, {
      'text': text,
      'language': language,
      'voiceId': ?voiceId,
    });
    final object = _object(data);
    final audio = object['audioData'];
    if (audio is! String || audio.isEmpty) {
      throw NovaApiException(
        (object['error'] ?? 'Speech synthesis returned no audio').toString(),
      );
    }
    return base64Decode(audio);
  }

  /// A language-aware assistant turn. Distinct from the conversation route:
  /// it applies the voice persona and is the path the Converse tab speaks.
  Future<String> voiceChat({
    required List<Map<String, String>> messages,
    String language = 'en',
  }) async {
    final data = await _post(ApiConfig.voiceChat, {
      'messages': messages,
      'language': language,
    });
    return (_object(data)['text'] ?? '').toString();
  }

  /// Translates [text] between languages. Pass `sourceLanguage: 'auto'` to let
  /// the server detect the source; the detected code comes back in the result.
  Future<NovaTranslation> translate({
    required String text,
    required String targetLanguage,
    String sourceLanguage = 'auto',
  }) async {
    final data = await _post(ApiConfig.voiceTranslate, {
      'text': text,
      'sourceLanguage': sourceLanguage,
      'targetLanguage': targetLanguage,
    });
    return NovaTranslation.fromJson(_object(data));
  }

  /// Language catalogue with each language's STT/TTS provider routing.
  Future<List<Map<String, dynamic>>> voiceLanguages() async {
    final data = await _get(ApiConfig.voiceLanguages);
    final raw = data is List ? data : _object(data)['languages'];
    if (raw is! List) return const [];
    return raw.whereType<Map>().map(Map<String, dynamic>.from).toList();
  }

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

  /// The user's avatar appearance. `userId` is unique server-side, so this is
  /// at most one row; null means none has been saved yet.
  Future<NovaAvatarPrefs?> getAvatar() async {
    final data = await _get(ApiConfig.settingsAvatars);
    final rows = data is List ? data : _object(data)['avatars'];
    if (rows is! List || rows.isEmpty) return null;
    return NovaAvatarPrefs.fromJson(
      Map<String, dynamic>.from(rows.first as Map),
    );
  }

  /// Saves the avatar appearance. The route upserts, so a partial body leaves
  /// the fields it omits untouched.
  Future<NovaAvatarPrefs> saveAvatar(NovaAvatarPrefs prefs) async {
    final data = await _post(ApiConfig.settingsAvatars, prefs.toJson());
    return NovaAvatarPrefs.fromJson(_object(data));
  }

  /// Companion settings (name, voice, wake word). Returns the raw map because
  /// the server owns the shape and the screen only reflects it.
  Future<Map<String, dynamic>> getCompanion() async {
    final data = await _get(ApiConfig.settingsCompanion);
    return _asMap(data);
  }

  /// §13.10 — the wake word recorded against the user's account.
  ///
  /// Read-only with respect to the microphone: the phrase NOVA listens for comes
  /// from the classifiers installed in the app bundle (see
  /// `WakeWordService.kt`). The response says so itself
  /// (`enforcedOnDevice: true`, `control: 'preference_record'`).
  ///
  /// Returns the raw map because the payload carries explanatory fields the
  /// screen renders verbatim.
  Future<Map<String, dynamic>> getWakeWordConfig() async {
    final data = await _get(ApiConfig.deviceWakeWordConfig);
    return _asMap(data);
  }

  /// Records the phrase the user chose, validated server-side against the
  /// phrases the device reported. [available] is required: the server has no way
  /// to know which classifiers a build ships, so without it the call is a 400
  /// rather than a silent acceptance of a phrase no device can hear.
  Future<Map<String, dynamic>> updateWakeWordConfig({
    required String wakeWord,
    required List<String> available,
  }) async {
    final data = await _patch(ApiConfig.deviceWakeWordConfig, {
      'wakeWord': wakeWord,
      'available': available,
    });
    return _asMap(data);
  }

  // ─── Activity centre (audit_logs) ─────────────────────────────────────────

  /// NOVA's own notifications, newest first.
  Future<List<NovaNotification>> listNotifications({int limit = 50}) async {
    final data = await _get(
      ApiConfig.notifications,
      query: {'pageSize': limit},
    );
    return _list(data, 'notifications', NovaNotification.fromJson);
  }

  /// How many are unread — what the Home bell should actually show.
  Future<int> unreadNotificationCount() async =>
      parseUnreadCount(await _get('${ApiConfig.notifications}/unread-count'));

  Future<void> markNotificationRead(String id) =>
      _patch('${ApiConfig.notifications}/$id/read', const <String, dynamic>{});

  Future<void> deleteNotification(String id) =>
      _delete('${ApiConfig.notifications}/$id');

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
    bool? consentRecorded,
  }) async {
    final data = await _post(ApiConfig.recordings, {
      'title': title,
      'language': ?language,
      'participants': ?participants,
      'consentRecorded': ?consentRecorded,
    });
    return NovaRecording.fromJson(_object(data));
  }

  /// One recording plus its transcript, segments and summary, as the detail
  /// route returns them.
  ///
  /// `transcript` is an object (`{fullText, …}`) in this route's payload, but a
  /// bare string in older revisions, so both are accepted. `segments` are
  /// carried through even though the pipeline never attributes a speaker: the
  /// UI states that absence rather than inventing a speaker breakdown.
  Future<NovaRecordingDetail> getRecording(String id) async {
    final data = await _get(ApiConfig.recording(id));
    final map = _asMap(data);
    final recJson = map['recording'] is Map
        ? Map<String, dynamic>.from(map['recording'] as Map)
        : map;
    final summaryJson = map['summary'];
    final transcript = map['transcript'];
    final rawSegments = map['segments'];
    return NovaRecordingDetail(
      recording: NovaRecording.fromJson(recJson),
      transcript: transcript is String
          ? (transcript.isEmpty ? null : transcript)
          : (transcript is Map
                ? _nonEmptyString(transcript['fullText'])
                : null),
      summary: summaryJson is Map
          ? NovaRecordingSummary.fromJson(
              Map<String, dynamic>.from(summaryJson),
            )
          : null,
      segments: rawSegments is List
          ? rawSegments
                .whereType<Map>()
                .map(
                  (s) => NovaTranscriptSegment.fromJson(
                    Map<String, dynamic>.from(s),
                  ),
                )
                .toList()
          : const [],
    );
  }

  /// Uploads the raw audio for [id].
  ///
  /// The body is the audio itself, with the container MIME type in
  /// `Content-Type` — the route does **not** accept base64 or multipart. Query
  /// parameters carry the language and duration the pipeline should assume.
  ///
  /// A `413` means the payload exceeded the server's ceiling and a `503` with
  /// `STORAGE_UNAVAILABLE` means the bytes were not stored; both surface as a
  /// [NovaApiException] carrying the status and the server's own message, so the
  /// caller can say what actually happened instead of claiming success.
  Future<NovaRecordingUpload> uploadRecordingAudio(
    String id,
    List<int> bytes,
    String mimeType, {
    String? language,
    int? durationSeconds,
  }) async {
    final data = await _postBytes(
      ApiConfig.recordingAudio(id),
      bytes,
      mimeType,
      query: {
        'language': ?language,
        'durationSeconds': ?durationSeconds,
      },
    );
    final map = _asMap(data);
    final storageJson = map['storage'];
    return NovaRecordingUpload(
      recording: map['recording'] is Map
          ? NovaRecording.fromJson(
              Map<String, dynamic>.from(map['recording'] as Map),
            )
          : NovaRecording.fromJson(const {}),
      storage: storageJson is Map
          ? NovaRecordingStorage.fromJson(
              Map<String, dynamic>.from(storageJson),
            )
          : NovaRecordingStorage.unknown,
    );
  }

  /// Asks the server to transcribe and summarise [id]. Answers `202` at once;
  /// the result arrives later through [getRecording].
  Future<void> processRecording(String id, {String? language}) async {
    await _post(ApiConfig.recordingProcess(id), {'language': ?language});
  }

  /// What the server can currently do. Read rather than assumed: a deployment
  /// with no STT provider reports `transcription: 'unavailable'` with a reason,
  /// and the screen says so instead of promising a transcript.
  Future<NovaRecordingCapabilities> getRecordingCapabilities() async {
    final data = await _get(ApiConfig.recordingCapabilities);
    return NovaRecordingCapabilities.fromJson(_asMap(data));
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

  /// The raw audio the server holds for [id], as bytes.
  ///
  /// `GET /recordings/:id/audio` is the read half of the same route
  /// [uploadRecordingAudio] writes to. It exists so call-recording import can
  /// probe the size of an existing recording without pulling its bytes; the
  /// import path itself reads the user's local file and uploads through
  /// [uploadRecordingAudio], never through here.
  ///
  /// The response is binary, so it is **not** unwrapped as the `{success, data}`
  /// envelope: a JSON error body is detected and raised instead of being
  /// returned as audio, which would otherwise mean uploading a JSON error
  /// message as if it were a recording.
  Future<Uint8List> readRecordingAudio(String id) {
    return _guard<Uint8List>(
      () => _network.get<Uint8List>(
        ApiConfig.recordingAudio(id),
        options: Options(responseType: ResponseType.bytes),
      ),
    );
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

  // ─── AI content reporting ─────────────────────────────────────────────────

  /// Files a report about an AI reply.
  ///
  /// Play's AI-Generated Content policy requires an in-app way to report offensive
  /// model output without leaving the app; this is the client half of it. The
  /// server records the report in the audit trail rather than storing the reply
  /// text again.
  Future<void> reportAiResponse({
    required String messageId,
    required String reason,
    String? excerpt,
  }) async {
    await _post(ApiConfig.aiReports, {
      'messageId': messageId,
      'reason': reason,
      'excerpt': ?excerpt,
    });
  }

  // ─── Account deletion ─────────────────────────────────────────────────────

  /// What deleting this account will remove, for the confirmation screen.
  Future<NovaDeletionPreview> deletionPreview() async {
    final data = await _get(ApiConfig.accountDeletionPreview);
    return NovaDeletionPreview.fromJson(_object(data));
  }

  /// Permanently deletes the account and everything in it.
  ///
  /// [password] is required whenever the account has one; the server returns 400
  /// `PASSWORD_REQUIRED` otherwise. `confirm` must be the literal `DELETE`.
  Future<void> deleteAccount({String? password, String? reason}) async {
    await _deleteWithBody(ApiConfig.account, {
      'confirm': 'DELETE',
      'password': ?password,
      'reason': ?reason,
    });
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

  /// Posts a raw byte body (no JSON envelope, no base64) with [mimeType] as the
  /// container type. Error handling is identical to the other verbs — [_guard]
  /// still turns a `413`/`503` into a [NovaApiException] with the status and the
  /// server's message.
  Future<dynamic> _postBytes(
    String url,
    List<int> bytes,
    String mimeType, {
    Map<String, dynamic>? query,
  }) => _guard(
    () => _network.post<dynamic>(
      url,
      data: bytes,
      queryParameters: query,
      // dio budgets `sendTimeout` over the **whole** body write, and the client's
      // default is 10 seconds, so a multi-minute recording could never finish
      // uploading on anything but a fast link. `Duration.zero` disables that budget
      // (dio only arms the timeout when it is greater than zero); the connect and
      // receive timeouts still apply, so a dead server still fails promptly.
      options: Options(
        headers: {'Content-Type': mimeType},
        sendTimeout: Duration.zero,
      ),
    ),
  );

  Future<void> _delete(String url) async {
    await _guard(() => _network.delete<dynamic>(url));
  }

  /// A DELETE that carries a JSON body, needed for account deletion: the server
  /// requires `confirm: "DELETE"` (and the password when one is set) so an
  /// accidental or replayed call cannot destroy an account.
  Future<void> _deleteWithBody(String url, Map<String, dynamic> body) async {
    await _guard(() => _network.delete<dynamic>(url, data: body));
  }

  /// Returns the unwrapped `data` payload (object or list).
  ///
  /// Most routes answer JSON, so [T] is [dynamic] and [_unwrap] digs out `data`.
  /// A binary route (`GET /recordings/:id/audio`) asks for `T == Uint8List`
  /// instead: there is no envelope to unwrap, and the bytes are returned as they
  /// arrived. A JSON error body is still turned into a [NovaApiException], so a
  /// refused download can never be mistaken for audio.
  Future<T> _guard<T>(Future<Response<dynamic>> Function() call) async {
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
    if (T == Uint8List) {
      final data = response.data;
      if (data is Uint8List) return data as T;
      if (data is List<int>) return Uint8List.fromList(data) as T;
      // A JSON body on a binary route is an error, not audio.
      _unwrap(data, response.statusCode);
      throw NovaApiException(
        'The server returned a body that is not audio '
        '(HTTP ${response.statusCode}).',
        statusCode: response.statusCode,
      );
    }
    return _unwrap(response.data, response.statusCode) as T;
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

  /// A trimmed, non-empty string, or null.
  String? _nonEmptyString(Object? value) {
    if (value is! String) return null;
    final text = value.trim();
    return text.isEmpty ? null : text;
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
