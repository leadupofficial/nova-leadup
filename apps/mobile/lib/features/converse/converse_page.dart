import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import 'tool_confirm_sheet.dart';

/// The active conversation id for this Converse session.
///
/// `null` means "not yet resolved": the screen loads the newest conversation, or
/// creates one, on first build.
class ActiveConversation extends Notifier<String?> {
  @override
  String? build() => null;

  void set(String id) => state = id;
}

final activeConversationProvider =
    NotifierProvider<ActiveConversation, String?>(ActiveConversation.new);

/// Local transcript for the active conversation.
///
/// Held separately from [messagesProvider] so an optimistic user bubble and the
/// assistant's reply can be appended without a full refetch flicker.
class Transcript extends Notifier<List<NovaMessage>> {
  @override
  List<NovaMessage> build() => const [];

  void set(List<NovaMessage> messages) => state = messages;
}

final transcriptProvider = NotifierProvider<Transcript, List<NovaMessage>>(
  Transcript.new,
);

/// Converse — the primary live-companion screen. Port of `chat/converse.html`.
///
/// Structure from the export: `.top-bar` with the red `RECORDING` pill, the
/// avatar ring + `.avatar-state` badge, the `.recording-indicator` waveform, the
/// `.transcript` of `.msg` bubbles, the horizontally scrolling `.quick-actions`
/// chips, the `.controls` row and the `.input-bar`.
///
/// The AI reply is real: it comes from
/// `POST /api/v1/conversations/:id/messages`, which the API now wires into
/// `services/api/src/services/ai.ts`. When no provider key is configured the
/// server still stores the user's turn and returns a machine-readable
/// `assistantError`, which this screen surfaces instead of losing the message.
class ConversePage extends ConsumerStatefulWidget {
  const ConversePage({super.key, this.conversationId});

  /// Opens a specific thread when navigated from the conversation history;
  /// null means "resume the newest, or start one".
  final String? conversationId;

  @override
  ConsumerState<ConversePage> createState() => _ConversePageState();
}

