import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Tool Confirmation — port of `chat/tool-confirm.html` (blueprint §5.7).
///
/// The blueprint is explicit that this must be shown *before* any side-effecting
/// action: "Tool Confirmation Sheet (shown before every side-effecting action)".
/// It is driven by a real `tool_approvals` row, so the action the user confirms
/// is the action the server has queued — the sheet cannot invent one.
///
/// The export counts down ("Auto-expires in 2:00") because an approval row
/// carries `expires_at`; the sheet surfaces that deadline, and when it lapses the
/// confirm button disables rather than sending a stale action.
class ToolConfirmSheet extends ConsumerStatefulWidget {
  const ToolConfirmSheet({super.key, required this.approval});

  final NovaToolApproval approval;

  /// Raises the sheet for [approval]. Returns true when the user approved.
  static Future<bool?> show(BuildContext context, NovaToolApproval approval) {
    return showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: Theme.of(context).bottomSheetTheme.backgroundColor,
      builder: (_) => ToolConfirmSheet(approval: approval),
    );
  }

  @override
  ConsumerState<ToolConfirmSheet> createState() => _ToolConfirmSheetState();
}

class _ToolConfirmSheetState extends ConsumerState<ToolConfirmSheet> {
  Timer? _ticker;
  Duration? _remaining;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _syncCountdown();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(_syncCountdown);
    });
  }

  void _syncCountdown() {
    final expires = widget.approval.expiresAt;
    if (expires == null) {
      _remaining = null;
      return;
    }
    final left = expires.difference(DateTime.now());
    _remaining = left.isNegative ? Duration.zero : left;
  }

  bool get _expired => _remaining != null && _remaining == Duration.zero;

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final a = widget.approval;
    final input = a.toolInput ?? const {};

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
            Row(
              children: [
                Icon(Icons.shield_outlined, size: 18, color: c.warning),
                const SizedBox(width: NovaSpace.xs),
                Text('Confirm action', style: NovaTheme.sectionHeading(c)),
                const Spacer(),
                if (_remaining != null)
                  Text(
                    _expired ? 'Expired' : 'Auto-expires in ${_clock(_remaining!)}',
                    style: NovaTheme.msgLabel(c).copyWith(
                      color: _expired ? c.danger : c.muted,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: NovaSpace.md),

            Text(
              a.toolName,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: NovaSpace.xs),
            Text(
              a.permissionLevel == null
                  ? 'This action needs your confirmation before it runs.'
                  : 'Permission level ${a.permissionLevel} — this action needs '
                        'your confirmation before it runs.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: NovaSpace.lg),

            // Tool input, rendered as labelled rows. Values are shown verbatim:
            // the point of this sheet is that the user sees exactly what will be
            // sent, so summarising or truncating it would defeat it.
            NovaCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final entry in input.entries)
                    Padding(
                      padding: const EdgeInsets.only(bottom: NovaSpace.xs),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _prettify(entry.key).toUpperCase(),
                            style: NovaTheme.overline(c),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            _stringify(entry.value),
                            style: NovaTheme.bubble(c),
                          ),
                        ],
                      ),
                    ),
                  if (input.isEmpty)
                    Text(
                      'No parameters were supplied with this action.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ),

            const SizedBox(height: NovaSpace.md),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.warning_amber_rounded, size: 16, color: c.danger),
                const SizedBox(width: NovaSpace.xs),
                Expanded(
                  child: Text(
                    'External actions cannot be recalled. Review carefully '
                    'before confirming.',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall!.copyWith(color: c.danger),
                  ),
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
              label: _expired ? 'Approval expired' : 'Approve and send',
              icon: Icons.check_rounded,
              busy: _busy,
              onPressed: (_busy || _expired) ? null : () => _decide(true),
            ),
            const SizedBox(height: NovaSpace.xs),
            SizedBox(
              width: double.infinity,
              child: NovaSecondaryButton(
                label: 'Deny',
                expand: true,
                tone: c.danger,
                onPressed: _busy ? null : () => _decide(false),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _decide(bool approve) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(novaMutationsProvider)
          .decideApproval(widget.approval.id, approve: approve);
      if (mounted) Navigator.pop(context, approve);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e
            .toString()
            .replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');
      });
    }
  }
}

String _clock(Duration d) {
  final m = d.inMinutes.toString().padLeft(2, '0');
  final s = (d.inSeconds % 60).toString().padLeft(2, '0');
  return '$m:$s';
}

String _prettify(String key) => key
    .replaceAllMapped(RegExp(r'([a-z])([A-Z])'), (m) => '${m[1]} ${m[2]}')
    .replaceAll('_', ' ');

String _stringify(Object? v) {
  if (v == null) return '—';
  if (v is String) return v;
  if (v is Map || v is List) return v.toString();
  return v.toString();
}
