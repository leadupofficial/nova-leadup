import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart' show NovaApiException, novaApiProvider;
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../tasks/reminder_composer.dart';
import 'reminder_sync.dart';

/// Reminders — port of `reminders/reminders.html`: sticky top bar, "Up next" hero
/// card, `reminder-card` rows, plus the section and empty-state vocabulary shared
/// with `tasks/tasks.html` and `tasks/empty.html`.
///
/// Every read and write goes through the typed client: [remindersProvider] reads
/// `GET /api/v1/reminders`, [NovaApi.updateReminder] carries the enable/disable
/// toggle, Snooze and Edit (`PATCH /api/v1/reminders/:id`), and
/// `novaMutationsProvider` carries create and delete. Create opens the existing
/// [ReminderComposer] rather than a second copy of it, and errors are surfaced
/// instead of being swallowed into an empty list.
///
/// Two deliberate deviations from the export, both to avoid inventing data:
///
///  * The card meta line is the time only. The export also shows a delivery
///    channel ("🔔 Push + sound"), but the server's `notificationChannel` is not
///    on [NovaReminder], so claiming one would be a guess.
///  * There is no "complete". The `reminders` table has no completed column, so
///    the design's Dismiss maps to `dismissed` and no completed state is faked.
class RemindersPage extends ConsumerWidget {
  const RemindersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    return NovaScaffold(
      padding: const EdgeInsets.only(left: NovaSpace.gutter, right: NovaSpace.gutter, top: NovaSpace.xs),
      topBar: Row(children: [
        if (Navigator.of(context).canPop())
          NovaIconButton(icon: Icons.chevron_left_rounded, size: 36, radius: NovaRadius.control, tooltip: 'Back', onTap: () => Navigator.of(context).pop())
        else
          const SizedBox(width: NovaMotion.minTouchTarget),
        // The export's `h1` is display/700 at 19px.
        Expanded(child: Center(child: Text('Reminders', style: NovaTheme.sectionHeading(c).copyWith(fontSize: 19)))),
        _addButton(context, () => _create(context, ref)),
      ]),
      refresh: () async => _refresh(ref),
      child: ref.watch(remindersProvider).when(
        loading: () => const NovaStateView(loading: true, title: 'Loading reminders'),
        error: (e, _) => NovaStateView(
          icon: Icons.cloud_off_rounded, tone: NovaStateTone.error, title: 'Could not load reminders',
          message: _message(e), actionLabel: 'Retry', onAction: () => ref.invalidate(remindersProvider)),
        data: (list) => list.isEmpty ? _emptyState(context, () => _create(context, ref)) : _Groups(rows: list),
      ),
    );
  }

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    // The designed composer collects title, date and time and writes through
    // `novaMutationsProvider.addReminder`. Reused, never duplicated.
    final created = await ReminderComposer.show(context);
    if (created == true) _refresh(ref);
  }
}

// ─── Grouping ───────────────────────────────────────────────────────────────

class _Groups extends StatelessWidget {
  const _Groups({required this.rows});

  final List<NovaReminder> rows;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final active = rows.where((r) => !r.dismissed).toList();
    final upcoming = active.where((r) => r.remindAt == null || !r.remindAt!.isBefore(now)).toList()
      ..sort((a, b) => (a.remindAt ?? now).compareTo(b.remindAt ?? now));
    final past = active.where((r) => r.remindAt != null && r.remindAt!.isBefore(now)).toList()
      ..sort((a, b) => b.remindAt!.compareTo(a.remindAt!));
    final dismissed = rows.where((r) => r.dismissed).toList();

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      // The export's `.composer` block is the "Up next" hero card.
      if (upcoming.isNotEmpty) ...[
        _ReminderCard(reminder: upcoming.first, hero: true),
        const SizedBox(height: NovaSpace.md),
      ],
      if (upcoming.length > 1) ...[
        _sectionTitle(context, 'Upcoming'),
        ...upcoming.skip(1).map(_card),
      ],
      if (past.isNotEmpty) ...[_sectionTitle(context, 'Past'), ...past.map(_card)],
      if (dismissed.isNotEmpty) ...[
        _sectionTitle(context, 'Dismissed'),
        ...dismissed.map(_card),
      ],
    ]);
  }

  Widget _card(NovaReminder row) => _ReminderCard(reminder: row);
}

