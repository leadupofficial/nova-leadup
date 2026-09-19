import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';
import 'call_recording_state.dart';
import 'call_recording_widgets.dart';

/// The screen's cards: the folder grant, the scan results, and the per-file
/// outcomes.
///
/// Split from `call_recording_widgets.dart` so each file stays readable; the
/// shared [CallRecordingTileSurface] lives beside the disclosure it is used in.

class CallRecordingLimitsCard extends StatelessWidget {
  const CallRecordingLimitsCard({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.info_outline_rounded, size: 18, color: c.warning),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'What this is not',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          for (final line in const <String>[
            'Not call screening. There is no live caller identification, and no '
                'summary waiting for you before you pick up.',
            'Not call recording. NOVA never records a call, and cannot hear one: '
                'since Android 10 the call audio source is closed to apps like '
                'this one.',
            'Not the call log. NOVA does not ask for READ_CALL_LOG, so it cannot '
                'see who called you or when.',
            'Not automatic. Nothing is uploaded until you tick a file and press '
                'import.',
          ]) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Icon(Icons.remove_rounded, size: 14, color: c.muted),
                ),
                const SizedBox(width: NovaSpace.xs),
                Expanded(
                  child: Text(
                    line,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall!.copyWith(color: c.muted),
                  ),
                ),
              ],
            ),
            const SizedBox(height: NovaSpace.xs),
          ],
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(NovaSpace.sm),
            decoration: BoxDecoration(
              color: c.surfaceRaised,
              borderRadius: NovaRadius.rControl,
              border: Border.all(color: c.border),
            ),
            child: Text(
              'Where a real call screen exists (your dialer\'s own, or the '
              'carrier\'s), use that. NOVA is the step after the call.',
              style: Theme.of(context).textTheme.bodySmall!.copyWith(color: c.fg),
            ),
          ),
        ],
      ),
    );
  }
}

/// The folder grant: its state, the picker, and turning reading on and off.

class CallRecordingFolderCard extends StatelessWidget {
  const CallRecordingFolderCard({
    super.key,
    required this.state,
    required this.onPick,
    required this.onToggleEnabled,
    required this.onForget,
  });

  final CallRecordingState state;
  final VoidCallback onPick;
  final ValueChanged<bool> onToggleEnabled;
  final VoidCallback onForget;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final folder = state.settings.folder;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.folder_outlined,
                size: 18,
                color: state.hasFolder ? c.accent : c.muted,
              ),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'Folder',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              NovaStatusPill(
                label: state.isEnabled ? 'ON' : 'OFF',
                tone: state.isEnabled ? c.success : c.muted,
                animate: false,
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            folder == null
                ? 'No folder has been chosen, so NOVA reads nothing at all. Pick '
                    'the folder your dialer saves call recordings to.'
                : '${folder.displayName}\n${folder.treeUri}',
            style: Theme.of(context).textTheme.bodySmall!.copyWith(
              color: folder == null ? c.muted : c.fg,
            ),
          ),
          if (!state.isSupported) ...[
            const SizedBox(height: NovaSpace.sm),
            Text(
              'Reading a call-recording folder is implemented for Android only, '
              'so there is nothing to grant here.',
              style: Theme.of(context).textTheme.bodySmall!.copyWith(
                color: c.warning,
              ),
            ),
          ],
          const SizedBox(height: NovaSpace.sm),
          NovaSecondaryButton(
            label: folder == null ? 'Choose folder' : 'Choose a different folder',
            icon: Icons.folder_open_rounded,
            onPressed: state.busy || !state.isSupported ? null : onPick,
          ),
          if (folder != null) ...[
            const SizedBox(height: NovaSpace.sm),
            CallRecordingTileSurface(
              child: SwitchListTile(
                value: state.isEnabled,
                onChanged: state.busy ? null : onToggleEnabled,
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: Text(
                  'Read this folder',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                subtitle: Text(
                  state.isEnabled
                      ? 'On. NOVA looks at this folder when you ask it to.'
                      : 'Off. Nothing in this folder is listed or uploaded.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ),
            const SizedBox(height: NovaSpace.xs),
            NovaSecondaryButton(
              label: 'Forget this folder',
              icon: Icons.link_off_rounded,
              onPressed: state.busy ? null : onForget,
            ),
            const SizedBox(height: NovaSpace.xxs),
            Text(
              'Forgetting drops NOVA\'s stored folder. Android\'s own grant is '
              'yours to revoke in Settings → Apps → NOVA → Storage.',
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.muted, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}

/// The results of a scan: what is in the folder and what is new.

class CallRecordingScanCard extends StatelessWidget {
  const CallRecordingScanCard({
    super.key,
    required this.state,
    required this.onScan,
    required this.onSelectAllNew,
    required this.onClearSelection,
    required this.onToggle,
  });

  final CallRecordingState state;
  final VoidCallback onScan;
  final VoidCallback onSelectAllNew;
  final VoidCallback onClearSelection;
  final ValueChanged<String> onToggle;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final files = state.discovered;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.library_music_outlined, size: 18, color: c.muted),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'Recordings in the folder',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (state.busy)
                SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.accent,
                  ),
                ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          NovaSecondaryButton(
            label: files.isEmpty ? 'Scan the folder' : 'Scan again',
            icon: Icons.refresh_rounded,
            onPressed: state.canScan ? onScan : null,
          ),
          if (state.scanMessage != null) ...[
            const SizedBox(height: NovaSpace.sm),
            Text(
              state.scanMessage!,
              style: Theme.of(context).textTheme.bodySmall!.copyWith(
                color: state.scanStatus == CallRecordingCode.ok ? c.muted : c.warning,
              ),
            ),
          ],
          if (files.isNotEmpty) ...[
            const SizedBox(height: NovaSpace.sm),
            Row(
              children: [
                Expanded(
                  child: NovaSecondaryButton(
                    label: 'Select all new (${state.newAssets.length})',
                    icon: Icons.done_all_rounded,
                    onPressed: state.newAssets.isEmpty ? null : onSelectAllNew,
                  ),
                ),
                const SizedBox(width: NovaSpace.xs),
                Expanded(
                  child: NovaSecondaryButton(
                    label: 'Clear',
                    icon: Icons.clear_rounded,
                    onPressed: state.selected.isEmpty ? null : onClearSelection,
                  ),
                ),
              ],
            ),
            const SizedBox(height: NovaSpace.xs),
            for (final asset in files) ...[
              CallRecordingAssetTile(
                asset: asset,
                selected: state.selected.contains(asset.uri),
                alreadyImported: state.settings.importedFileIds.contains(
                  asset.uri,
                ),
                onToggle: () => onToggle(asset.uri),
              ),
              if (asset != files.last) Divider(height: 1, color: c.border),
            ],
          ] else if (state.scanStatus == CallRecordingCode.ok) ...[
            const SizedBox(height: NovaSpace.sm),
            Text(
              'No audio files here. A call-recording folder usually holds files '
              'like "Call_20260101_143000.m4a" — check that the dialer is set to '
              'record calls and that this is the folder it saves them in.',
              style: Theme.of(context).textTheme.bodySmall!.copyWith(color: c.muted),
            ),
          ],
        ],
      ),
    );
  }
}

