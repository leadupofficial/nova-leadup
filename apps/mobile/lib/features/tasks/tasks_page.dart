import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../reminders/reminder_sync.dart';
import 'reminder_composer.dart';

/// Tasks & reminders. Port of `tasks/tasks.html` and `tasks/empty.html`.
///
/// Both lists are real: `/api/v1/tasks` and `/api/v1/reminders` are DB-backed and
/// the create/toggle/delete actions call the API and invalidate the caches, so
/// the Home dashboard counts stay truthful.
class TasksPage extends ConsumerStatefulWidget {
  const TasksPage({super.key});

  @override
  ConsumerState<TasksPage> createState() => _TasksPageState();
}

class _TasksPageState extends ConsumerState<TasksPage> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final tasks = ref.watch(tasksProvider);
    final reminders = ref.watch(remindersProvider);

    return NovaScaffold(
      topBar: Row(
        children: [
          Expanded(
            child: Text('Tasks', style: NovaTheme.heroName(c)),
          ),
          // Entry points to the Activity Centre and the recording flow, which
          // the export groups with tasks/reminders.
          NovaIconButton(
            icon: Icons.history_rounded,
            tooltip: 'Activity centre',
            onTap: () => context.push('/tasks/activity'),
          ),
          const SizedBox(width: NovaSpace.xs),
          NovaIconButton(
            icon: Icons.mic_none_rounded,
            tooltip: 'Record a meeting',
            onTap: () => context.push('/tasks/record'),
          ),
          const SizedBox(width: NovaSpace.xs),
          NovaIconButton(
            icon: Icons.add_rounded,
            tooltip: _tab == 0 ? 'New task' : 'New reminder',
            onTap: () => _tab == 0 ? _newTask() : _newReminder(),
          ),
        ],
      ),
      refresh: () async {
        ref.invalidate(tasksProvider);
        ref.invalidate(remindersProvider);
        // Loading reminders here also has to re-arm the OS alarms, otherwise a
        // reminder changed on another device stays stale on this one.
        unawaited(ref.read(reminderSyncProvider.notifier).sync());
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              NovaChip(
                label: 'Tasks',
                selected: _tab == 0,
                onTap: () => setState(() => _tab = 0),
              ),
              const SizedBox(width: NovaSpace.xs),
              NovaChip(
                label: 'Reminders',
                selected: _tab == 1,
                onTap: () => setState(() => _tab = 1),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.lg),
          if (_tab == 0)
            tasks.when(
              loading: () => const NovaStateView(
                loading: true,
                title: 'Loading tasks',
              ),
              error: (e, _) => _error(
                e,
                () => ref.invalidate(tasksProvider),
                'Could not load tasks',
              ),
              data: (list) => list.isEmpty
                  ? Column(
                      children: [
                        NovaStateView(
                          icon: Icons.check_circle_outline_rounded,
                          title: 'No tasks yet',
                          message:
                              'Ask NOVA to create one, or tap + to add it yourself.',
                          actionLabel: 'New task',
                          onAction: _newTask,
                        ),
                        // `tasks/empty.html` ends with a "Try saying" block.
                        // Each chip is wired to the action it names rather than
                        // being decoration.
                        const SizedBox(height: NovaSpace.lg),
                        _suggestions(),
                      ],
                    )
                  : Column(
                      children: list
                          .map((t) => _TaskTile(task: t))
                          .toList(growable: false),
                    ),
            )
          else
            reminders.when(
              loading: () => const NovaStateView(
                loading: true,
                title: 'Loading reminders',
              ),
              error: (e, _) => _error(
                e,
                () => ref.invalidate(remindersProvider),
                'Could not load reminders',
              ),
              data: (list) => list.isEmpty
                  ? NovaStateView(
                      icon: Icons.alarm_outlined,
                      title: 'No reminders yet',
                      message: 'NOVA will nudge you when it is time.',
                      actionLabel: 'New reminder',
                      onAction: _newReminder,
                    )
                  : Column(
                      children: list
                          .map((r) => _ReminderTile(reminder: r))
                          .toList(growable: false),
                    ),
            ),
        ],
      ),
    );
  }

  Widget _error(Object e, VoidCallback retry, String title) => NovaStateView(
    icon: Icons.cloud_off_rounded,
    tone: NovaStateTone.error,
    title: title,
    message: e.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), ''),
    actionLabel: 'Retry',
    onAction: retry,
  );

  Future<void> _newTask({String? initial}) async {
    final title = await _prompt('New task', 'What needs doing?', initial: initial);
    if (title == null || title.isEmpty) return;
    await _run(() => ref.read(novaMutationsProvider).addTask(title: title));
  }

  /// The export's `.suggestions` block: an overline and a row of `.chip`s.
  ///
  /// Tapping a chip performs the action it quotes, so none of them is inert:
  /// the task chip opens the composer pre-filled, the reminder chip opens the
  /// real reminder composer, and the recording chip opens the recorder.
  Widget _suggestions() {
    final c = context.nova;
    return Column(
      children: [
        Text('Try saying', style: NovaTheme.msgLabel(c)),
        const SizedBox(height: NovaSpace.sm),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: NovaSpace.xs,
          runSpacing: NovaSpace.xs,
          children: [
            _suggestionChip(
              '"Add task: call Kumar Friday"',
              () => _newTask(initial: 'Call Kumar Friday'),
            ),
            _suggestionChip('"Remind me tomorrow at 10"', _newReminder),
            _suggestionChip(
              '"Record this meeting"',
              () => context.push('/tasks/record'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _suggestionChip(String label, VoidCallback onTap) {
    final c = context.nova;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: c.border),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontFamily: NovaFonts.body,
            fontSize: NovaType.caption,
            fontWeight: NovaType.wMedium,
            color: c.fg,
          ),
        ),
      ),
    );
  }

  Future<void> _newReminder() async {
    // The designed composer collects a date, time and notes; the previous bare
    // prompt could only capture a title.
    final created = await ReminderComposer.show(context);
    if (created == true && mounted) {
      ref.invalidate(remindersProvider);
      ref.invalidate(homeOverviewProvider);
      unawaited(ref.read(reminderSyncProvider.notifier).sync());
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
      if (!mounted) return;
      ref.invalidate(tasksProvider);
      ref.invalidate(remindersProvider);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            e.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), ''),
          ),
        ),
      );
    }
  }

  Future<String?> _prompt(String title, String hint, {String? initial}) {
    final controller = TextEditingController(text: initial);
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
          left: NovaSpace.gutter,
          right: NovaSpace.gutter,
          top: NovaSpace.lg,
          bottom: MediaQuery.viewInsetsOf(sheetContext).bottom + NovaSpace.lg,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: NovaTheme.sectionHeading(context.nova)),
            const SizedBox(height: NovaSpace.md),
            NovaTextField(
              controller: controller,
              hint: hint,
              autofocus: true,
              onSubmitted: (v) => Navigator.pop(sheetContext, v.trim()),
            ),
            const SizedBox(height: NovaSpace.md),
            NovaPrimaryButton(
              label: 'Save',
              onPressed: () =>
                  Navigator.pop(sheetContext, controller.text.trim()),
            ),
          ],
        ),
      ),
    );
  }
}