class _ConversePageState extends ConsumerState<ConversePage> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  bool _recording = false;
  bool _busy = false;
  String? _banner;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _ensureConversation();
      _maybePromptApproval();
    });
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// Blueprint §5.7: a side-effecting action must be confirmed before it runs.
  /// The server queues it as a `tool_approvals` row; this raises the sheet for
  /// the oldest pending one once, per visit.
  bool _promptedApproval = false;

  Future<void> _maybePromptApproval() async {
    if (_promptedApproval || !mounted) return;
    try {
      final approvals = await ref.read(novaApiProvider).listApprovals();
      if (!mounted) return;
      final pending = approvals.where((a) => a.isPending).toList();
      if (pending.isEmpty) return;
      _promptedApproval = true;
      await ToolConfirmSheet.show(context, pending.first);
    } catch (_) {
      // A missing approvals endpoint must not block the conversation.
    }
  }

  Future<NovaConversation> _newestOrNew(NovaApi api) async {
    final existing = await api.listConversations(limit: 1);
    return existing.isNotEmpty
        ? existing.first
        : await api.createConversation(title: 'New conversation');
  }

  Future<void> _ensureConversation() async {
    if (ref.read(activeConversationProvider) != null) return;
    try {
      final api = ref.read(novaApiProvider);
      final requested = widget.conversationId;
      final conversation = requested != null
          ? await api.getConversation(requested)
          : await _newestOrNew(api);
      if (!mounted) return;
      ref.read(activeConversationProvider.notifier).set(conversation.id);
      final messages = await api.listMessages(conversation.id);
      if (!mounted) return;
      ref.read(transcriptProvider.notifier).set(messages);
      _scrollToEnd();
    } catch (e) {
      if (mounted) setState(() => _banner = _friendly(e));
    }
  }

  Future<void> _send(String text) async {
    if (text.trim().isEmpty || _busy) return;

    // A conversation has to exist before a message can be attached to it. The
    // Converse tab opens on a brand-new thread with no id, and this used to bail
    // out here, so the composer and every quick action were dead on arrival —
    // "Start a conversation" was unreachable by text. Create the thread on the
    // first send instead.
    var conversationId = ref.read(activeConversationProvider);
    if (conversationId == null) {
      setState(() {
        _busy = true;
        _banner = null;
      });
      try {
        final created = await ref
            .read(novaMutationsProvider)
            .startConversation(title: 'New conversation');
        conversationId = created.id;
        ref.read(activeConversationProvider.notifier).set(conversationId);
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _busy = false;
          _banner = _friendly(e);
        });
        return;
      }
      if (!mounted) return;
    }

    _input.clear();
    setState(() {
      _busy = true;
      _banner = null;
    });

    // Optimistic user bubble so the transcript responds immediately.
    final optimistic = NovaMessage(
      id: 'local-${DateTime.now().microsecondsSinceEpoch}',
      role: 'user',
      content: text.trim(),
      createdAt: DateTime.now(),
    );
    ref.read(transcriptProvider.notifier).set([
      ...ref.read(transcriptProvider),
      optimistic,
    ]);
    _scrollToEnd();

    try {
      final result = await ref
          .read(novaMutationsProvider)
          .send(conversationId, text.trim());
      if (!mounted) return;

      final updated = [...ref.read(transcriptProvider)];
      // Replace the optimistic bubble with the server's stored turn.
      final idx = updated.indexWhere((m) => m.id == optimistic.id);
      if (idx != -1 && result.userMessage != null) {
        updated[idx] = result.userMessage!;
      }
      if (result.assistantMessage != null) {
        updated.add(result.assistantMessage!);
      }
      ref.read(transcriptProvider.notifier).set(updated);

      setState(() {
        _banner = result.assistantError == null
            ? null
            : _explainAssistantError(result.assistantError!);
      });
    } catch (e) {
      if (!mounted) return;
      final updated = [...ref.read(transcriptProvider)];
      final idx = updated.indexWhere((m) => m.id == optimistic.id);
      if (idx != -1) updated[idx] = optimistic.copyWith(failed: true);
      ref.read(transcriptProvider.notifier).set(updated);
      setState(() => _banner = _friendly(e));
    } finally {
      if (mounted) setState(() => _busy = false);
      _scrollToEnd();
    }
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: NovaMotion.ui,
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final messages = ref.watch(transcriptProvider);
    final conversationId = ref.watch(activeConversationProvider);
    final state = _recording
        ? NovaAvatarState.recording
        : _busy
        ? NovaAvatarState.thinking
        : NovaAvatarState.idle;

    return Scaffold(
      backgroundColor: c.bg,
      body: Stack(
        children: [
          const NovaAura(),
          SafeArea(
            top: false,
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.only(
                    top: 44,
                    bottom: 8,
                    left: NovaSpace.gutter,
                    right: NovaSpace.gutter,
                  ),
                  child: Row(
                    children: [
                      NovaIconButton(
                        icon: Icons.arrow_back_rounded,
                        size: 36,
                        tooltip: 'Back',
                        onTap: () => context.go('/'),
                      ),
                      const Spacer(),
                      if (_recording)
                        const NovaStatusPill(label: 'Recording')
                      else
                        NovaStatusPill(
                          label: conversationId == null ? 'Connecting' : 'Ready',
                          tone: conversationId == null ? c.warning : c.success,
                          animate: conversationId == null,
                        ),
                      const Spacer(),
                      NovaIconButton(
                        icon: Icons.history_rounded,
                        size: 36,
                        tooltip: 'Conversation history',
                        onTap: () => context.push('/conversations'),
                      ),
                    ],
                  ),
                ),

                if (_banner != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: NovaSpace.gutter,
                      vertical: NovaSpace.xs,
                    ),
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(NovaSpace.sm),
                      decoration: BoxDecoration(
                        color: c.warning.withValues(alpha: 0.12),
                        borderRadius: NovaRadius.rControl,
                        border: Border.all(
                          color: c.warning.withValues(alpha: 0.35),
                        ),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            Icons.info_outline_rounded,
                            size: 16,
                            color: c.warning,
                          ),
                          const SizedBox(width: NovaSpace.xs),
                          Expanded(
                            child: Text(
                              _banner!,
                              style: Theme.of(
                                context,
                              ).textTheme.bodySmall!.copyWith(color: c.fg),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),

                NovaConverseHeader(state: state),

                Expanded(
                  child: messages.isEmpty
                      ? NovaStateView(
                          icon: Icons.forum_outlined,
                          title: 'Start a conversation',
                          message:
                              'Ask NOVA anything, set a reminder, or just say hello.',
                          loading: conversationId == null,
                        )
                      : ListView.builder(
                          controller: _scroll,
                          padding: const EdgeInsets.symmetric(
                            horizontal: NovaSpace.gutter,
                          ),
                          itemCount: messages.length,
                          itemBuilder: (context, i) {
                            final m = messages[i];
                            return NovaMessageBubble(
                              text: m.content,
                              role: m.isUser
                                  ? NovaMessageRole.user
                                  : NovaMessageRole.nova,
                              failed: m.failed,
                              onRetry: m.failed
                                  ? () => _send(m.content)
                                  : null,
                            );
                          },
                        ),
                ),

                _QuickActions(
                  // Enabled with no conversation too: the first pick creates the
                  // thread (see _send).
                  enabled: !_busy,
                  onPick: _send,
                ),

                NovaComposer(
                  controller: _input,
                  enabled: !_busy,
                  micActive: _recording,
                  onSend: _send,
                  onMic: () => setState(() => _recording = !_recording),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _friendly(Object e) {
    final s = e.toString();
    if (s.contains('401')) return 'Your session expired. Please sign in again.';
    if (s.contains('Cannot reach')) return 'Cannot reach the NOVA server.';
    return s.replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');
  }

  String _explainAssistantError(String code) {
    if (code.contains('AI_NOT_CONFIGURED')) {
      return 'NOVA stored your message, but no AI provider key is configured on '
          'the server yet, so no reply could be generated.';
    }
    if (code.contains('AI_BLOCKED')) {
      return 'NOVA declined to answer that one.';
    }
    return 'NOVA could not generate a reply: $code';
  }
}

/// `.quick-actions` — horizontally scrolling suggestion chips.
class _QuickActions extends StatelessWidget {
  const _QuickActions({required this.enabled, required this.onPick});

  final bool enabled;
  final ValueChanged<String> onPick;

  static const _actions = <(IconData, String, String)>[
    (Icons.check_circle_outline_rounded, 'Create task', 'Create a task: '),
    (Icons.alarm_add_rounded, 'Set reminder', 'Remind me to '),
    (Icons.search_rounded, 'Search memory', 'What do you remember about '),
    (Icons.translate_rounded, 'Translate', 'Translate this to Tamil: '),
  ];

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: NovaSpace.gutter),
        itemCount: _actions.length,
        separatorBuilder: (_, _) => const SizedBox(width: NovaSpace.xs),
        itemBuilder: (context, i) {
          final (icon, label, prefix) = _actions[i];
          return Center(
            child: Opacity(
              opacity: enabled ? 1 : 0.5,
              child: NovaChip(
                label: label,
                icon: icon,
                onTap: enabled ? () => onPick(prefix) : null,
              ),
            ),
          );
        },
      ),
    );
  }
}
