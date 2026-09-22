/// Data models for the NOVA API.
///
/// Field names mirror what `services/api` actually returns — verified by
/// calling the deployed endpoints, not inferred. Three envelope shapes exist and
/// they differ, which is why each parser is explicit:
///
///   GET /api/v1/tasks         -> {success, data: {tasks: [...], pagination}}
///   GET /api/v1/memories      -> {success, data: {memories: [...], pagination}}
///   GET /api/v1/conversations -> {success, data: {conversations: [...], pagination}}
///   GET /api/v1/reminders     -> {success, data: [...], pagination}
///
/// Plain classes are used deliberately: the repo declares freezed/json_serializable
/// but has no `build.yaml` and zero generated files, so codegen is not wired up.
library;

import 'package:flutter/foundation.dart';

DateTime? _parseDate(Object? value) {
  if (value is String && value.isNotEmpty) {
    return DateTime.tryParse(value)?.toLocal();
  }
  return null;
}

int _parseInt(Object? value, [int fallback = 0]) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? fallback;
  return fallback;
}

double _parseDouble(Object? value, [double fallback = 0]) {
  if (value is double) return value;
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value) ?? fallback;
  return fallback;
}

bool _parseBool(Object? value, [bool fallback = false]) {
  if (value is bool) return value;
  if (value is num) return value != 0;
  if (value is String) return value.toLowerCase() == 'true';
  return fallback;
}