/// `.section-title` — display/700 at 14px, uppercase, tracking .08em.
Widget _sectionTitle(BuildContext context, String title) => Padding(
  padding: const EdgeInsets.only(top: NovaSpace.lg, bottom: NovaSpace.sm),
  child: Text(title.toUpperCase(), style: TextStyle(
    fontFamily: NovaFonts.display, fontSize: NovaType.bodySmall, fontWeight: NovaType.wBold,
    color: context.nova.muted, height: 1.2, letterSpacing: NovaType.bodySmall * 0.08,
    fontVariations: [FontVariation('wght', NovaTheme.wght(NovaType.wBold))],
  )),
);

// ─── Cards ──────────────────────────────────────────────────────────────────

/// `.composer` (hero) and `.reminder-card` (list row).
class _ReminderCard extends ConsumerWidget {
  const _ReminderCard({required this.reminder, this.hero = false});

  final NovaReminder reminder;
  final bool hero;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final title = Text(reminder.title, style: TextStyle(
      fontFamily: NovaFonts.display, fontSize: hero ? 16 : NovaType.body,
      fontWeight: NovaType.wSemiBold, color: reminder.dismissed ? c.muted : c.fg, height: 1.35,
      fontVariations: [FontVariation('wght', NovaTheme.wght(NovaType.wSemiBold))],
    ));
    final meta = Text(
      '📅 ${_whenLabel(reminder.remindAt)}',
      style: TextStyle(
        fontFamily: NovaFonts.body, fontSize: hero ? 12 : 13, color: c.muted, height: 1.4,
        fontVariations: [FontVariation('wght', NovaTheme.wght(NovaType.wRegular))],
      ),
    );

    return Padding(
      padding: EdgeInsets.only(bottom: hero ? 0 : 10),
      child: NovaCard(
        radius: hero ? NovaRadius.bubble : NovaRadius.card,
        padding: EdgeInsets.all(hero ? NovaSpace.md : 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (hero) ...[
            Text('Up next', style: NovaTheme.overline(c)),
            const SizedBox(height: 6),
            title,
            const SizedBox(height: 10),
            meta,
          ] else
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              // `.reminder-icon` — 40px cyan-tinted square.
              Container(
                width: 40, height: 40, alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: c.cyan.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(NovaRadius.control),
                  border: Border.all(color: c.cyan.withValues(alpha: 0.2)),
                ),
                child: const Text('📅', style: TextStyle(fontSize: 20)),
              ),
              const SizedBox(width: NovaSpace.sm),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                title,
                const SizedBox(height: NovaSpace.xxs),
                meta,
              ])),
            ]),
          const SizedBox(height: NovaSpace.sm),
          Wrap(spacing: 6, runSpacing: 6, children: _actions(context, ref, reminder)),
        ]),
      ),
    );
  }
}

List<Widget> _actions(BuildContext context, WidgetRef ref, NovaReminder r) => [
  _miniBtn(context, r.dismissed ? 'Restore' : 'Dismiss',
    () => _run(context, ref, () => _update(ref, r.id, dismissed: !r.dismissed))),
  _miniBtn(context, 'Snooze', () => _snooze(context, ref, r)),
  _miniBtn(context, 'Edit', () => _rename(context, ref, r)),
  _miniBtn(context, 'Delete',
    () => _run(context, ref, () => ref.read(novaMutationsProvider).deleteReminder(r.id)),
    tone: context.nova.danger),
];