class _TaskTile extends ConsumerWidget {
  const _TaskTile({required this.task});

  final NovaTask task;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final mutations = ref.read(novaMutationsProvider);

    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.xs),
      child: NovaCard(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            IconButton(
              icon: Icon(
                task.isDone
                    ? Icons.check_circle_rounded
                    : Icons.radio_button_unchecked_rounded,
                color: task.isDone ? c.success : c.muted,
              ),
              tooltip: task.isDone ? 'Mark as open' : 'Mark as done',
              onPressed: () => mutations.toggleTask(task),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    task.title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      decoration: task.isDone
                          ? TextDecoration.lineThrough
                          : null,
                      color: task.isDone ? c.muted : c.fg,
                    ),
                  ),
                  if (task.dueAt != null || task.isOverdue) ...[
                    const SizedBox(height: 2),
                    Text(
                      task.isOverdue
                          ? 'Overdue · ${_fmt(task.dueAt!)}'
                          : 'Due ${_fmt(task.dueAt!)}',
                      style: NovaTheme.msgLabel(c).copyWith(
                        color: task.isOverdue ? c.danger : c.muted,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              icon: Icon(Icons.delete_outline_rounded, color: c.muted, size: 20),
              tooltip: 'Delete',
              onPressed: () => mutations.deleteTask(task.id),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReminderTile extends ConsumerWidget {
  const _ReminderTile({required this.reminder});

  final NovaReminder reminder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final mutations = ref.read(novaMutationsProvider);

    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.xs),
      child: NovaCard(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        child: Row(
          children: [
            Icon(
              Icons.alarm_rounded,
              color: reminder.dismissed ? c.muted : c.accent,
              size: 20,
            ),
            const SizedBox(width: NovaSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    reminder.title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (reminder.remindAt != null) ...[
                    const SizedBox(height: 2),
                    Text(_fmt(reminder.remindAt!), style: NovaTheme.msgLabel(c)),
                  ],
                ],
              ),
            ),
            IconButton(
              icon: Icon(Icons.delete_outline_rounded, color: c.muted, size: 20),
              tooltip: 'Delete',
              onPressed: () {
                // This screen sits outside the reminders page, so the delete has
                // to re-run the reconciliation itself or the OS would keep an
                // alarm for a reminder that no longer exists.
                unawaited(
                  mutations.deleteReminder(reminder.id).then((_) {
                    if (context.mounted) {
                      unawaited(ref.read(reminderSyncProvider.notifier).sync());
                    }
                  }),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

String _fmt(DateTime d) {
  final now = DateTime.now();
  final time =
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  if (d.year == now.year && d.month == now.month && d.day == now.day) {
    return 'Today $time';
  }
  final tomorrow = now.add(const Duration(days: 1));
  if (d.year == tomorrow.year &&
      d.month == tomorrow.month &&
      d.day == tomorrow.day) {
    return 'Tomorrow $time';
  }
  return '${d.day}/${d.month}/${d.year} $time';
}
