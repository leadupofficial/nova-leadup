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

class NovaReminder {
  const NovaReminder({
    required this.id,
    required this.title,
    this.notes,
    this.remindAt,
    this.completed = false,
    this.createdAt,
  });

  final String id;
  final String title;
  final String? notes;
  final DateTime? remindAt;
  final bool completed;
  final DateTime? createdAt;

  factory NovaReminder.fromJson(Map<String, dynamic> j) => NovaReminder(
    id: (j['id'] ?? '').toString(),
    title: (j['title'] ?? '').toString(),
    notes: j['notes'] as String?,
    remindAt: _parseDate(j['remindAt'] ?? j['remind_at'] ?? j['dueAt']),
    completed: _parseBool(j['completed'] ?? j['isCompleted']),
    createdAt: _parseDate(j['createdAt'] ?? j['created_at']),
  );
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
    this.recordingRetentionDays,
    this.transcriptRetentionDays,
  });

  final bool saveConversations;
  final bool saveRecordings;
  final bool saveTranscripts;
  final bool saveMemories;
  final bool cloudProcessing;
  final bool localProcessing;
  final int? recordingRetentionDays;
  final int? transcriptRetentionDays;

  factory NovaPrivacyPrefs.fromJson(Map<String, dynamic> j) => NovaPrivacyPrefs(
    saveConversations: _parseBool(j['saveConversations'], true),
    saveRecordings: _parseBool(j['saveRecordings'], true),
    saveTranscripts: _parseBool(j['saveTranscripts'], true),
    saveMemories: _parseBool(j['saveMemories'], true),
    cloudProcessing: _parseBool(j['cloudProcessing'], true),
    localProcessing: _parseBool(j['localProcessing']),
    recordingRetentionDays: j['recordingRetentionDays'] == null
        ? null
        : _parseInt(j['recordingRetentionDays']),
    transcriptRetentionDays: j['transcriptRetentionDays'] == null
        ? null
        : _parseInt(j['transcriptRetentionDays']),
  );

  NovaPrivacyPrefs copyWith({
    bool? saveConversations,
    bool? saveRecordings,
    bool? saveTranscripts,
    bool? saveMemories,
    bool? cloudProcessing,
    bool? localProcessing,
    int? recordingRetentionDays,
    int? transcriptRetentionDays,
  }) => NovaPrivacyPrefs(
    saveConversations: saveConversations ?? this.saveConversations,
    saveRecordings: saveRecordings ?? this.saveRecordings,
    saveTranscripts: saveTranscripts ?? this.saveTranscripts,
    saveMemories: saveMemories ?? this.saveMemories,
    cloudProcessing: cloudProcessing ?? this.cloudProcessing,
    localProcessing: localProcessing ?? this.localProcessing,
    recordingRetentionDays:
        recordingRetentionDays ?? this.recordingRetentionDays,
    transcriptRetentionDays:
        transcriptRetentionDays ?? this.transcriptRetentionDays,
  );

  Map<String, dynamic> toJson() => {
    'saveConversations': saveConversations,
    'saveRecordings': saveRecordings,
    'saveTranscripts': saveTranscripts,
    'saveMemories': saveMemories,
    'cloudProcessing': cloudProcessing,
    'localProcessing': localProcessing,
    if (recordingRetentionDays != null)
      'recordingRetentionDays': recordingRetentionDays,
    if (transcriptRetentionDays != null)
      'transcriptRetentionDays': transcriptRetentionDays,
  };
}

class NovaNotificationPrefs {
  const NovaNotificationPrefs({
    this.reminders = true,
    this.proactiveNudges = true,
    this.dailyBriefing = false,
    this.email = false,
    this.quietHoursStart,
    this.quietHoursEnd,
  });

  final bool reminders;
  final bool proactiveNudges;
  final bool dailyBriefing;
  final bool email;
  final String? quietHoursStart;
  final String? quietHoursEnd;

  factory NovaNotificationPrefs.fromJson(Map<String, dynamic> j) =>
      NovaNotificationPrefs(
        reminders: _parseBool(j['reminders'], true),
        proactiveNudges: _parseBool(j['proactiveNudges'], true),
        dailyBriefing: _parseBool(j['dailyBriefing']),
        email: _parseBool(j['email']),
        quietHoursStart: j['quietHoursStart'] as String?,
        quietHoursEnd: j['quietHoursEnd'] as String?,
      );

  NovaNotificationPrefs copyWith({
    bool? reminders,
    bool? proactiveNudges,
    bool? dailyBriefing,
    bool? email,
  }) => NovaNotificationPrefs(
    reminders: reminders ?? this.reminders,
    proactiveNudges: proactiveNudges ?? this.proactiveNudges,
    dailyBriefing: dailyBriefing ?? this.dailyBriefing,
    email: email ?? this.email,
    quietHoursStart: quietHoursStart,
    quietHoursEnd: quietHoursEnd,
  );

  Map<String, dynamic> toJson() => {
    'reminders': reminders,
    'proactiveNudges': proactiveNudges,
    'dailyBriefing': dailyBriefing,
    'email': email,
  };
}

/// The companion's persona — name, tone and language policy (blueprint §5.16).
class NovaPersona {
  const NovaPersona({
    this.name = 'Nova',
    this.tone = 'warm',
    this.languagePolicy = 'auto',
    this.avatarId,
  });

  final String name;
  final String tone;
  final String languagePolicy;
  final String? avatarId;

  factory NovaPersona.fromJson(Map<String, dynamic> j) => NovaPersona(
    name: (j['name'] ?? 'Nova').toString(),
    tone: (j['tone'] ?? 'warm').toString(),
    languagePolicy: (j['languagePolicy'] ?? 'auto').toString(),
    avatarId: j['avatarId'] as String?,
  );

  Map<String, dynamic> toJson() => {
    'name': name,
    'tone': tone,
    'languagePolicy': languagePolicy,
    if (avatarId != null) 'avatarId': avatarId,
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
