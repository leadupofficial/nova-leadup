import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/reminders/reminder_sync.dart';
import 'models.dart';
import 'nova_api.dart';

/// Riverpod data layer for the feature screens.
///
/// Every provider exposes the three states the export designs for — loading,
/// error and empty — and the error is surfaced as a [NovaApiException] rather
/// than being swallowed into an empty list. The admin console shipped the
/// swallow-into-empty bug and it made a 401 look like an empty database; the
/// screens here render the message instead.
///
/// Providers are `autoDispose` where the data is only needed while its screen is
/// mounted, and invalidated after a mutation so counts stay truthful.

// ─── Tasks ────────────────────────────────────────────────────────────────────

final tasksProvider = FutureProvider.autoDispose<List<NovaTask>>((ref) async {
  final api = ref.watch(novaApiProvider);
  return api.listTasks();
});

final taskSummaryProvider = FutureProvider.autoDispose<TaskSummary>((
  ref,
) async {
  final tasks = await ref.watch(tasksProvider.future);
  final now = DateTime.now();
  final open = tasks.where((t) => !t.isDone).toList();
  return TaskSummary(
    total: tasks.length,
    open: open.length,
    completed: tasks.length - open.length,
    overdue: tasks.where((t) => t.isOverdue).length,
    dueToday: open
        .where(
          (t) =>
              t.dueAt != null &&
              t.dueAt!.year == now.year &&
              t.dueAt!.month == now.month &&
              t.dueAt!.day == now.day,
        )
        .length,
  );
});

class TaskSummary {
  const TaskSummary({
    required this.total,
    required this.open,
    required this.completed,
    required this.overdue,
    required this.dueToday,
  });

  final int total;
  final int open;
  final int completed;
  final int overdue;
  final int dueToday;

  static const empty = TaskSummary(
    total: 0,
    open: 0,
    completed: 0,
    overdue: 0,
    dueToday: 0,
  );
}

// ─── Memories ─────────────────────────────────────────────────────────────────

final memoriesProvider = FutureProvider.autoDispose<List<NovaMemory>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.listMemories();
});

/// Memory search term. Setting it re-fetches from the server rather than
/// filtering locally, so the result matches what is actually stored.
///
/// Riverpod 3 removed `StateProvider`, so this is a plain [Notifier].
class MemorySearch extends Notifier<String> {
  @override
  String build() => '';

  void set(String value) => state = value;
  void clear() => state = '';
}

final memorySearchProvider = NotifierProvider<MemorySearch, String>(
  MemorySearch.new,
);

final memorySearchResultsProvider =
    FutureProvider.autoDispose<List<NovaMemory>>((ref) async {
      final query = ref.watch(memorySearchProvider);
      if (query.trim().isEmpty) return const [];
      final api = ref.watch(novaApiProvider);
      // Must use the dedicated search route: GET /memories does not filter by
      // text (its query schema has no `search` field), so passing the term
      // there returned every memory as though each one matched.
      return api.searchMemories(query: query.trim());
    });

// ─── Conversations ────────────────────────────────────────────────────────────

final conversationsProvider =
    FutureProvider.autoDispose<List<NovaConversation>>((ref) async {
      final api = ref.watch(novaApiProvider);
      return api.listConversations();
    });

/// Messages for one conversation, keyed by id.
final messagesProvider = FutureProvider.autoDispose
    .family<List<NovaMessage>, String>((ref, conversationId) async {
      final api = ref.watch(novaApiProvider);
      return api.listMessages(conversationId);
    });

// ─── Reminders ────────────────────────────────────────────────────────────────

final remindersProvider = FutureProvider.autoDispose<List<NovaReminder>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  // Every page. A single 50-row page meant the Reminders screen silently showed a
  // partial list to anyone with more than 50 — the same truncation that was
  // deleting their alarms.
  return (await api.listAllReminders()).reminders;
});

// ─── Settings ─────────────────────────────────────────────────────────────────

final profileProvider = FutureProvider.autoDispose<NovaProfile>((ref) async {
  final api = ref.watch(novaApiProvider);
  return api.getProfile();
});

final notificationPrefsProvider =
    FutureProvider.autoDispose<NovaNotificationPrefs>((ref) async {
      final api = ref.watch(novaApiProvider);
      return api.getPreferences();
    });

final privacyPrefsProvider = FutureProvider.autoDispose<NovaPrivacyPrefs>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.getPrivacy();
});

final personaProvider = FutureProvider.autoDispose<NovaPersona>((ref) async {
  final api = ref.watch(novaApiProvider);
  return api.getPersona();
});

