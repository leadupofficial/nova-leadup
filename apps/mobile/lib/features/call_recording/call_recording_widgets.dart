import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';
import 'call_recording_state.dart';

/// The parts of the call-recording screen that are not cards: the transparent
/// tile surface, the disclosure the user must read, and the error banner.
///
/// The cards themselves are in `call_recording_cards.dart`.

class CallRecordingTileSurface extends StatelessWidget {
  const CallRecordingTileSurface({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) =>
      Material(color: Colors.transparent, child: child);
}

/// The one thing the user must read before anything is granted or read.
///
/// Requirement 6c is "call screening and communication assistance". The naive
/// reading of that — screen calls, transcribe unknown callers, summarise intent
/// before answering — cannot be built (see the page's copy), so this panel says
/// plainly what NOVA does instead, and what it never does.

class CallRecordingDisclosureCard extends StatelessWidget {
  const CallRecordingDisclosureCard({
    super.key,
    required this.state,
    required this.onAcknowledged,
  });

  final CallRecordingState state;
  final ValueChanged<bool> onAcknowledged;

  /// The four facts the user is asked to acknowledge, in order.
  static const List<String> facts = <String>[
    'The recordings are ones your own phone dialer made, and they are already '
        'on this device. NOVA does not record calls.',
    'NOVA reads audio files you already own, in a folder you choose, and only '
        'the ones you tick. It does not listen to a call, and it cannot: Android '
        'does not let an app hear call audio.',
    'A recording of a call contains the other party\'s voice. You are '
        'responsible for having the right to have it transcribed and '
        'summarised. In some places both sides must agree.',
    'You choose the folder, and you can revoke it at any time. NOVA keeps only '
        'the folder you granted and which files it has already imported — never '
        'the audio, the number or the transcript.',
  ];

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.gavel_outlined, size: 18, color: c.muted),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'Before you choose a folder',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'Call recording summaries',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: NovaSpace.xxs),
          Text(
            'This reads recordings your dialer already saved. It is post-hoc: '
            'NOVA summarises a recording after the call, from a file you point '
            'it at. It does not screen calls, does not listen while you are on a '
            'call, and cannot tell you who is calling before you answer.',
            style: Theme.of(context).textTheme.bodySmall!.copyWith(color: c.fg),
          ),
          const SizedBox(height: NovaSpace.sm),
          for (final fact in facts) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Icon(
                    Icons.check_circle_outline_rounded,
                    size: 14,
                    color: c.accent,
                  ),
                ),
                const SizedBox(width: NovaSpace.xs),
                Expanded(
                  child: Text(
                    fact,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall!.copyWith(color: c.muted),
                  ),
                ),
              ],
            ),
            const SizedBox(height: NovaSpace.xs),
          ],
          const SizedBox(height: NovaSpace.xxs),
          CallRecordingTileSurface(
            child: CheckboxListTile(
              value: state.consentAcknowledged,
              onChanged: (v) => onAcknowledged(v ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              title: Text(
                'I understand: these are my own recordings, they contain the '
                'other party, and I have the right to process them.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ),
          Text(
            'Asked again every time this screen opens; the tick is never saved.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall!.copyWith(color: c.muted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

/// What this feature is *not*. Rendered prominently, because the brief asked for
/// call screening and this is honestly not that.

class CallRecordingErrorBanner extends StatelessWidget {
  const CallRecordingErrorBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(NovaSpace.sm),
      decoration: BoxDecoration(
        color: c.danger.withValues(alpha: 0.12),
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.danger.withValues(alpha: 0.4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline_rounded, size: 16, color: c.danger),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Text(
              message,
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.fg),
            ),
          ),
        ],
      ),
    );
  }
}
