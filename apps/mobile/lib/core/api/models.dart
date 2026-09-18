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
  }) => NovaPrivacyPrefs(
    saveConversations: saveConversations ?? this.saveConversations,
    saveRecordings: saveRecordings ?? this.saveRecordings,
    saveTranscripts: saveTranscripts ?? this.saveTranscripts,
    saveMemories: saveMemories ?? this.saveMemories,
    cloudProcessing: cloudProcessing ?? this.cloudProcessing,
    localProcessing: localProcessing ?? this.localProcessing,
    autoDeleteRecordingsDays:
        autoDeleteRecordingsDays ?? this.autoDeleteRecordingsDays,
    autoDeleteTranscriptsDays:
        autoDeleteTranscriptsDays ?? this.autoDeleteTranscriptsDays,
  );

  Map<String, dynamic> toJson() => {
    'saveConversations': saveConversations,
    'saveRecordings': saveRecordings,
    'saveTranscripts': saveTranscripts,
    'saveMemories': saveMemories,
    'cloudProcessing': cloudProcessing,
    'localProcessing': localProcessing,
    if (autoDeleteRecordingsDays != null)
      'autoDeleteRecordingsDays': autoDeleteRecordingsDays,
    if (autoDeleteTranscriptsDays != null)
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
  final List<String> actionItems;
  final List<String> extractedContacts;
  final DateTime? createdAt;

  factory NovaRecordingSummary.fromJson(Map<String, dynamic> j) {
    List<String> asList(Object? v) {
      if (v is List) return v.map((e) => e.toString()).toList();
      if (v is String && v.isNotEmpty) return [v];
      return const [];
    }

    return NovaRecordingSummary(
      id: (j['id'] ?? '').toString(),
      summary: j['summary'] as String?,
      decisions: asList(j['decisions']),
      actionItems: asList(j['actionItems'] ?? j['action_items']),
      extractedContacts: asList(j['extractedContacts']),
      createdAt: _parseDate(j['createdAt']),
    );
  }
}

/// A recording together with its transcript and summary, as the
/// `/recordings/:id` detail route returns them.
class NovaRecordingDetail {
  const NovaRecordingDetail({
    required this.recording,
    this.transcript,
    this.summary,
  });

  final NovaRecording recording;
  final String? transcript;
  final NovaRecordingSummary? summary;
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
