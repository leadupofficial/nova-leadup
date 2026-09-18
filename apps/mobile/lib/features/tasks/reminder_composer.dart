import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Reminder Composer — port of `reminders/reminders.html` (blueprint §5.9).
///
/// Replaces the bare text prompt the Tasks screen previously used, which could
/// only capture a title. The design's rows carry a date/time and a delivery
/// channel, and `POST /api/v1/reminders` accepts `remindAt`, so the composer
/// collects a real schedule rather than defaulting everything to "now".
///
/// Returns true when a reminder was created and persisted.
class ReminderComposer extends ConsumerStatefulWidget {
  const ReminderComposer({super.key});

  static Future<bool?> show(BuildContext context) {
    return showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).bottomSheetTheme.backgroundColor,
      builder: (_) => const ReminderComposer(),
    );
  }

  @override
  ConsumerState<ReminderComposer> createState() => _ReminderComposerState();
}

class _ReminderComposerState extends ConsumerState<ReminderComposer> {
  final _title = TextEditingController();

  /// The design offers Today / Tomorrow / a picked date, with a time.
  DateTime _date = DateTime.now();
  TimeOfDay _time = const TimeOfDay(hour: 9, minute: 0);
  bool _saving = false;
  String? _error;

  DateTime get _when => DateTime(
    _date.year,
    _date.month,
    _date.day,
    _time.hour,
    _time.minute,
  );

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final now = DateTime.now();
    final tomorrow = now.add(const Duration(days: 1));

    bool sameDay(DateTime a, DateTime b) =>
        a.year == b.year && a.month == b.month && a.day == b.day;

    return Padding(
      padding: EdgeInsets.only(
        left: NovaSpace.gutter,
        right: NovaSpace.gutter,
        top: NovaSpace.lg,
        bottom: MediaQuery.viewInsetsOf(context).bottom + NovaSpace.lg,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('New reminder', style: NovaTheme.sectionHeading(c)),
            const SizedBox(height: NovaSpace.md),

            NovaTextField(
              controller: _title,
              label: 'Remind me to',
              hint: 'e.g. Call Kumar about the CRM quote',
              autofocus: true,
            ),
            const SizedBox(height: NovaSpace.md),

            Text('When', style: NovaTheme.overline(c)),
            const SizedBox(height: NovaSpace.xs),
            Wrap(
              spacing: NovaSpace.xs,
              children: [
                NovaChip(
                  label: 'Today',
                  selected: sameDay(_date, now),
                  onTap: () => setState(() => _date = now),
                ),
                NovaChip(
                  label: 'Tomorrow',
                  selected: sameDay(_date, tomorrow),
                  onTap: () => setState(() => _date = tomorrow),
                ),
                NovaChip(
                  label: sameDay(_date, now) || sameDay(_date, tomorrow)
                      ? 'Pick a date'
                      : '${_date.day}/${_date.month}/${_date.year}',
                  icon: Icons.calendar_today_rounded,
                  selected: !sameDay(_date, now) && !sameDay(_date, tomorrow),
                  onTap: _pickDate,
                ),
                NovaChip(
                  label: _time.format(context),
                  icon: Icons.schedule_rounded,
                  onTap: _pickTime,
                ),
              ],
            ),
            const SizedBox(height: NovaSpace.md),

            Row(
              children: [
                Icon(Icons.notifications_none_rounded, size: 16, color: c.muted),
                const SizedBox(width: 6),
                Text(
                  'Push notification at ${_time.format(context)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),

            if (_error != null) ...[
              const SizedBox(height: NovaSpace.sm),
              Text(
                _error!,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.danger),
              ),
            ],

            const SizedBox(height: NovaSpace.lg),
            NovaPrimaryButton(
              label: 'Set reminder',
              icon: Icons.alarm_add_rounded,
              busy: _saving,
              onPressed: _saving ? null : _save,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 365 * 2)),
    );
    if (picked != null && mounted) setState(() => _date = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: _time);
    if (picked != null && mounted) setState(() => _time = picked);
  }

  Future<void> _save() async {
    final title = _title.text.trim();
    if (title.isEmpty) {
      setState(() => _error = 'Give the reminder a title.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref
          .read(novaMutationsProvider)
          .addReminder(title: title, remindAt: _when);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e
            .toString()
            .replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');
      });
    }
  }
}