/// `.mini-btn` — 5/12 padding, 8px radius, raised surface, 11px/500.
///
/// `Ink` (not `Container`) carries the fill so the splash paints above it.
Widget _miniBtn(BuildContext context, String label, VoidCallback onTap, {Color? tone}) {
  final c = context.nova;
  return Semantics(button: true, label: label, child: Material(
    color: Colors.transparent,
    child: InkWell(
      onTap: onTap,
      borderRadius: NovaRadius.rSm,
      child: Ink(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        decoration: BoxDecoration(
          color: c.surfaceRaised,
          borderRadius: NovaRadius.rSm,
          border: Border.all(color: c.border),
        ),
        child: Text(label, style: TextStyle(
          fontFamily: NovaFonts.body, fontSize: NovaType.label, fontWeight: NovaType.wMedium,
          color: tone ?? c.muted, height: 1.4,
          fontVariations: [FontVariation('wght', NovaTheme.wght(NovaType.wMedium))],
        )),
      ),
    ),
  ));
}

/// `.add-btn` — 36px accent-gradient square with a white plus, on a 44px target.
Widget _addButton(BuildContext context, VoidCallback onTap) {
  final c = context.nova;
  return Semantics(button: true, label: 'New reminder', child: Material(
    color: Colors.transparent,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(NovaRadius.control),
      child: SizedBox(
        width: NovaMotion.minTouchTarget, height: NovaMotion.minTouchTarget,
        child: Center(child: Container(
          width: 36, height: 36,
          decoration: BoxDecoration(
            gradient: c.accentGradient,
            borderRadius: BorderRadius.circular(NovaRadius.control),
          ),
          child: Icon(Icons.add_rounded, size: 20, color: c.onAccent),
        )),
      ),
    ),
  ));
}

/// `tasks/empty.html` vocabulary: icon, title, description, gradient CTA and the
/// "Try saying" suggestion chips.
Widget _emptyState(BuildContext context, VoidCallback onAdd) => Column(children: [
  NovaStateView(
    icon: Icons.alarm_add_rounded, tone: NovaStateTone.accent, title: 'No reminders yet',
    message: 'Tell NOVA when to nudge you — during a conversation, or add one yourself with the + button.',
    actionLabel: 'New reminder', onAction: onAdd),
  Text('TRY SAYING', style: NovaTheme.overline(context.nova)),
  const SizedBox(height: NovaSpace.sm),
  const Wrap(
    spacing: NovaSpace.xs, runSpacing: NovaSpace.xs, alignment: WrapAlignment.center,
    children: [
      NovaChip(label: '"Remind me tomorrow at 10"'),
      NovaChip(label: '"Remind me to call Kumar Friday"'),
    ],
  ),
]);

// ─── Snooze / edit ──────────────────────────────────────────────────────────

/// Snooze presets, each a real `PATCH /reminders/:id {triggerAt}`.
Future<void> _snooze(BuildContext context, WidgetRef ref, NovaReminder r) async {
  final now = DateTime.now();
  final options = <String, DateTime>{
    'In 10 minutes': now.add(const Duration(minutes: 10)),
    'In 1 hour': now.add(const Duration(hours: 1)),
    'Tonight 7 PM': DateTime(now.year, now.month, now.day, 19),
    'Tomorrow 9 AM': DateTime(now.year, now.month, now.day + 1, 9),
  };
  final picked = await showModalBottomSheet<DateTime>(
    context: context,
    backgroundColor: Theme.of(context).bottomSheetTheme.backgroundColor,
    builder: (sheet) => Padding(
      padding: const EdgeInsets.all(NovaSpace.gutter),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Snooze', style: NovaTheme.sectionHeading(sheet.nova)),
        const SizedBox(height: NovaSpace.md),
        Wrap(spacing: NovaSpace.xs, runSpacing: NovaSpace.xs, children: [
          for (final option in options.entries)
            NovaChip(
              label: option.key, icon: Icons.snooze_rounded,
              onTap: () => Navigator.pop(sheet, option.value)),
        ]),
        const SizedBox(height: NovaSpace.xs),
      ]),
    ),
  );
  if (picked == null || !context.mounted) return;
  await _run(context, ref, () => _update(ref, r.id, remindAt: picked));
}