/// §13.10 — the wake word recorded against the user's account, as a raw map.
///
/// This is the *server's* record of a choice the device enforces. The screen
/// that shows it must not present it as what the microphone listens for; see
/// `features/settings/wake_word_settings_page.dart`.
final wakeWordConfigProvider = FutureProvider.autoDispose<Map<String, dynamic>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.getWakeWordConfig();
});

/// The saved avatar appearance, or a default when none has been stored yet.
/// The route upserts, so the default here is a legitimate blank slate rather
/// than a fabricated saved value.
final avatarPrefsProvider =
    FutureProvider.autoDispose<NovaAvatarPrefs>((ref) async {
      final api = ref.watch(novaApiProvider);
      return await api.getAvatar() ?? const NovaAvatarPrefs();
    });

/// Combined counts for the Home dashboard's "Today's Overview" cards.
///
/// Fetches the three lists in parallel; a failure in any one is surfaced rather
/// than silently zeroed, so the dashboard never claims "0 memories" when the
/// real problem is an expired session.
final homeOverviewProvider = FutureProvider.autoDispose<HomeOverview>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  final results = await Future.wait([
    api.listTasks(),
    api.listMemories(),
    // The whole list, not one page: a count taken from a truncated page would
    // under-report exactly the users who have the most reminders.
    api.listAllReminders(),
  ]);

  final tasks = results[0] as List<NovaTask>;
  final memories = results[1] as List<NovaMemory>;
  final reminders = (results[2] as NovaReminderList).reminders;

  return HomeOverview(
    openTasks: tasks.where((t) => !t.isDone).length,
    memories: memories.length,
    reminders: reminders.where((r) => !r.dismissed).length,
  );
});

class HomeOverview {
  const HomeOverview({
    required this.openTasks,
    required this.memories,
    required this.reminders,
  });

  final int openTasks;
  final int memories;
  final int reminders;
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/// Write operations plus the cache invalidation each one needs, so list screens
/// and the dashboard counts refresh together.
class NovaMutations {
  NovaMutations(this._ref);

  final Ref _ref;

  NovaApi get _api => _ref.read(novaApiProvider);

  Future<void> addTask({
    required String title,
    String? description,
    DateTime? dueAt,
  }) async {
    await _api.createTask(
      title: title,
      description: description,
      dueAt: dueAt,
    );
    _refreshTasks();
  }

  Future<void> toggleTask(NovaTask task) async {
    await _api.completeTask(task.id, done: !task.isDone);
    _refreshTasks();
  }

  Future<void> deleteTask(String id) async {
    await _api.deleteTask(id);
    _refreshTasks();
  }

  void _refreshTasks() {
    _ref.invalidate(tasksProvider);
    _ref.invalidate(taskSummaryProvider);
    _ref.invalidate(homeOverviewProvider);
  }

  Future<void> addMemory({required String content}) async {
    await _api.createMemory(content: content);
    _refreshMemories();
  }

  Future<void> deleteMemory(String id) async {
    await _api.deleteMemory(id);
    _refreshMemories();
  }

  void _refreshMemories() {
    _ref.invalidate(memoriesProvider);
    _ref.invalidate(memorySearchResultsProvider);
    _ref.invalidate(homeOverviewProvider);
  }

  Future<void> addReminder({required String title, DateTime? remindAt}) async {
    await _api.createReminder(title: title, remindAt: remindAt);
    _refreshReminders();
  }

  Future<void> deleteReminder(String id) async {
    await _api.deleteReminder(id);
    _refreshReminders();
  }

  void _refreshReminders() {
    _ref.invalidate(remindersProvider);
    _ref.invalidate(homeOverviewProvider);
    // The alarm lives on the device, not on the server, so the server round trip
    // above does not arm anything. Without this the reminder the user just created
    // had no local alarm until the app was resumed or the auth state changed, and a
    // deleted reminder kept its alarm until the same moment. `sync` reconciles the
    // OS's notifications against the list, so invalidating it is what arms or drops
    // the alarm now.
    _ref.invalidate(reminderSyncProvider);
  }

  Future<NovaConversation> startConversation({String? title}) async {
    final conversation = await _api.createConversation(title: title);
    _ref.invalidate(conversationsProvider);
    return conversation;
  }

  Future<void> deleteConversation(String id) async {
    await _api.deleteConversation(id);
    _ref.invalidate(conversationsProvider);
  }

  Future<NovaSendResult> send(
    String conversationId,
    String content, {
    String? language,
  }) async {
    final result = await _api.sendMessage(
      conversationId,
      content,
      language: language,
    );
    _ref.invalidate(messagesProvider(conversationId));
    _ref.invalidate(conversationsProvider);
    return result;
  }

