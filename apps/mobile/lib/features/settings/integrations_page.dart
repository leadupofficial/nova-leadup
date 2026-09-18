import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Integrations — port of `settings/integrations.html`.
///
/// ── Why every row is honest rather than "Connected" ─────────────────────────
///
/// There is no integrations surface to wire this screen to:
///
///  * `services/api` — the backend behind `ApiConfig.baseUrl` — has no
///    integrations, connections, OAuth or device route at all. Its full route
///    set is activity, admin, ai, auth, biometric, chat, consent, conversations,
///    health, memories, notifications, recordings, reminders, settings,
///    streaming, subscriptions, tasks, tools, upload, voice, webhooks.
///  * The only integration backend in the repo is `services/integration-service`,
///    a **separate stub** on port 3005 mounted at `/api/integrations`. Its
///    `GET /status` always answers `{integrations: []}`, `POST /connect` returns a
///    fabricated `int-<timestamp>` without persisting anything, `/providers` is a
///    hardcoded list, and `DELETE /:provider` only echoes. It is not behind
///    `ApiConfig.baseUrl`, has no `ApiConfig` entry and no mobile client, so
///    pointing at it would mean inventing a host, not wiring one.
///  * `packages/database/src/schema.ts` declares `integrations` and
///    `integration_connections`, but nothing under `services/api` reads or writes
///    them.
///  * There is no `url_launcher` or webview in `pubspec.yaml`, so an OAuth
///    consent flow could not be launched even if a client id existed.
///
/// So the designed rows render an explicit "Not available yet" state, never a
/// fake "Connected", and their action opens a sheet naming the missing piece.
/// What *is* real is the tool catalogue (`GET /api/v1/tools`, the existing
/// [toolsProvider]) which is shown at the bottom with honest loading, empty and
/// error states — clearly labelled as server-side tool definitions rather than
/// per-user connected accounts.
class IntegrationsPage extends ConsumerWidget {
  const IntegrationsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final tools = ref.watch(toolsProvider);