/// The design's Edit: retitles through the same PATCH and sends no `remindAt`, so
/// the schedule is left exactly as it was.
Future<void> _rename(BuildContext context, WidgetRef ref, NovaReminder r) async {
  // Short-lived controller, matching the prompt sheet in `tasks_page`; errors are
  // reported by [_run] rather than inline, so no in-flight state is needed here.
  final controller = TextEditingController(text: r.title);
  final title = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Theme.of(context).bottomSheetTheme.backgroundColor,
    builder: (sheet) => Padding(
      padding: EdgeInsets.only(
        left: NovaSpace.gutter, right: NovaSpace.gutter, top: NovaSpace.lg,
        bottom: MediaQuery.viewInsetsOf(sheet).bottom + NovaSpace.lg,
      ),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Edit reminder', style: NovaTheme.sectionHeading(sheet.nova)),
        const SizedBox(height: NovaSpace.md),
        NovaTextField(
          controller: controller, label: 'Remind me to',
          hint: 'e.g. Call Kumar about the CRM quote', autofocus: true,
          onSubmitted: (value) => Navigator.pop(sheet, value.trim())),
        const SizedBox(height: NovaSpace.lg),
        NovaPrimaryButton(
          label: 'Save', icon: Icons.check_rounded,
          onPressed: () => Navigator.pop(sheet, controller.text.trim())),
      ]),
    ),
  );
  if (title == null || title.isEmpty || !context.mounted) return;
  await _run(context, ref, () => _update(ref, r.id, title: title));
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/// The toggle / Snooze / Edit write, through the typed client.
Future<void> _update(
  WidgetRef ref,
  String id, {
  String? title,
  DateTime? remindAt,
  bool? dismissed,
}) async {
  await ref.read(novaApiProvider).updateReminder(
    id,
    title: title,
    remindAt: remindAt,
    dismissed: dismissed,
  );
  _refresh(ref);
}

Future<void> _run(BuildContext context, WidgetRef ref, Future<void> Function() action) async {
  try {
    await action();
  } catch (e) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_message(e))));
  }
}

/// Keeps this screen, the Tasks tab and the Home overview counts in step, and
/// brings the OS's scheduled notifications back in line with the server's list.
/// Every create, edit, snooze, dismiss and delete ends up here, which is why the
/// reconciliation lives on this path rather than only at reminder creation.
void _refresh(WidgetRef ref) {
  ref.invalidate(remindersProvider);
  ref.invalidate(homeOverviewProvider);
  unawaited(ref.read(reminderSyncProvider.notifier).sync());
}

String _message(Object error) => error is NovaApiException
    ? error.message
    : error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// The export's copy: "Today · 2:00 PM", "Tomorrow · 9:30 AM", "Fri, Sep 12 · 11:00 AM".
String _whenLabel(DateTime? at) {
  if (at == null) return 'No time set';
  final now = DateTime.now();
  final h12 = at.hour % 12 == 0 ? 12 : at.hour % 12;
  final time = '$h12:${at.minute.toString().padLeft(2, '0')} ${at.hour < 12 ? 'AM' : 'PM'}';
  bool sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
  if (sameDay(at, now)) return 'Today · $time';
  if (sameDay(at, now.add(const Duration(days: 1)))) return 'Tomorrow · $time';
  if (sameDay(at, now.subtract(const Duration(days: 1)))) return 'Yesterday · $time';
  return '${_weekdays[at.weekday - 1]}, ${_months[at.month - 1]} ${at.day} · $time';
}