  Future<void> savePrivacy(NovaPrivacyPrefs prefs) async {
    await _api.updatePrivacy(prefs);
    _ref.invalidate(privacyPrefsProvider);
  }

  Future<void> saveNotificationPrefs(NovaNotificationPrefs prefs) async {
    await _api.updatePreferences(prefs);
    _ref.invalidate(notificationPrefsProvider);
  }

  Future<void> saveProfile({String? name, String? phone, String? timezone}) async {
    await _api.updateProfile(name: name, phone: phone, timezone: timezone);
    _ref.invalidate(profileProvider);
  }

  Future<void> savePersona(NovaPersona persona) async {
    await _api.updatePersona(persona);
    _ref.invalidate(personaProvider);
  }

  Future<void> saveAvatar(NovaAvatarPrefs prefs) async {
    await _api.saveAvatar(prefs);
    _ref.invalidate(avatarPrefsProvider);
  }

  // ── Recordings ────────────────────────────────────────────────────────────

  Future<NovaRecording> startRecording({required String title, String? language}) async {
    final rec = await _api.createRecording(title: title, language: language);
    _ref.invalidate(recordingsProvider);
    _ref.invalidate(homeOverviewProvider);
    return rec;
  }

  Future<void> finishRecording(String id, {required int durationSeconds}) async {
    await _api.updateRecording(
      id,
      durationSeconds: durationSeconds,
      status: 'completed',
    );
    _ref.invalidate(recordingsProvider);
    _ref.invalidate(recordingDetailProvider(id));
  }

  Future<void> deleteRecording(String id) async {
    await _api.deleteRecording(id);
    _ref.invalidate(recordingsProvider);
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  Future<void> decideApproval(String id, {required bool approve}) async {
    await _api.decideApproval(id, approve: approve);
    _ref.invalidate(approvalsProvider);
    _ref.invalidate(activityProvider);
  }

  // ── Consent ───────────────────────────────────────────────────────────────

  Future<void> recordConsent({
    required String purpose,
    required bool granted,
  }) async {
    await _api.recordConsent(purpose: purpose, granted: granted);
    _ref.invalidate(consentProvider);
  }

  Future<void> dismissReminder(String id) async {
    await _api.deleteReminder(id);
    _ref.invalidate(remindersProvider);
    _ref.invalidate(homeOverviewProvider);
  }
}

final novaMutationsProvider = Provider<NovaMutations>(NovaMutations.new);

// ─── Activity centre ──────────────────────────────────────────────────────────

// ─── NOVA's own notifications ─────────────────────────────────────────────────

/// The nudges NOVA produced: reminders coming due, follow-ups, briefings.
///
/// These rows have existed since the table was created, and the app never asked
/// for them — so the only trace of a nudge was the system notification, and
/// dismissing the shade lost it permanently.
final notificationsProvider =
    FutureProvider.autoDispose<List<NovaNotification>>((ref) async {
  final api = ref.watch(novaApiProvider);
  return api.listNotifications();
});

/// What the Home bell should show. A hardcoded `0` sat there while the server
/// held a real unread count nobody read.
final unreadNotificationCountProvider = FutureProvider.autoDispose<int>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.unreadNotificationCount();
});

final activityProvider = FutureProvider.autoDispose<List<NovaActivityItem>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.listActivity();
});

// ─── Recordings ───────────────────────────────────────────────────────────────

final recordingsProvider = FutureProvider.autoDispose<List<NovaRecording>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.listRecordings();
});

final recordingDetailProvider = FutureProvider.autoDispose
    .family<NovaRecordingDetail, String>((ref, id) async {
      final api = ref.watch(novaApiProvider);
      return api.getRecording(id);
    });

// ─── Tools & approvals ────────────────────────────────────────────────────────

final approvalsProvider = FutureProvider.autoDispose<List<NovaToolApproval>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.listApprovals();
});

final toolsProvider = FutureProvider.autoDispose<List<NovaToolDefinition>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.listTools();
});

// ─── Consent ──────────────────────────────────────────────────────────────────

final consentProvider = FutureProvider.autoDispose<List<NovaConsentRecord>>((
  ref,
) async {
  final api = ref.watch(novaApiProvider);
  return api.listConsent();
});

/// The oldest pending approval, used to raise the Tool Confirmation sheet.
final pendingApprovalProvider = Provider.autoDispose<NovaToolApproval?>((
  ref,
) {
  final approvals = ref.watch(approvalsProvider).asData?.value ?? const [];
  // The API returns approvals newest-first; the oldest queued action is the one
  // that has been waiting longest, so prompt for that.
  final pending = approvals.where((a) => a.isPending).toList();
  return pending.isEmpty ? null : pending.last;
});