/// One selectable recording. Filename, size, date and duration, exactly as the
/// file system reports them — the duration line says so when it has none.

class CallRecordingAssetTile extends StatelessWidget {
  const CallRecordingAssetTile({
    super.key,
    required this.asset,
    required this.selected,
    required this.alreadyImported,
    required this.onToggle,
  });

  final CallRecordingAsset asset;
  final bool selected;
  final bool alreadyImported;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final duration = asset.durationLabel;
    final modified = asset.modifiedLabel;

    return CallRecordingTileSurface(
      child: CheckboxListTile(
        value: selected,
        onChanged: (_) => onToggle(),
        contentPadding: EdgeInsets.zero,
        controlAffinity: ListTileControlAffinity.leading,
        dense: true,
        title: Text(asset.name, style: Theme.of(context).textTheme.titleSmall),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 2),
            Text(
              <String>[
                asset.sizeLabel,
                ?modified,
                ?duration,
              ].join(' · '),
              style: Theme.of(context).textTheme.bodySmall,
            ),
            Text(
              duration == null
                  ? 'Duration not reported by the file. NOVA will not guess one.'
                  : 'Length read from the file. Caller is not known — the '
                        'dialer\'s file name is all NOVA has.',
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.muted, fontSize: 11),
            ),
            if (alreadyImported)
              Text(
                'Already imported once. Tick to send it again.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall!.copyWith(color: c.success, fontSize: 11),
              ),
          ],
        ),
        secondary: Text(
          asset.title,
          style: Theme.of(
            context,
          ).textTheme.bodySmall!.copyWith(color: c.accent),
        ),
      ),
    );
  }
}

/// Per-file results, including the ones that failed and why.

class CallRecordingOutcomesCard extends StatelessWidget {
  const CallRecordingOutcomesCard({super.key, required this.state});

  final CallRecordingState state;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.cloud_upload_outlined, size: 18, color: c.muted),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'Import results',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (state.importing)
                SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.accent,
                  ),
                ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          for (final outcome in state.outcomes) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Icon(
                    outcome.ok
                        ? Icons.check_circle_rounded
                        : Icons.error_outline_rounded,
                    size: 16,
                    color: outcome.ok ? c.success : c.danger,
                  ),
                ),
                const SizedBox(width: NovaSpace.xs),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        outcome.asset.name,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      Text(
                        outcome.message ?? (outcome.ok ? 'Done.' : 'It failed.'),
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall!.copyWith(color: c.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: NovaSpace.sm),
          ],
          if (state.outcomes.isEmpty)
            Text(
              'Nothing has been imported in this session. Uploaded recordings '
              'appear with the meeting summaries, in the same list.',
              style: Theme.of(context).textTheme.bodySmall!.copyWith(color: c.muted),
            ),
        ],
      ),
    );
  }
}

/// The error banner, matching the notification assistant's.
