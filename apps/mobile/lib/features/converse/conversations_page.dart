import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';

/// Conversation history — the list of past threads.
///
/// NOTE ON PROVENANCE: the OpenDesign mobile export has no conversations-list
/// screen; it ships `chat/converse.html` only. `apps/web` does have
/// `/dashboard/conversations`. This screen therefore follows the *patterns* of the
/// export's other list screens (`.card` rows with a title, a muted meta line and
/// an empty state) rather than inventing a new visual language, and it is backed
/// by the real `/api/v1/conversations` resource.
///
/// The objective requires "conversations list + transcript + messaging"; Converse
/// covers the last two, this covers the first.
class ConversationsPage extends ConsumerWidget {
  const ConversationsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final conversations = ref.watch(conversationsProvider);

    return NovaScaffold(
      topBar: Row(
        children: [
          NovaIconButton(
            icon: Icons.arrow_back_rounded,
            size: 36,
            tooltip: 'Back',
            onTap: () => context.go('/converse'),
          ),
          const Spacer(),
          Text('Conversations', style: NovaTheme.sectionHeading(c)),
          const Spacer(),
          NovaIconButton(
            icon: Icons.add_comment_outlined,
            tooltip: 'New conversation',
            onTap: () => _startNew(context, ref),
          ),
        ],
      ),
      refresh: () async => ref.invalidate(conversationsProvider),
      child: conversations.when(
        loading: () => const NovaStateView(
          loading: true,
          title: 'Loading conversations',
        ),
        error: (e, _) => NovaStateView(
          icon: Icons.cloud_off_rounded,
          tone: NovaStateTone.error,
          title: 'Could not load your conversations',
          message: e.toString().replaceFirst(
            RegExp(r'^NovaApiException\(\d*\): '),
            '',
          ),
          actionLabel: 'Retry',
          onAction: () => ref.invalidate(conversationsProvider),
        ),
        data: (list) => list.isEmpty
            ? NovaStateView(
                icon: Icons.forum_outlined,
                title: 'No conversations yet',
                message: 'Everything you discuss with NOVA is kept here.',
                actionLabel: 'Start one',
                onAction: () => _startNew(context, ref),
              )
            : Column(
                children: list
                    .map((conv) => _ConversationTile(conversation: conv))
                    .toList(growable: false),
              ),
      ),
    );
  }

  static Future<void> _startNew(BuildContext context, WidgetRef ref) async {
    try {
      final conv = await ref.read(novaMutationsProvider).startConversation();
      ref.invalidate(conversationsProvider);
      if (context.mounted) context.go('/converse/${conv.id}');
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            e.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), ''),
          ),
        ),
      );
    }
  }
}

class _ConversationTile extends ConsumerWidget {
  const _ConversationTile({required this.conversation});

  final NovaConversation conversation;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;

    final meta = [
      _relative(conversation.updatedAt ?? conversation.createdAt),
      if (conversation.messageCount != null)
        '${conversation.messageCount} message'
            '${conversation.messageCount == 1 ? '' : 's'}',
    ].whereType<String>().join(' · ');

    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.xs),
      child: NovaCard(
        padding: const EdgeInsets.symmetric(
          horizontal: NovaSpace.sm,
          vertical: NovaSpace.xs,
        ),
        onTap: () => context.go('/converse/${conversation.id}'),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: c.accent.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(NovaRadius.control),
                border: Border.all(color: c.accent.withValues(alpha: 0.25)),
              ),
              child: Icon(
                Icons.chat_bubble_outline_rounded,
                size: 18,
                color: c.accent,
              ),
            ),
            const SizedBox(width: NovaSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    conversation.title,
                    style: Theme.of(context).textTheme.titleMedium,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    meta.isEmpty ? 'No messages yet' : meta,
                    style: NovaTheme.msgLabel(c),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            IconButton(
              icon: Icon(
                Icons.delete_outline_rounded,
                size: 20,
                color: c.muted,
              ),
              tooltip: 'Delete conversation',
              onPressed: () => _confirmDelete(context, ref),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context, WidgetRef ref) async {
    final c = context.nova;
    // Deleting a thread is irreversible, so it is confirmed rather than fired
    // from a single tap on a list row.
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: c.surface,
        title: const Text('Delete conversation?'),
        content: Text(
          '"${conversation.title}" and its messages will be removed.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text('Cancel', style: TextStyle(color: c.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text('Delete', style: TextStyle(color: c.danger)),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    try {
      await ref
          .read(novaMutationsProvider)
          .deleteConversation(conversation.id);
      ref.invalidate(conversationsProvider);
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            e.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), ''),
          ),
        ),
      );
    }
  }
}

String _relative(DateTime? t) {
  if (t == null) return 'just now';
  final d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours}h ago';
  if (d.inDays < 7) return '${d.inDays}d ago';
  return '${t.day}/${t.month}/${t.year}';
}