    return NovaScaffold(
      padding: const EdgeInsets.only(
        left: NovaSpace.gutter,
        right: NovaSpace.gutter,
        top: NovaSpace.xs,
      ),
      topBar: Row(
        children: [
          if (Navigator.of(context).canPop())
            NovaIconButton(
              icon: Icons.chevron_left_rounded,
              size: 36,
              radius: NovaRadius.control,
              tooltip: 'Back',
              onTap: () => Navigator.of(context).pop(),
            )
          else
            const SizedBox(width: NovaMotion.minTouchTarget),
          // The export's `h1` is display/700 at 19px.
          Expanded(
            child: Center(
              child: Text(
                'Integrations',
                style: NovaTheme.sectionHeading(c).copyWith(fontSize: 19),
              ),
            ),
          ),
          // The export reserves a bare 36px box opposite the back button.
          const SizedBox(width: NovaMotion.minTouchTarget),
        ],
      ),
      refresh: () async {
        ref.invalidate(toolsProvider);
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          NovaCard(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.info_outline_rounded, size: 20, color: c.warning),
                const SizedBox(width: NovaSpace.sm),
                Expanded(
                  child: Text(
                    'Nothing can be connected yet. The NOVA API implements no '
                    'connections or OAuth routes and this build ships no OAuth '
                    'client, so every integration below is unavailable rather '
                    'than connected.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: NovaSpace.lg),
          for (final provider in _providers) _IntegrationRow(provider: provider),
          const SizedBox(height: NovaSpace.lg),
          const NovaSectionHeader(title: 'Tool access'),
          const SizedBox(height: NovaSpace.xs),
          Text(
            'What the API reports it can invoke today (GET /api/v1/tools). '
            'These are server-side tool definitions, not connected accounts.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: NovaSpace.sm),
          tools.when(
            loading: () =>
                const NovaStateView(loading: true, title: 'Loading tools'),
            error: (e, _) => NovaStateView(
              icon: Icons.cloud_off_rounded,
              tone: NovaStateTone.error,
              title: 'Could not load the tool catalogue',
              message: _message(e),
              actionLabel: 'Retry',
              onAction: () => ref.invalidate(toolsProvider),
            ),
            data: (list) => list.isEmpty
                ? const NovaStateView(
                    icon: Icons.extension_off_rounded,
                    title: 'No tools enabled',
                    message:
                        'This deployment has no enabled rows in '
                        'tool_definitions.',
                  )
                : Column(
                    children: [
                      for (final tool in list) _ToolRow(tool: tool),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

// ─── The designed rows ──────────────────────────────────────────────────────

typedef _Provider = ({
  String name,
  String emoji,
  String description,
  String gap,
});

/// The five integrations in `settings/integrations.html`, with the design's
/// capability copy preserved. The export's status line ("Last used 10 min ago",
/// "Approved Business API connection · Last used 2h ago") described state that
/// does not exist, so it is replaced by [gap] — what is actually missing.
const _providers = <_Provider>[
  (
    name: 'Google Calendar',
    emoji: '📅',
    description: 'Read and write events',
    gap: 'No Google OAuth client and no calendar route are deployed.',
  ),
  (
    name: 'Gmail',
    emoji: '📧',
    description: 'Read and draft emails on your behalf',
    gap: 'No Google OAuth client and no mail route are deployed.',
  ),
  (
    name: 'WhatsApp Business',
    emoji: '💬',
    description: 'Send and receive WhatsApp Business messages',
    gap: 'No Business API credentials and no webhook receiver are deployed.',
  ),
  (
    name: 'Contacts',
    emoji: '👤',
    description: 'Read-only access for smart addressing',
    gap: 'The app requests no contacts scope and no contacts route is deployed.',
  ),
  (
    name: 'CRM (Zoho / HubSpot)',
    emoji: '🏢',
    description: 'Sync leads, deals, and follow-ups',
    gap: 'No CRM connector and no OAuth client are deployed.',
  ),
];

/// `.int-card` — a designed integration row.
class _IntegrationRow extends StatelessWidget {
  const _IntegrationRow({required this.provider});

  final _Provider provider;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: NovaCard(
        padding: const EdgeInsets.all(NovaSpace.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                // `.int-icon` — 44px raised square.
                Container(
                  width: 44,
                  height: 44,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: c.surfaceRaised,
                    borderRadius: BorderRadius.circular(NovaRadius.control),
                  ),
                  child: Text(
                    provider.emoji,
                    style: const TextStyle(fontSize: 22),
                  ),
                ),
                const SizedBox(width: NovaSpace.sm),
                Expanded(
                  child: Text(
                    provider.name,
                    style: TextStyle(
                      fontFamily: NovaFonts.display,
                      fontSize: NovaType.body,
                      fontWeight: NovaType.wSemiBold,
                      color: c.fg,
                      height: 1.3,
                      fontVariations: [
                        FontVariation('wght', NovaTheme.wght(NovaType.wSemiBold)),
                      ],
                    ),
                  ),
                ),
                _statusPill(context, 'Not available yet', c.muted),
              ],
            ),
            const SizedBox(height: 10),
            // `.int-body` / `.int-actions` are indented past the 44px icon.
            Padding(
              padding: const EdgeInsets.only(left: 56),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(provider.description, style: _body(context)),
                  const SizedBox(height: NovaSpace.sm),
                  _miniBtn(
                    context,
                    'Details',
                    () => _details(context, provider),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// `.int-status` — 4/10 padding, 8px radius, 11px/600.
Widget _statusPill(BuildContext context, String label, Color tone) => Container(
  margin: const EdgeInsets.only(left: NovaSpace.xs),
  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
  decoration: BoxDecoration(
    color: tone.withValues(alpha: 0.12),
    borderRadius: NovaRadius.rSm,
  ),
  child: Text(
    label,
    style: TextStyle(
      fontFamily: NovaFonts.body,
      fontSize: NovaType.label,
      fontWeight: NovaType.wSemiBold,
      color: tone,
      height: 1.3,
      fontVariations: [
        FontVariation('wght', NovaTheme.wght(NovaType.wSemiBold)),
      ],
    ),
  ),
);

/// `.int-body` — 13px muted, 1.5 line-height.
TextStyle _body(BuildContext context) => TextStyle(
  fontFamily: NovaFonts.body,
  fontSize: 13,
  color: context.nova.muted,
  height: 1.5,
  fontVariations: [FontVariation('wght', NovaTheme.wght(NovaType.wRegular))],
);

/// `.mini-btn` — the design's 6/12 compact action.
///
/// Duplicated from `reminders_page.dart` rather than shared, because this change
/// may not edit `lib/core/design/widgets/index.dart`.
Widget _miniBtn(BuildContext context, String label, VoidCallback onTap) {
  final c = context.nova;
  return Semantics(
    button: true,
    label: label,
    child: Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: NovaRadius.rSm,
        child: Ink(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: c.surfaceRaised,
            borderRadius: NovaRadius.rSm,
            border: Border.all(color: c.border),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontFamily: NovaFonts.body,
              fontSize: NovaType.caption,
              fontWeight: NovaType.wMedium,
              color: c.fg,
              height: 1.3,
              fontVariations: [
                FontVariation('wght', NovaTheme.wght(NovaType.wMedium)),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// What each row would do, and precisely what is missing.
Future<void> _details(BuildContext context, _Provider provider) =>
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Theme.of(context).bottomSheetTheme.backgroundColor,
      builder: (sheet) => Padding(
        padding: const EdgeInsets.all(NovaSpace.gutter),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${provider.emoji}  ${provider.name}',
              style: NovaTheme.sectionHeading(sheet.nova),
            ),
            const SizedBox(height: NovaSpace.sm),
            _statusPill(sheet, 'Not available yet', sheet.nova.muted),
            const SizedBox(height: NovaSpace.md),
            Text(provider.description, style: _body(sheet)),
            const SizedBox(height: NovaSpace.sm),
            Text(provider.gap, style: Theme.of(sheet).textTheme.bodySmall),
            const SizedBox(height: NovaSpace.md),
            Text(
              'NOVA reports integration status only from the API, so this '
              'screen will not show a connected state until those routes exist.',
              style: Theme.of(sheet).textTheme.bodySmall,
            ),
            const SizedBox(height: NovaSpace.lg),
          ],
        ),
      ),
    );

// ─── Real data: the tool catalogue ──────────────────────────────────────────

class _ToolRow extends StatelessWidget {
  const _ToolRow({required this.tool});

  final NovaToolDefinition tool;

  @override
  Widget build(BuildContext context) {
    final level = tool.permissionLevel;
    final subtitle = [
      if (tool.description != null && tool.description!.isNotEmpty)
        tool.description!,
      if (level != null) 'Permission L$level',
      if (tool.confirmationRequired) 'Asks before acting',
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.xs),
      child: NovaCard(
        padding: EdgeInsets.zero,
        child: NovaListRow(
          title: tool.name,
          subtitle: subtitle,
          icon: Icons.build_circle_outlined,
          trailing: const SizedBox.shrink(),
        ),
      ),
    );
  }
}

String _message(Object error) =>
    error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');