/// A trimmed, non-empty string, or null. Used where "absent" and "empty" must
/// mean the same thing (an owner or a due date that was not extracted).
String? _stringOrNull(Object? value) {
  if (value == null) return null;
  final text = value.toString().trim();
  return text.isEmpty ? null : text;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

class NovaTask {
  const NovaTask({
    required this.id,
    required this.title,
    this.description,
    this.status = 'pending',
    this.priority,
    this.dueAt,
    this.completedAt,
    this.createdAt,
  });

  final String id;
  final String title;
  final String? description;
  final String status;
  final String? priority;
  final DateTime? dueAt;
  final DateTime? completedAt;
  final DateTime? createdAt;

  bool get isDone =>
      status == 'completed' || status == 'done' || completedAt != null;

  bool get isOverdue {
    final due = dueAt;
    if (due == null || isDone) return false;
    return due.isBefore(DateTime.now());
  }

  factory NovaTask.fromJson(Map<String, dynamic> j) => NovaTask(
    id: (j['id'] ?? '').toString(),
    title: (j['title'] ?? '').toString(),
    description: j['description'] as String?,
    status: (j['status'] ?? 'pending').toString(),
    priority: j['priority'] as String?,
    dueAt: _parseDate(j['dueAt'] ?? j['due_at']),
    completedAt: _parseDate(j['completedAt'] ?? j['completed_at']),
    createdAt: _parseDate(j['createdAt'] ?? j['created_at']),
  );
}

// ─── Memories ─────────────────────────────────────────────────────────────────

class NovaMemory {
  const NovaMemory({
    required this.id,
    required this.content,
    this.type,
    this.importance,
    this.metadata,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String content;
  final String? type;
  final double? importance;
  final Map<String, dynamic>? metadata;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  factory NovaMemory.fromJson(Map<String, dynamic> j) => NovaMemory(
    id: (j['id'] ?? '').toString(),
    content: (j['content'] ?? '').toString(),
    type: j['type'] as String?,
    importance: j['importance'] == null
        ? null
        : _parseDouble(j['importance']),
    metadata: j['metadata'] is Map
        ? Map<String, dynamic>.from(j['metadata'] as Map)
        : null,
    createdAt: _parseDate(j['createdAt'] ?? j['created_at']),
    updatedAt: _parseDate(j['updatedAt'] ?? j['updated_at']),
  );
}

// ─── Conversations & messages ─────────────────────────────────────────────────

class NovaConversation {
  const NovaConversation({
    required this.id,
    required this.title,
    this.summary,
    this.messageCount,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String title;
  final String? summary;
  final int? messageCount;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  factory NovaConversation.fromJson(Map<String, dynamic> j) => NovaConversation(
    id: (j['id'] ?? '').toString(),
    title: (j['title'] ?? 'New Conversation').toString(),
    summary: j['summary'] as String?,
    messageCount: j['messageCount'] == null
        ? null
        : _parseInt(j['messageCount']),
    createdAt: _parseDate(j['createdAt'] ?? j['created_at']),
    updatedAt: _parseDate(j['updatedAt'] ?? j['updated_at']),
  );
}

class NovaMessage {
  const NovaMessage({
    required this.id,
    required this.role,
    required this.content,
    this.createdAt,
    this.pending = false,
    this.failed = false,
  });

  final String id;
  final String role; // 'user' | 'assistant' | 'system'
  final String content;
  final DateTime? createdAt;
  final bool pending;
  final bool failed;

  bool get isUser => role == 'user';

  factory NovaMessage.fromJson(Map<String, dynamic> j) => NovaMessage(
    id: (j['id'] ?? '').toString(),
    role: (j['role'] ?? 'assistant').toString(),
    content: (j['content'] ?? '').toString(),
    createdAt: _parseDate(j['createdAt'] ?? j['created_at']),
  );

  NovaMessage copyWith({bool? pending, bool? failed, String? content}) =>
      NovaMessage(
        id: id,
        role: role,
        content: content ?? this.content,
        createdAt: createdAt,
        pending: pending ?? this.pending,
        failed: failed ?? this.failed,
      );
}

/// Result of sending a message: the stored user turn plus, when the assistant
/// replied, its turn. `assistantError` is set instead of throwing when the
/// server persisted the user message but could not reach the AI provider, so the
/// UI can show "AI unavailable" without losing the user's text.
class NovaSendResult {
  const NovaSendResult({
    this.userMessage,
    this.assistantMessage,
    this.assistantError,
  });

  final NovaMessage? userMessage;
  final NovaMessage? assistantMessage;
  final String? assistantError;
}

// ─── Reminders ────────────────────────────────────────────────────────────────

/// How often a reminder repeats, as `reminders.repeat_rule` spells it.
enum NovaRepeatFrequency { daily, weekly, monthly }

/// The server's `repeat_rule`, read back into the three things the phone needs:
/// how often, how far apart, and on which day.
///
/// The stored form is a subset of an iCalendar RRULE, defined once on the server
/// in `services/api/src/services/reminder-recurrence.ts` — `FREQ=DAILY`,
/// `FREQ=WEEKLY;BYDAY=MO`, `FREQ=MONTHLY;BYMONTHDAY=15`, each optionally with
/// `INTERVAL=n`. This parser is deliberately as strict as that one and answers
/// `null` rather than guessing: a rule this build does not understand leaves the
/// reminder armed once at its trigger, which is a reminder that fires exactly as
/// it did before repeating existed, instead of one that fires at the wrong time.
///
/// `weekday` is Dart's own numbering (`DateTime.monday` … `DateTime.sunday`), so
/// it can be compared with `DateTime.weekday` directly.
@immutable
class NovaRepeatRule {
  const NovaRepeatRule({
    required this.frequency,
    this.interval = 1,
    this.weekday,
    this.dayOfMonth,
  });

  final NovaRepeatFrequency frequency;

  /// Every [interval] days, weeks or months. Always at least 1.
  final int interval;

  /// For [NovaRepeatFrequency.weekly]: `DateTime.monday` … `DateTime.sunday`.
  final int? weekday;

  /// For [NovaRepeatFrequency.monthly]: 1–31.
  final int? dayOfMonth;

  /// Mirrors `MAX_REPEAT_INTERVAL` in the server module.
  static const int maxInterval = 52;

  /// Mirrors `MAX_REPEAT_RULE_LENGTH` in the server module.
  static const int maxLength = 120;

  static const Map<String, int> _weekdays = <String, int>{
    'MO': DateTime.monday,
    'TU': DateTime.tuesday,
    'WE': DateTime.wednesday,
    'TH': DateTime.thursday,
    'FR': DateTime.friday,
    'SA': DateTime.saturday,
    'SU': DateTime.sunday,
  };

  static const Map<int, String> _weekdayCodes = <int, String>{
    DateTime.monday: 'MO',
    DateTime.tuesday: 'TU',
    DateTime.wednesday: 'WE',
    DateTime.thursday: 'TH',
    DateTime.friday: 'FR',
    DateTime.saturday: 'SA',
    DateTime.sunday: 'SU',
  };

  /// Parses the server's spelling, or answers null.
  static NovaRepeatRule? tryParse(Object? raw) {
    if (raw is! String) return null;
    final text = raw.trim();
    if (text.isEmpty || text.length > maxLength) return null;

    final parts = <String, String>{};
    for (final chunk in text.split(';')) {
      final part = chunk.trim();
      final equals = part.indexOf('=');
      if (equals < 0) return null;
      final key = part.substring(0, equals).trim().toUpperCase();
      if (key.isEmpty || parts.containsKey(key)) return null;
      parts[key] = part.substring(equals + 1).trim();
    }

    const allowed = <String>{'FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY'};
    if (!parts.keys.every(allowed.contains)) return null;

    final frequency = switch (parts['FREQ']?.toUpperCase()) {
      'DAILY' => NovaRepeatFrequency.daily,
      'WEEKLY' => NovaRepeatFrequency.weekly,
      'MONTHLY' => NovaRepeatFrequency.monthly,
      _ => null,
    };
    if (frequency == null) return null;

    var interval = 1;
    final rawInterval = parts['INTERVAL'];
    if (rawInterval != null) {
      interval = int.tryParse(rawInterval) ?? 0;
      if (interval < 1 || interval > maxInterval) return null;
    }

    final byDay = parts['BYDAY'];
    final byMonthDay = parts['BYMONTHDAY'];

    switch (frequency) {
      case NovaRepeatFrequency.daily:
        if (byDay != null || byMonthDay != null) return null;
        return NovaRepeatRule(frequency: frequency, interval: interval);
      case NovaRepeatFrequency.weekly:
        if (byMonthDay != null || byDay == null) return null;
        final weekday = _weekdays[byDay.toUpperCase()];
        if (weekday == null) return null;
        return NovaRepeatRule(
          frequency: frequency,
          interval: interval,
          weekday: weekday,
        );
      case NovaRepeatFrequency.monthly:
        if (byDay != null || byMonthDay == null) return null;
        final day = int.tryParse(byMonthDay);
        if (day == null || day < 1 || day > 31) return null;
        return NovaRepeatRule(
          frequency: frequency,
          interval: interval,
          dayOfMonth: day,
        );
    }
  }

  /// The canonical spelling, as the server stores it.
  String get value {
    final parts = <String>['FREQ=${frequency.name.toUpperCase()}'];
    if (interval > 1) parts.add('INTERVAL=$interval');
    if (weekday != null) parts.add('BYDAY=${_weekdayCodes[weekday]}');
    if (dayOfMonth != null) parts.add('BYMONTHDAY=$dayOfMonth');
    return parts.join(';');
  }
}

class NovaReminder {
  const NovaReminder({
    required this.id,
    required this.title,
    this.remindAt,
    this.dismissed = false,
    this.createdAt,
    this.repeatRule,
  });

  final String id;
  final String title;

  /// The server's `trigger_at`. Null only when the payload was malformed.
  final DateTime? remindAt;

  /// The server's enable/disable flag (`reminders.dismissed`). There is no
  /// `completed` concept server-side, so this replaces the old `completed`
  /// field, which every real payload parsed as `false` because the API never
  /// sends it.
  final bool dismissed;

  final DateTime? createdAt;

  /// The server's `repeat_rule`, when the reminder repeats.
  ///
  /// It used not to be read at all, which is why a reminder could be stored as
  /// "every Monday" and still reach the phone as a one-shot: this field is the
  /// only path from the column to the scheduler.
  final NovaRepeatRule? repeatRule;

  factory NovaReminder.fromJson(Map<String, dynamic> j) => NovaReminder(
    id: (j['id'] ?? '').toString(),
    title: (j['title'] ?? '').toString(),
    // `triggerAt` is what the API actually returns; the older aliases are kept
    // so an un-migrated payload still parses.
    remindAt: _parseDate(
      j['triggerAt'] ?? j['trigger_at'] ?? j['remindAt'] ?? j['remind_at'] ?? j['dueAt'],
    ),
    dismissed: _parseBool(j['dismissed']),
    createdAt: _parseDate(j['createdAt'] ?? j['created_at']),
    repeatRule: NovaRepeatRule.tryParse(j['repeatRule'] ?? j['repeat_rule']),
  );
}

/// One page of `GET /api/v1/reminders`, as the server paginates it.
///
/// The route is cursor-paginated (`pagination.nextCursor` / `prevCursor`, a
/// `hasMore` flag and a `total`) over `(created_at, id)`. Treating the first page
/// as the whole list is what made a user with 51+ reminders lose the alarms for
/// reminders 51 and beyond on every sync.
@immutable
class NovaReminderPage {
  const NovaReminderPage({
    required this.reminders,
    required this.nextCursor,
    required this.hasMore,
  });

  final List<NovaReminder> reminders;

  /// The cursor to pass back as `cursor` for the next page. Null when there is none.
  final String? nextCursor;

  /// Whether the server says more reminders exist beyond this page.
  final bool hasMore;
}

/// Every reminder the account has, and whether that really is every one.
///
/// [complete] is the important half. It is `false` when pagination stopped before
/// the server ran out of pages — a page failed to load, the cursor stopped
/// advancing, or the page bound was reached. Callers must treat an incomplete list
/// as "not the whole truth": it is safe to *schedule* from it and never safe to
/// cancel anything on the strength of it, because a reminder that is merely on a
/// page nobody fetched is not a reminder that was deleted.
@immutable
class NovaReminderList {
  const NovaReminderList({required this.reminders, required this.complete});

  final List<NovaReminder> reminders;
  final bool complete;
}

/// The assistant's avatar appearance (`GET/POST /api/v1/settings/avatars`).
///
/// `userId` is UNIQUE on the server, so there is at most one per user. The
/// table has no name or image URL column — the export's "Avatar & Appearance"
/// maps onto these three fields.
class NovaAvatarPrefs {
  const NovaAvatarPrefs({
    this.id,
    this.assetId,
    this.emotion = 'neutral',
    this.animationDensity = 'medium',
  });

  final String? id;
  final String? assetId;
  final String emotion;
  final String animationDensity;

  static const emotions = <String>[
    'neutral',
    'happy',
    'calm',
    'curious',
    'focused',
  ];
  static const densities = <String>['low', 'medium', 'high'];

  factory NovaAvatarPrefs.fromJson(Map<String, dynamic> j) => NovaAvatarPrefs(
    id: j['id']?.toString(),
    assetId: j['assetId'] as String?,
    emotion: (j['emotion'] ?? 'neutral').toString(),
    animationDensity: (j['animationDensity'] ?? 'medium').toString(),
  );

  Map<String, dynamic> toJson() => {
    'assetId': assetId,
    'emotion': emotion,
    'animationDensity': animationDensity,
  };

  NovaAvatarPrefs copyWith({
    String? assetId,
    String? emotion,
    String? animationDensity,
  }) => NovaAvatarPrefs(
    id: id,
    assetId: assetId ?? this.assetId,
    emotion: emotion ?? this.emotion,
    animationDensity: animationDensity ?? this.animationDensity,
  );
}

// ─── Voice ────────────────────────────────────────────────────────────────────
/// One translation result from `POST /api/v1/voice/translate`.
class NovaTranslation {
  const NovaTranslation({
    required this.translatedText,
    required this.sourceLanguage,
    required this.targetLanguage,
    required this.detectedLanguage,
  });

  final String translatedText;
  final String sourceLanguage;
  final String targetLanguage;

  /// What the server detected; equals [sourceLanguage] when it was explicit.
  final String detectedLanguage;

  factory NovaTranslation.fromJson(Map<String, dynamic> j) {
    final source = (j['sourceLanguage'] ?? '').toString();
    return NovaTranslation(
      translatedText: (j['translatedText'] ?? '').toString(),
      sourceLanguage: source,
      targetLanguage: (j['targetLanguage'] ?? '').toString(),
      detectedLanguage: (j['detectedLanguage'] ?? source).toString(),
    );
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

class NovaProfile {
  const NovaProfile({
    required this.id,
    required this.email,
    this.name,
    this.phone,
    this.locale,
    this.timezone,
    this.avatarUrl,
    this.emailVerified = false,
  });

  final String id;
  final String email;
  final String? name;
  final String? phone;
  final String? locale;
  final String? timezone;
  final String? avatarUrl;
  final bool emailVerified;

  String get displayName {
    final n = name?.trim();
    if (n != null && n.isNotEmpty) return n;
    return email.split('@').first;
  }

  factory NovaProfile.fromJson(Map<String, dynamic> j) => NovaProfile(
    id: (j['id'] ?? '').toString(),
    email: (j['email'] ?? '').toString(),
    name: j['name'] as String?,
    phone: j['phone'] as String?,
    locale: j['locale'] as String?,
    timezone: j['timezone'] as String?,
    avatarUrl: j['avatarUrl'] as String?,
    emailVerified: _parseBool(j['emailVerified'] ?? j['email_verified']),
  );
}

/// Privacy toggles shown by the Privacy screen.
///
/// The blueprint's §5.15 wireframe lists exactly these switches plus per-artifact
/// auto-delete timers, "export my data" and "delete all my data".
class NovaPrivacyPrefs {
  const NovaPrivacyPrefs({
    this.saveConversations = true,
    this.saveRecordings = true,
    this.saveTranscripts = true,
    this.saveMemories = true,
    this.cloudProcessing = true,
    this.localProcessing = false,
    this.autoDeleteRecordingsDays,
    this.autoDeleteTranscriptsDays,
  });

  final bool saveConversations;
  final bool saveRecordings;
  final bool saveTranscripts;
  final bool saveMemories;
  final bool cloudProcessing;
  final bool localProcessing;
  final int? autoDeleteRecordingsDays;
  final int? autoDeleteTranscriptsDays;

  factory NovaPrivacyPrefs.fromJson(Map<String, dynamic> j) => NovaPrivacyPrefs(
    saveConversations: _parseBool(j['saveConversations'], true),
    saveRecordings: _parseBool(j['saveRecordings'], true),
    saveTranscripts: _parseBool(j['saveTranscripts'], true),
    saveMemories: _parseBool(j['saveMemories'], true),
    cloudProcessing: _parseBool(j['cloudProcessing'], true),
    localProcessing: _parseBool(j['localProcessing']),
    autoDeleteRecordingsDays: j['autoDeleteRecordingsDays'] == null
        ? null
        : _parseInt(j['autoDeleteRecordingsDays']),
    autoDeleteTranscriptsDays: j['autoDeleteTranscriptsDays'] == null
        ? null
        : _parseInt(j['autoDeleteTranscriptsDays']),
  );

  NovaPrivacyPrefs copyWith({
    bool? saveConversations,
    bool? saveRecordings,
    bool? saveTranscripts,
    bool? saveMemories,
    bool? cloudProcessing,
    bool? localProcessing,
    int? autoDeleteRecordingsDays,
    int? autoDeleteTranscriptsDays,
    // `null` for the day fields means "leave unchanged" (the usual Dart
    // convention), so clearing a retention period — the design's "Never" —
    // needs its own explicit signal. Without these, picking Never was a no-op.
    bool clearAutoDeleteRecordingsDays = false,
    bool clearAutoDeleteTranscriptsDays = false,
  }) => NovaPrivacyPrefs(
    saveConversations: saveConversations ?? this.saveConversations,
    saveRecordings: saveRecordings ?? this.saveRecordings,
    saveTranscripts: saveTranscripts ?? this.saveTranscripts,
    saveMemories: saveMemories ?? this.saveMemories,
    cloudProcessing: cloudProcessing ?? this.cloudProcessing,
    localProcessing: localProcessing ?? this.localProcessing,
    autoDeleteRecordingsDays: clearAutoDeleteRecordingsDays
        ? null
        : (autoDeleteRecordingsDays ?? this.autoDeleteRecordingsDays),
    autoDeleteTranscriptsDays: clearAutoDeleteTranscriptsDays
        ? null
        : (autoDeleteTranscriptsDays ?? this.autoDeleteTranscriptsDays),
  );

  Map<String, dynamic> toJson() => {
    'saveConversations': saveConversations,
    'saveRecordings': saveRecordings,
    'saveTranscripts': saveTranscripts,
    'saveMemories': saveMemories,
    'cloudProcessing': cloudProcessing,
    'localProcessing': localProcessing,
    // Always sent, including when null: a null is what clears a retention
    // period. Omitting them meant a saved 30 days could never be removed.
    'autoDeleteRecordingsDays': autoDeleteRecordingsDays,
    'autoDeleteTranscriptsDays': autoDeleteTranscriptsDays,
  };
}

/// Notification and appearance preferences.
///
/// VERIFIED shape (`GET /api/v1/settings/preferences`) — the server nests these:
///   {"notifications":{"push":true,"email":true,"sms":false,"inApp":true},
///    "appearance":{"theme":"system","fontSize":"medium"}}
///
/// An earlier version of this model used flat booleans (`reminders`,
/// `proactiveNudges`…). Zod strips unknown keys rather than rejecting them, so
/// every write would have been silently discarded with a 200 response — the UI
/// would have shown the toggle as saved while nothing persisted.
class NovaNotificationPrefs {
  const NovaNotificationPrefs({
    this.push = true,
    this.email = true,
    this.sms = false,
    this.inApp = true,
    this.theme = 'system',
    this.fontSize = 'medium',
  });

  final bool push;
  final bool email;
  final bool sms;
  final bool inApp;
  final String theme; // 'system' | 'light' | 'dark'
  final String fontSize; // 'small' | 'medium' | 'large'

  factory NovaNotificationPrefs.fromJson(Map<String, dynamic> j) {
    final n = j['notifications'] is Map
        ? Map<String, dynamic>.from(j['notifications'] as Map)
        : const <String, dynamic>{};
    final a = j['appearance'] is Map
        ? Map<String, dynamic>.from(j['appearance'] as Map)
        : const <String, dynamic>{};
    return NovaNotificationPrefs(
      push: _parseBool(n['push'], true),
      email: _parseBool(n['email'], true),
      sms: _parseBool(n['sms']),
      inApp: _parseBool(n['inApp'], true),
      theme: (a['theme'] ?? 'system').toString(),
      fontSize: (a['fontSize'] ?? 'medium').toString(),
    );
  }

  NovaNotificationPrefs copyWith({
    bool? push,
    bool? email,
    bool? sms,
    bool? inApp,
    String? theme,
    String? fontSize,
  }) => NovaNotificationPrefs(
    push: push ?? this.push,
    email: email ?? this.email,
    sms: sms ?? this.sms,
    inApp: inApp ?? this.inApp,
    theme: theme ?? this.theme,
    fontSize: fontSize ?? this.fontSize,
  );

  /// Rebuilds the nested envelope the API expects.
  Map<String, dynamic> toJson() => {
    'notifications': {
      'push': push,
      'email': email,
      'sms': sms,
      'inApp': inApp,
    },
    'appearance': {'theme': theme, 'fontSize': fontSize},
  };
}

/// The companion's persona.
///
/// VERIFIED shape (`GET /api/v1/settings/persona`):
///   {"name":"Assistant","personality":"friendly","voiceSpeed":100,
///    "voiceTone":"neutral","languagePolicy":"auto","wakeWordEnabled":true}
///
/// The field is `personality`, not `tone`, and there is no `avatarId` — the
/// avatar catalogue is a separate resource (`/settings/avatars`).
class NovaPersona {
  const NovaPersona({
    this.name = 'Nova',
    this.personality = 'friendly',
    this.voiceSpeed = 100,
    this.voiceTone = 'neutral',
    this.languagePolicy = 'auto',
    this.wakeWordEnabled = false,
  });

  final String name;

  /// friendly | professional | executive | companion
  final String personality;

  /// 50–200 (the API clamps to this range).
  final int voiceSpeed;

  /// neutral | warm | calm | …
  final String voiceTone;

  /// auto | en | ta | tanglish
  final String languagePolicy;

  final bool wakeWordEnabled;

  factory NovaPersona.fromJson(Map<String, dynamic> j) => NovaPersona(
    name: (j['name'] ?? 'Nova').toString(),
    personality: (j['personality'] ?? 'friendly').toString(),
    voiceSpeed: _parseInt(j['voiceSpeed'], 100),
    voiceTone: (j['voiceTone'] ?? 'neutral').toString(),
    languagePolicy: (j['languagePolicy'] ?? 'auto').toString(),
    wakeWordEnabled: _parseBool(j['wakeWordEnabled']),
  );

  NovaPersona copyWith({
    String? name,
    String? personality,
    int? voiceSpeed,
    String? voiceTone,
    String? languagePolicy,
    bool? wakeWordEnabled,
  }) => NovaPersona(
    name: name ?? this.name,
    personality: personality ?? this.personality,
    voiceSpeed: voiceSpeed ?? this.voiceSpeed,
    voiceTone: voiceTone ?? this.voiceTone,
    languagePolicy: languagePolicy ?? this.languagePolicy,
    wakeWordEnabled: wakeWordEnabled ?? this.wakeWordEnabled,
  );

  Map<String, dynamic> toJson() => {
    'name': name,
    'personality': personality,
    'voiceSpeed': voiceSpeed,
    'voiceTone': voiceTone,
    'languagePolicy': languagePolicy,
    'wakeWordEnabled': wakeWordEnabled,
  };
}

/// One page of a paginated list endpoint.
class NovaPage<T> {
  const NovaPage({required this.items, this.total, this.page, this.hasMore});

  final List<T> items;
  final int? total;
  final int? page;
  final bool? hasMore;
}

// ─── Activity centre (audit_logs) ─────────────────────────────────────────────

/// One entry in the Activity Centre. Backed by `audit_logs`.
class NovaActivityItem {
  const NovaActivityItem({
    required this.id,
    required this.action,
    this.targetType,
    this.targetId,
    this.outcome,
    this.sourceDevice,
    this.details,
    this.occurredAt,
  });

  final String id;
  final String action;
  final String? targetType;
  final String? targetId;
  final String? outcome;
  final String? sourceDevice;
  final Map<String, dynamic>? details;
  final DateTime? occurredAt;

  /// The export's filters are All / Pending / Approvals / Completed / Errors.
  bool get isError =>
      (outcome ?? '').toLowerCase() == 'failure' ||
      (outcome ?? '').toLowerCase() == 'error';

  bool get isPending => (outcome ?? '').toLowerCase() == 'pending';

  bool get isCompleted => (outcome ?? '').toLowerCase() == 'success';

  bool get isApproval => action.toLowerCase().contains('approval');

  /// Human title — the export shows "Reminder created: Call Kumar at 10:00 AM".
  String get title {
    final pretty = action
        .replaceAll('_', ' ')
        .replaceAll('.', ' ')
        .trim();
    if (pretty.isEmpty) return 'Activity';
    return pretty[0].toUpperCase() + pretty.substring(1);
  }

  factory NovaActivityItem.fromJson(Map<String, dynamic> j) => NovaActivityItem(
    id: (j['id'] ?? '').toString(),
    action: (j['action'] ?? '').toString(),
    targetType: j['targetType'] as String?,
    targetId: j['targetId'] as String?,
    outcome: j['outcome'] as String?,
    sourceDevice: j['sourceDevice'] as String?,
    details: j['details'] is Map
        ? Map<String, dynamic>.from(j['details'] as Map)
        : null,
    occurredAt: _parseDate(j['occurredAt'] ?? j['occurred_at']),
  );
}

// ─── Recordings & summaries ───────────────────────────────────────────────────

class NovaRecording {
  const NovaRecording({
    required this.id,
    required this.title,
    this.durationSeconds,
    this.language,
    this.status = 'recording',
    this.participants,
    this.consentRecorded = false,
    this.completedAt,
    this.createdAt,
  });

  final String id;
  final String title;
  final int? durationSeconds;
  final String? language;
  final String status; // recording | processing | completed | failed
  final List<String>? participants;
  final bool consentRecorded;
  final DateTime? completedAt;
  final DateTime? createdAt;

  bool get isLive => status == 'recording';

  String get durationLabel {
    final s = durationSeconds ?? 0;
    final m = s ~/ 60;
    final sec = s % 60;
    return '${m.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}';
  }

  factory NovaRecording.fromJson(Map<String, dynamic> j) => NovaRecording(
    id: (j['id'] ?? '').toString(),
    title: (j['title'] ?? 'Recording').toString(),
    durationSeconds: j['durationSeconds'] == null
        ? null
        : _parseInt(j['durationSeconds']),
    language: j['language'] as String?,
    status: (j['status'] ?? 'recording').toString(),
    participants: (j['participants'] as List?)?.map((e) => e.toString()).toList(),
    consentRecorded: _parseBool(j['consentRecorded']),
    completedAt: _parseDate(j['completedAt']),
    createdAt: _parseDate(j['createdAt']),
  );
}

/// One extracted action item.
///
/// The server's structured form is
/// `{text, owner, dueDate, dueDateIso}`; an older revision returned bare
/// strings, so [fromJson] accepts either and never throws on the other.
@immutable
class NovaActionItem {
  const NovaActionItem({
    required this.text,
    this.owner,
    this.dueDate,
    this.dueDateIso,
  });

  final String text;

  /// Who owns it, or null when the transcript did not name anyone. Rendered as
  /// "Unassigned" rather than left blank.
  final String? owner;

  /// Human wording for the deadline, or null. Rendered as "No due date".
  final String? dueDate;

  /// Machine-readable deadline, when the server could resolve one.
  final String? dueDateIso;

  factory NovaActionItem.fromJson(Object? value) {
    if (value is Map) {
      final m = Map<String, dynamic>.from(value);
      final text = (m['text'] ?? m['title'] ?? m['item'] ?? '').toString();
      return NovaActionItem(
        text: text,
        owner: _stringOrNull(m['owner'] ?? m['assignee']),
        dueDate: _stringOrNull(m['dueDate'] ?? m['due_date']),
        dueDateIso: _stringOrNull(m['dueDateIso'] ?? m['due_date_iso']),
      );
    }
    return NovaActionItem(text: value?.toString() ?? '');
  }
}

/// A contact the transcript or model surfaced. No contact permission, no
/// address book — this is only what was said or inferred.
@immutable
class NovaExtractedContact {
  const NovaExtractedContact({
    required this.detail,
    this.name,
    this.source = 'transcript',
  });

  final String? name;

  /// The phone number, email or handle as it appeared.
  final String detail;

  /// `transcript` when it was said aloud, `model` when it was inferred.
  final String source;

  factory NovaExtractedContact.fromJson(Object? value) {
    if (value is Map) {
      final m = Map<String, dynamic>.from(value);
      return NovaExtractedContact(
        name: _stringOrNull(m['name']),
        detail: (m['detail'] ?? m['value'] ?? m['text'] ?? '').toString(),
        source: (m['source'] ?? 'transcript').toString(),
      );
    }
    return NovaExtractedContact(detail: value?.toString() ?? '');
  }
}

/// One transcript segment. `speakerIndex` is always 0 and means
/// **unattributed** — the pipeline does not diarise, so this is never rendered
/// as a speaker label.
@immutable
class NovaTranscriptSegment {
  const NovaTranscriptSegment({
    required this.id,
    required this.text,
    this.speakerIndex = 0,
    this.startMs = 0,
    this.endMs = 0,
    this.confidence,
  });

  final String id;
  final String text;
  final int speakerIndex;
  final int startMs;
  final int endMs;
  final double? confidence;

  factory NovaTranscriptSegment.fromJson(Map<String, dynamic> j) =>
      NovaTranscriptSegment(
        id: (j['id'] ?? '').toString(),
        text: (j['text'] ?? '').toString(),
        speakerIndex: (j['speakerIndex'] as num?)?.toInt() ?? 0,
        startMs: (j['startMs'] as num?)?.toInt() ?? 0,
        endMs: (j['endMs'] as num?)?.toInt() ?? 0,
        confidence: (j['confidence'] as num?)?.toDouble(),
      );
}

class NovaRecordingSummary {
  const NovaRecordingSummary({
    required this.id,
    this.summary,
    this.decisions = const [],
    this.actionItems = const [],
    this.extractedContacts = const [],
    this.createdAt,
  });

  final String id;
  final String? summary;
  final List<String> decisions;
  final List<NovaActionItem> actionItems;
  final List<NovaExtractedContact> extractedContacts;
  final DateTime? createdAt;

  /// True when the summary row exists but has no readable content — which is a
  /// different fact from "the pipeline has not run yet".
  bool get isEmpty =>
      (summary == null || summary!.trim().isEmpty) &&
      decisions.isEmpty &&
      actionItems.isEmpty &&
      extractedContacts.isEmpty;

  factory NovaRecordingSummary.fromJson(Map<String, dynamic> j) {
    List<String> strings(Object? v) {
      if (v is List) {
        return v.map((e) => e.toString()).where((s) => s.isNotEmpty).toList();
      }
      if (v is String && v.isNotEmpty) return [v];
      return const [];
    }

    List<T> objects<T>(Object? v, T Function(Object?) parse) {
      if (v is List) return v.map(parse).toList();
      if (v is String && v.isNotEmpty) return [parse(v)];
      return const [];
    }

    return NovaRecordingSummary(
      id: (j['id'] ?? '').toString(),
      summary: _stringOrNull(j['summary']),
      decisions: strings(j['decisions']),
      actionItems: objects(j['actionItems'] ?? j['action_items'], NovaActionItem.fromJson),
      extractedContacts: objects(
        j['extractedContacts'] ?? j['extracted_contacts'],
        NovaExtractedContact.fromJson,
      ),
      createdAt: _parseDate(j['createdAt']),
    );
  }
}

/// Where the uploaded audio ended up, as the server reports it.
@immutable
class NovaRecordingStorage {
  const NovaRecordingStorage({
    required this.objectStorage,
    this.key,
    this.bytes,
    this.checksum,
  });

  /// True when the bytes reached object storage. False means the server kept
  /// them another way — the UI must not say "stored in object storage" then.
  final bool objectStorage;
  final String? key;
  final int? bytes;
  final String? checksum;

  factory NovaRecordingStorage.fromJson(Map<String, dynamic> j) =>
      NovaRecordingStorage(
        objectStorage: _parseBool(j['objectStorage']),
        key: _stringOrNull(j['key']),
        bytes: (j['bytes'] as num?)?.toInt(),
        checksum: _stringOrNull(j['checksum']),
      );

  static const NovaRecordingStorage unknown = NovaRecordingStorage(
    objectStorage: false,
  );
}

/// The result of `POST /recordings/:id/audio`.
@immutable
class NovaRecordingUpload {
  const NovaRecordingUpload({required this.recording, required this.storage});

  final NovaRecording recording;
  final NovaRecordingStorage storage;
}

/// What `GET /recordings/capabilities` reports.
@immutable
class NovaRecordingCapabilities {
  const NovaRecordingCapabilities({
    this.transcription = 'unavailable',
    this.diarisation = false,
    this.objectStorage = false,
    this.maxUploadBytes = 0,
    this.reason = const {},
  });

  /// `async`, `sync` or `unavailable`.
  final String transcription;

  /// Always false today: the pipeline does not attribute speakers.
  final bool diarisation;
  final bool objectStorage;
  final int maxUploadBytes;

  /// Why a capability is missing, as prose the UI can show.
  final Map<String, dynamic> reason;

  bool get canTranscribe => transcription != 'unavailable';

  factory NovaRecordingCapabilities.fromJson(Map<String, dynamic> j) =>
      NovaRecordingCapabilities(
        transcription: (j['transcription'] ?? 'unavailable').toString(),
        diarisation: _parseBool(j['diarisation']),
        objectStorage: _parseBool(j['objectStorage']),
        maxUploadBytes: (j['maxUploadBytes'] as num?)?.toInt() ?? 0,
        reason: j['reason'] is Map
            ? Map<String, dynamic>.from(j['reason'] as Map)
            : const {},
      );
}

/// A recording together with its transcript, segments and summary, as the
/// `/recordings/:id` detail route returns them.
class NovaRecordingDetail {
  const NovaRecordingDetail({
    required this.recording,
    this.transcript,
    this.summary,
    this.segments = const [],
  });

  final NovaRecording recording;
  final String? transcript;
  final NovaRecordingSummary? summary;
  final List<NovaTranscriptSegment> segments;

  /// True when nothing was extracted at all — the state that must be stated
  /// plainly instead of rendering empty sections.
  bool get hasNothing =>
      (transcript == null || transcript!.trim().isEmpty) &&
      (summary == null || summary!.isEmpty);
}

// ─── Tools & approvals ────────────────────────────────────────────────────────

class NovaToolDefinition {
  const NovaToolDefinition({
    required this.id,
    required this.name,
    this.description,
    this.permissionLevel,
    this.confirmationRequired = true,
  });

  final String id;
  final String name;
  final String? description;

  /// L0 read-only … L4 financial (blueprint §10.1). An integer, not a string.
  final int? permissionLevel;
  final bool confirmationRequired;

  factory NovaToolDefinition.fromJson(Map<String, dynamic> j) =>
      NovaToolDefinition(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        description: j['description'] as String?,
        permissionLevel: (j['permissionLevel'] as num?)?.toInt(),
        confirmationRequired: _parseBool(j['confirmationRequired'], true),
      );
}

/// A pending side-effecting action awaiting the user's confirmation.
/// Shown by the Tool Confirmation sheet before anything external happens.
class NovaToolApproval {
  const NovaToolApproval({
    required this.id,
    required this.toolName,
    this.toolInput,
    this.permissionLevel,
    this.status = 'pending',
    this.expiresAt,
    this.createdAt,
  });

  final String id;
  final String toolName;
  final Map<String, dynamic>? toolInput;
  final int? permissionLevel;
  final String status;
  final DateTime? expiresAt;
  final DateTime? createdAt;

  bool get isPending => status == 'pending';

  factory NovaToolApproval.fromJson(Map<String, dynamic> j) => NovaToolApproval(
    id: (j['id'] ?? '').toString(),
    toolName: (j['toolName'] ?? j['tool_name'] ?? 'Action').toString(),
    toolInput: j['toolInput'] is Map
        ? Map<String, dynamic>.from(j['toolInput'] as Map)
        : null,
    permissionLevel: (j['permissionLevel'] as num?)?.toInt(),
    status: (j['status'] ?? 'pending').toString(),
    expiresAt: _parseDate(j['expiresAt']),
    createdAt: _parseDate(j['createdAt']),
  );
}

// ─── Consent ──────────────────────────────────────────────────────────────────

class NovaConsentRecord {
  const NovaConsentRecord({
    required this.id,
    required this.purpose,
    required this.granted,
    this.method,
    this.consentedAt,
    this.revokedAt,
  });

  final String id;
  final String purpose;
  final bool granted;
  final String? method;
  final DateTime? consentedAt;
  final DateTime? revokedAt;

  bool get isActive => granted && revokedAt == null;

  factory NovaConsentRecord.fromJson(Map<String, dynamic> j) => NovaConsentRecord(
    id: (j['id'] ?? '').toString(),
    purpose: (j['purpose'] ?? '').toString(),
    granted: _parseBool(j['granted']),
    method: j['method'] as String?,
    consentedAt: _parseDate(j['consentedAt']),
    revokedAt: _parseDate(j['revokedAt']),
  );
}

// ─── Account deletion ─────────────────────────────────────────────────────────

/// What `DELETE /api/v1/account` will remove, read from
/// `GET /api/v1/account/deletion-preview`.
///
/// Deliberately partial: everything else (tasks, reminders, memories, conversations,
/// transcripts, sessions, devices) cascades from the user row, so the server reports
/// the two collections a user can recognise plus the retention statement, rather than
/// counts that would drift from the schema.
class NovaDeletionPreview {
  const NovaDeletionPreview({
    required this.email,
    required this.recordings,
    required this.consentRecords,
    required this.retentionPeriod,
    this.requiresPassword = true,
  });

  final String email;
  final int recordings;
  final int consentRecords;
  final String retentionPeriod;

  /// Whether the account has a password at all. `users.password_hash` is nullable, so
  /// an account created through a phone/OAuth path would otherwise be asked for a
  /// password it never set and the delete button could never be enabled. Defaults to
  /// `true` so a preview that failed to load errs toward the safer prompt.
  final bool requiresPassword;

  factory NovaDeletionPreview.fromJson(Map<String, dynamic> j) =>
      NovaDeletionPreview(
        email: (j['email'] ?? '').toString(),
        recordings: _parseInt(j['recordings']),
        consentRecords: _parseInt(j['consentRecords']),
        retentionPeriod: (j['retentionPeriod'] ?? '').toString(),
        requiresPassword: j.containsKey('requiresPassword')
            ? _parseBool(j['requiresPassword'])
            : true,
      );
}

// ─── Daily briefing ───────────────────────────────────────────────────────────

/// The daily briefing (`GET /api/v1/briefing`, master document §9.4).
///
/// `text` is already composed and normalised server-side for speech: it carries
/// no markdown, no bullet characters, no URLs and no emoji. The client's job is
/// only to decide *when* to ask and to read it aloud.
///
/// [capabilities] is not decoration. The server reports which sources it
/// actually had, so a screen can say honestly that NOVA has no calendar and no
/// weather rather than implying a briefing that knows about meetings.
class NovaBriefing {
  const NovaBriefing({
    required this.text,
    this.source = 'grounded',
    this.language = 'en',
    this.guardRejection,
    this.generatedAt,
    this.counts = const <String, int>{},
    this.capabilities = const <String, bool>{},
  });

  /// Speakable text.
  final String text;

  /// `model` when a model draft survived the server's grounding guard,
  /// `grounded` when the text was rendered directly from the user's own rows.
  final String source;

  final String language;

  /// Why a model draft was discarded, when one was.
  final String? guardRejection;

  final DateTime? generatedAt;

  /// Counts behind the briefing: `overdue`, `dueToday`, `later`, `undated`,
  /// `upcomingReminders`, `missedReminders`, `memories`.
  final Map<String, int> counts;

  /// Source flags: `calendar`, `weather`, `eveningRecap`, `locationNudges`,
  /// `tasks`, `reminders`, `memories`.
  final Map<String, bool> capabilities;

  bool get isEmpty => text.trim().isEmpty;

  int count(String name) => counts[name] ?? 0;

  bool hasSource(String name) => capabilities[name] ?? false;

  /// The sources the server does *not* have, in a stable order.
  Iterable<String> get missingSources =>
      capabilities.entries.where((e) => e.value == false).map((e) => e.key);

  factory NovaBriefing.fromJson(Map<String, dynamic> j) => NovaBriefing(
    text: (j['text'] ?? '').toString(),
    source: (j['source'] ?? 'grounded').toString(),
    language: (j['language'] ?? 'en').toString(),
    guardRejection: j['guardRejection'] as String?,
    generatedAt: _parseDate(j['generatedAt']),
    counts: _intMap(j['counts']),
    capabilities: _boolMap(j['capabilities']),
  );

  static Map<String, int> _intMap(Object? value) {
    if (value is! Map) return const <String, int>{};
    return <String, int>{
      for (final entry in value.entries)
        entry.key.toString(): _parseInt(entry.value),
    };
  }

  static Map<String, bool> _boolMap(Object? value) {
    if (value is! Map) return const <String, bool>{};
    return <String, bool>{
      for (final entry in value.entries)
        entry.key.toString(): _parseBool(entry.value),
    };
  }
}

// ─── NOVA's own notifications ─────────────────────────────────────────────────

/// A nudge NOVA itself produced: a reminder coming due, a follow-up, a briefing.
///
/// Distinct from `notification_models.dart`, which models the *assistant* that
/// reads other apps' notifications. The server has served `/notifications`
/// (list, read, delete, unread count) since the table existed, and the app called
/// none of it — so the only record of a nudge was the system notification, and
/// dismissing the shade lost it for good.
class NovaNotification {
  const NovaNotification({
    required this.id,
    required this.title,
    required this.body,
    required this.type,
    required this.read,
    this.category,
    this.actionUrl,
    this.occurredAt,
    this.readAt,
  });

  final String id;
  final String title;
  final String body;
  final String type;
  final bool read;
  final String? category;
  final String? actionUrl;
  final DateTime? occurredAt;
  final DateTime? readAt;

  factory NovaNotification.fromJson(Map<String, dynamic> j) {
    final payload = j['payload'] is Map
        ? Map<String, dynamic>.from(j['payload'] as Map)
        : const <String, dynamic>{};
    return NovaNotification(
      id: (j['id'] ?? '').toString(),
      title: (j['title'] ?? '').toString(),
      body: (j['body'] ?? '').toString(),
      type: (j['type'] ?? 'info').toString(),
      read: j['read'] == true,
      category: (payload['category'] ?? j['category']) as String?,
      actionUrl: (payload['actionUrl'] ?? j['actionUrl']) as String?,
      occurredAt: _parseDate(j['occurredAt'] ?? j['occurred_at']),
      readAt: _parseDate(j['readAt'] ?? j['read_at']),
    );
  }
}
