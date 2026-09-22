import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../../core/voice/voice_playback.dart';
import '../../core/voice/voice_protocol.dart';
import '../../core/voice/voice_realtime_controller.dart';
import '../../core/voice/voice_realtime_view.dart';
import '../../core/voice/voice_session_store.dart';
import 'tool_confirm_sheet.dart';

/// Converse — the primary live-companion screen. Port of `chat/converse.html`.
///
/// The microphone drives [VoiceRealtimeController] over the realtime WebSocket
/// (`/api/v1/voice/realtime`): partial words appear as the user speaks and the
/// reply streams back as text plus MP3 audio. Tapping the mic while NOVA talks
/// barges in. Typed messages keep the REST path ([_send]) because that is where
/// a turn is persisted to the conversation.
class ConversePage extends ConsumerStatefulWidget {
  const ConversePage({super.key, this.conversationId});

  /// Opens a specific thread when navigated from the conversation history.
  final String? conversationId;

  @override
  ConsumerState<ConversePage> createState() => _ConversePageState();
}

class _ConversePageState extends ConsumerState<ConversePage> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  late final VoiceRealtimeController _realtime;
  late final VoicePlayback _playback;
  StreamSubscription<bool>? _speakingSub;

  bool _busy = false;

  /// True while the REST text-to-speech of a typed reply is audible.
  bool _speaking = false;

  /// Off by default: NOVA must never start talking at a user unprompted.
  ///
  /// Persisted, though. The choice used to live only in widget state, so anyone
  /// who *did* want spoken replies had to switch it back on after every restart,
  /// which reads as the setting being broken rather than as a default.
  bool _speakReplies = false;

  /// Preference key for [_speakReplies]. `shared_preferences` prefixes this.
  static const String speakRepliesPreferenceKey = 'nova_speak_replies';

  String? _notice;
  bool _noticeIsError = false;
  bool _promptedApproval = false;

  /// The voice approval request currently on screen, so the sheet is raised once
  /// per request rather than on every rebuild while it waits for an answer.
  String? _showingVoiceApproval;

  /// True while a decision the user made is being applied.
  ///
  /// Approving *clears* `pendingApproval`, which is the same signal as "the
  /// request went away" — so the branch below fired on the normal approve path
  /// and popped the page on top of the sheet's own pop. Measured with a route
  /// trace, two pops three milliseconds apart:
  ///
  ///   POP ModalBottomSheetRoute of bool, prev=converse
  ///   POP converse prev=-
  ///   delegate matches=0 uri=
  ///
  /// An empty match list is go_router's `SizedBox.shrink()`, which over the
  /// window's own background is a **black screen** with no chrome and no way out
  /// but a force-stop. This flag lets the normal path stand down while keeping
  /// the original intent for a request that really does vanish.
  bool _decidingApproval = false;

  @override
  void initState() {
    super.initState();
    _realtime = ref.read(voiceRealtimeProvider.notifier);
    _playback = ref.read(voicePlaybackProvider);
    // Restore the persisted choice before the first frame, so the toggle does
    // not visibly flip from off to on after the page paints.
    _speakReplies =
        ref.read(sharedPreferencesProvider).getBool(speakRepliesPreferenceKey) ??
        false;
    _speakingSub = _playback.playingStream.listen((playing) {
      if (mounted && _speaking != playing) setState(() => _speaking = playing);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _ensureConversation();
      _maybePromptApproval();
    });
  }

  @override
  void dispose() {
    _speakingSub?.cancel();
    // Never leave the microphone open or NOVA talking behind the screen.
    unawaited(_realtime.cancel());
    unawaited(_playback.stop());
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _showNotice(String? message, {bool error = false}) {
    _notice = message;
    _noticeIsError = error;
  }

  void _noticeError(String message) =>
      setState(() => _showNotice(message, error: true));

  /// Blueprint §5.7: a side-effecting action must be confirmed before it runs.
  ///
  /// This is the typed path's queue: the server has already parked an approval
  /// row and is waiting for the decision through the approvals route.
  Future<void> _maybePromptApproval() async {
    if (_promptedApproval || !mounted) return;
    try {
      final pending = (await ref.read(novaApiProvider).listApprovals())
          .where((a) => a.isPending)
          .toList();
      if (!mounted || pending.isEmpty) return;
      _promptedApproval = true;
      await ToolConfirmSheet.show(context, pending.first);
    } catch (_) {
      // A missing approvals endpoint must not block the conversation.
    }
  }

  /// The voice path's equivalent of [_maybePromptApproval].
  ///
  /// A spoken turn reaches the tool loop over the open socket, where there is no
  /// `tool_approvals` row to poll — the server emitted `approval_request` and is
  /// holding the tool until this answers. The sheet is the same one the typed
  /// path uses, driven by the payload the server sent, and the answer goes back
  /// over the socket instead of the approvals route.
  ///
  /// The turn is genuinely paused here: no tool runs and no more of the reply is
  /// generated until the user answers, so this is a real prompt and not a
  /// notification. The microphone and playback were stopped when the request
  /// arrived (see [VoiceRealtimeController]), which is what makes it usable
  /// hands-free — the user is not talking over NOVA to read it.
  Future<void> _maybePromptVoiceApproval(VoiceRealtimeState voice) async {
    final pending = voice.pendingApproval;
    if (pending == null) {
      // A request that went away while its sheet was up (cancelled turn, timeout
      // on the server) takes the sheet with it — but not while the user's own
      // decision is being applied, because that clears `pendingApproval` too and
      // the sheet is already closing itself.
      if (_showingVoiceApproval != null && mounted && !_decidingApproval) {
        _showingVoiceApproval = null;
        Navigator.of(context).maybePop();
      }
      return;
    }
    if (!mounted || _showingVoiceApproval == pending.approvalId) return;

    _showingVoiceApproval = pending.approvalId;
    try {
      final approved = await ToolConfirmSheet.show(
        context,
        NovaToolApproval(
          id: pending.approvalId,
          toolName: pending.tool,
          toolInput: pending.input,
          permissionLevel: pending.permissionLevel,
          expiresAt: pending.expiresAt,
        ),
        // Answered over the socket, not the approvals route: there is no row.
        // The flag brackets the state change, which is what notifies the
        // listener above.
        onDecide: (approve) async {
          _decidingApproval = true;
          try {
            _realtime.decideApproval(approve: approve);
          } finally {
            _decidingApproval = false;
          }
        },
        title: _approvalTitle(pending),
        consequence: pending.consequence,
        confirmLabel: pending.isExternal ? 'Approve and send' : 'Approve and run',
      );
      if (!mounted) return;
      // Safety net for a sheet dismissed without a decision: the server treats
      // no answer as a refusal, but saying "no" now is faster than waiting for
      // its timeout, and the state is cleared either way.
      if (approved == null) _realtime.decideApproval(approve: false);
    } catch (error) {
      if (mounted) {
        _noticeError('Could not show that confirmation: $error');
        _realtime.decideApproval(approve: false);
      }
    } finally {
      if (_showingVoiceApproval == pending.approvalId) {
        _showingVoiceApproval = null;
      }
    }
  }

  /// The sheet's heading: the server's one-line statement of what will happen,
  /// which is more useful than the tool's internal name.
  String _approvalTitle(VoiceToolApproval approval) =>
      approval.summary.isEmpty ? approval.tool : approval.summary;

  Future<void> _ensureConversation() async {
    if (ref.read(activeConversationProvider) != null) return;
    try {
      final api = ref.read(novaApiProvider);
      final requested = widget.conversationId;
      final NovaConversation conversation;
      if (requested != null) {
        conversation = await api.getConversation(requested);
      } else {
        final existing = await api.listConversations(limit: 1);
        conversation = existing.isNotEmpty
            ? existing.first
            // No title: the server's single default is the one every other
            // path uses. Passing 'New conversation' here produced rows reading
            // "New conversation" beside the server's "New Conversation", and the
            // two were visible together in the Conversations list.
            : await api.createConversation();
      }
      if (!mounted) return;
      ref.read(activeConversationProvider.notifier).set(conversation.id);
      final messages = await api.listMessages(conversation.id);
      if (!mounted) return;
      ref.read(transcriptProvider.notifier).set(messages);
      _scrollToEnd();
    } catch (e) {
      if (mounted) _noticeError(_friendly(e));
    }
  }

  /// The mic button: start a live turn, or end the one that is listening.
  ///
  /// Tapping while NOVA is thinking or speaking starts a *new* turn, which the
  /// controller performs as a barge-in — the "interrupt NOVA mid-sentence"
  /// gesture.
  Future<void> _toggleMic() async {
    if (ref.read(voiceRealtimeProvider).phase == VoiceRealtimePhase.listening) {
      await _realtime.stopTurn();
      return;
    }
    // A REST text-to-speech reply must not talk over the microphone.
    await _playback.stop();
    if (mounted) {
      setState(() {
        _speaking = false;
        _showNotice(null);
      });
    }
    // Awaited, not `read`: a lazy provider's first `read` is null, and null
    // normalises to `auto`, which silently discards the language the user pinned.
    final persona = await ref.read(personaProvider.future);
    await _realtime.startTurn(
      language: normalizeVoiceLanguage(persona.languagePolicy),
    );
  }

  /// The explicit Stop control: cancels the turn on the server and locally.
  Future<void> _stopEverything() async {
    await _realtime.cancel();
    await _playback.stop();
    if (mounted && _speaking) setState(() => _speaking = false);
  }

  /// Appends turns the realtime socket finished while the screen was open.
  void _appendVoiceCommits(List<VoiceTurnCommit> commits) {
    if (commits.isEmpty || !mounted) return;
    final updated = [...ref.read(transcriptProvider)];
    for (final commit in commits) {
      updated.add(
        NovaMessage(
          // Locally minted ids: the socket does not return server-side ids, and
          // the transcript only needs them to be stable within the screen.
          id: 'voice-${DateTime.now().microsecondsSinceEpoch}-${updated.length}',
          role: commit.user ? 'user' : 'assistant',
          content: commit.text,
          createdAt: DateTime.now(),
        ),
      );
    }
    ref.read(transcriptProvider.notifier).set(updated);
    _scrollToEnd();
  }

  /// Reads [text] aloud if "speak replies" is on (typed replies only).
  Future<void> _speak(String text) async {
    if (text.trim().isEmpty) return;
    try {
      final bytes = await ref
          .read(novaApiProvider)
          .synthesizeSpeech(text: text);
      if (mounted) await _playback.play(bytes);
    } catch (error) {
      // Covers the server's `audioData: null` + `error` TTS fallback (thrown by
      // NovaApiException) and any playback failure. Both are shown, not eaten.
      if (mounted) _noticeError('NOVA could not speak: ${_friendly(error)}');
    }
  }

  /// The typed-message path. Unchanged from the pre-realtime screen except that
  /// it supersedes whatever the voice socket is doing.
  Future<void> _send(String text) async {
    if (text.trim().isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _showNotice(null);
    });

    // Resolve the thread, creating the conversation on the first send.
    var conversationId = ref.read(activeConversationProvider);
    if (conversationId == null) {
      try {
        final created = await ref
            .read(novaMutationsProvider)
            // No title, for the same reason as above.
            .startConversation();
        ref.read(activeConversationProvider.notifier).set(created.id);
        conversationId = created.id;
      } catch (e) {
        if (mounted) {
          _noticeError(_friendly(e));
          setState(() => _busy = false);
        }
        return;
      }
    }
    if (!mounted) return;

    // A typed turn supersedes whatever the voice socket is doing.
    unawaited(_realtime.cancel());
    unawaited(_playback.stop());
    _input.clear();

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
          .send(
            conversationId,
            text.trim(),
            // The companion's configured language, so the server can tell the
            // model which language to answer in rather than inferring it.
            // 'auto' means "match whatever the user writes".
            language: ref.read(personaProvider).asData?.value.languagePolicy,
          );
      if (!mounted) return;

      final updated = [...ref.read(transcriptProvider)];
      final idx = updated.indexWhere((m) => m.id == optimistic.id);
      if (idx != -1 && result.userMessage != null) {
        updated[idx] = result.userMessage!;
      }
      final reply = result.assistantMessage;
      if (reply != null) updated.add(reply);
      ref.read(transcriptProvider.notifier).set(updated);

      setState(() {
        if (result.assistantError != null) {
          _showNotice(_explainAssistantError(result.assistantError!));
        } else {
          _showNotice(null);
        }
      });
      if (_speakReplies && reply != null) unawaited(_speak(reply.content));
    } catch (e) {
      if (!mounted) return;
      // Keep the user's turn visible and retryable rather than losing it.
      final updated = [...ref.read(transcriptProvider)];
      final idx = updated.indexWhere((m) => m.id == optimistic.id);
      if (idx != -1) updated[idx] = optimistic.copyWith(failed: true);
      ref.read(transcriptProvider.notifier).set(updated);
      _noticeError(_friendly(e));
    } finally {
      if (mounted) setState(() => _busy = false);
      _scrollToEnd();
    }
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: NovaMotion.ui,
        curve: Curves.easeOut,
      );
    });
  }

  VoiceRealtimePhase _phase(String? conversationId) {
    final voice = ref.watch(voiceRealtimeProvider).phase;
    if (voice != VoiceRealtimePhase.idle) return voice;
    if (_busy) return VoiceRealtimePhase.thinking;
    if (_speaking) return VoiceRealtimePhase.speaking;
    return conversationId == null
        ? VoiceRealtimePhase.connecting
        : VoiceRealtimePhase.idle;
  }

  /// The saved appearance preferences, or the defaults when the request has not
  /// resolved (or failed) yet — the avatar must render regardless.
  String get _avatarEmotion =>
      ref.watch(avatarPrefsProvider).asData?.value.emotion ?? 'neutral';

  NovaAvatarDensity get _avatarDensity => NovaAvatarDensity.parse(
    ref.watch(avatarPrefsProvider).asData?.value.animationDensity,
  );

  /// One notice slot: a voice-session error outranks a Cloud-voice notice, which
  /// outranks a REST-path notice.
  (String, Color, IconData, VoidCallback)? get _activeNotice {
    final c = context.nova;
    final voice = ref.watch(voiceRealtimeProvider);
    final voiceError = voice.errorMessage;
    if (voiceError != null) {
      return (
        voiceError,
        c.danger,
        Icons.error_outline_rounded,
        _realtime.clearError,
      );
    }
    // A tool confirmation outranks the voice caveat: "the reminder is set" is
    // what the user just asked for, and the voice notice is a standing footnote.
    final tool = voiceToolNotice(voice, c, _realtime.dismissToolNotice);
    if (tool != null) {
      return (tool.message, tool.tone, tool.icon, tool.onDismiss);
    }
    final speech = voiceSpeechNotice(voice, c, _realtime.dismissSpeechNotice);
    if (speech != null) {
      return (speech.message, speech.tone, speech.icon, speech.onDismiss);
    }
    final local = _notice;
    if (local == null) return null;
    return (
      local,
      _noticeIsError ? c.danger : c.warning,
      _noticeIsError ? Icons.error_outline_rounded : Icons.info_outline_rounded,
      () => setState(() => _showNotice(null)),
    );
  }

  /// The provisional transcript and reply bubbles for the live turn.
  ///
  /// Their layout-free contents live in the voice view layer
  /// ([voiceLiveTranscript]/[voiceLiveReply]); this screen only places them.
  List<Widget> _liveBubbles(VoiceRealtimeState voice) => <Widget>[
    ?voiceLiveTranscript(voice),
    ?voiceLiveReply(voice),
  ];

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final messages = ref.watch(transcriptProvider);
    final conversationId = ref.watch(activeConversationProvider);
    final voice = ref.watch(voiceRealtimeProvider);
    final phase = _phase(conversationId);

    // Drain finished realtime turns into the visible transcript.
    ref.listen<VoiceRealtimeState>(voiceRealtimeProvider, (previous, next) {
      final rendered = previous?.commits.length ?? 0;
      if (next.commits.length > rendered) {
        _appendVoiceCommits(next.commits.sublist(rendered));
      }
    });

    // Raise the Tool Confirmation sheet for a side-effecting tool the voice
    // server is holding (§5.7). Registered here rather than in `initState`
    // because `ref.listen` must be called from `build` to stay tied to this
    // element's lifecycle; it fires the handling exactly once per change.
    ref.listen<VoiceRealtimeState>(voiceRealtimeProvider, (previous, next) {
      final was = previous?.pendingApproval;
      final now = next.pendingApproval;
      if (was?.approvalId == now?.approvalId && was != null) return;
      unawaited(_maybePromptVoiceApproval(next));
    });

    final live = _liveBubbles(voice);
    final notice = _activeNotice;

    return Scaffold(
      backgroundColor: c.bg,
      body: Stack(
        children: [
          const NovaAura(),
          SafeArea(
            top: false,
            child: Column(
              children: [
                NovaConversationTopBar(
                  status: NovaVoiceStatusPill(
                    phase: phase,
                    speechSource: voice.speechSource,
                  ),
                  speakReplies: _speakReplies,
                  onBack: () => context.go('/'),
                  onHistory: () => context.push('/conversations'),
                  onToggleSpeak: () {
                    final next = !_speakReplies;
                    setState(() => _speakReplies = next);
                    // Persist so the choice survives a restart.
                    unawaited(
                      ref
                          .read(sharedPreferencesProvider)
                          .setBool(speakRepliesPreferenceKey, next),
                    );
                    // Switching speech off mid-sentence should stop it now
                    // rather than let the current reply finish talking.
                    if (!next) unawaited(_playback.stop());
                  },
                ),

                if (notice != null)
                  NovaChatNotice(
                    message: notice.$1,
                    tone: notice.$2,
                    icon: notice.$3,
                    onDismiss: notice.$4,
                  ),

                NovaConverseHeader(
                  state: voiceAvatarState(phase),
                  emotion: _avatarEmotion,
                  animationDensity: _avatarDensity,
                ),

                Expanded(
                  child: messages.isEmpty && live.isEmpty
                      ? NovaStateView(
                          icon: Icons.forum_outlined,
                          title: 'Start a conversation',
                          message:
                              'Tap the mic and just talk, or type a message. '
                              'NOVA answers out loud as it thinks.',
                          loading: conversationId == null,
                        )
                      : ListView.builder(
                          controller: _scroll,
                          padding: const EdgeInsets.symmetric(
                            horizontal: NovaSpace.gutter,
                          ),
                          itemCount: messages.length + live.length,
                          itemBuilder: (context, i) {
                            if (i >= messages.length) {
                              return live[i - messages.length];
                            }
                            final m = messages[i];
                            return NovaMessageBubble(
                              text: m.content,
                              role: m.isUser
                                  ? NovaMessageRole.user
                                  : NovaMessageRole.nova,
                              failed: m.failed,
                              onRetry: m.failed ? () => _send(m.content) : null,
                              // Play's AI-Generated Content policy requires an in-app
                              // way to report offensive model output. Only assistant
                              // replies can be reported, and only once they exist —
                              // `NovaMessageBubble` additionally suppresses the control
                              // for pending, provisional and failed bubbles.
                              onReport: m.isUser
                                  ? null
                                  : () => unawaited(_reportReply(m)),
                            );
                          },
                        ),
                ),

                NovaQuickActions(enabled: !_busy, onPick: _send),

                if (voice.isTurnActive || _speaking)
                  Padding(
                    padding: const EdgeInsets.only(bottom: NovaSpace.xs),
                    child: NovaChip(
                      label: 'Stop',
                      icon: Icons.stop_rounded,
                      selected: true,
                      onTap: () => unawaited(_stopEverything()),
                    ),
                  ),

                NovaComposer(
                  controller: _input,
                  enabled: !_busy,
                  micActive: voice.micActive,
                  hint: voice.micActive
                      ? 'Listening… tap the mic to stop'
                      : 'Type a message…',
                  onSend: _send,
                  onMic: () => unawaited(_toggleMic()),
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

  /// Files a report about an assistant reply, entirely inside the app.
  ///
  /// Google Play's AI-Generated Content policy requires "in-app user reporting or
  /// flagging features that allow users to report or flag offensive content to
  /// developers without needing to exit the app." The reason list is deliberately
  /// short and concrete, the report reaches the server's audit trail, and the
  /// confirmation is a snackbar rather than a mail client or a web form — either of
  /// which would send the user out of the app and fail the requirement.
  Future<void> _reportReply(NovaMessage message) async {
    final reason = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                'Report this reply',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Text(
                'Reports go to the NOVA team with the reply and your account, so the '
                'answer can be reviewed. Nothing else in your conversation is sent.',
                style: TextStyle(fontSize: 13, height: 1.4),
              ),
            ),
            _reportOption(sheetContext, 'harmful', 'Harmful or dangerous advice'),
            _reportOption(sheetContext, 'sexual', 'Sexual or explicit content'),
            _reportOption(sheetContext, 'hate', 'Hate speech or harassment'),
            _reportOption(sheetContext, 'unsafe', 'Unsafe for another reason'),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (reason == null || !mounted) return;

    try {
      await ref.read(novaApiProvider).reportAiResponse(
            messageId: message.id,
            reason: reason,
            // The excerpt is bounded so a report cannot become an upload channel for
            // an entire conversation; the server stores it with the audit entry.
            excerpt: message.content.length > 500
                ? message.content.substring(0, 500)
                : message.content,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Thanks — this reply has been reported.')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not send the report: ${_friendly(error)}')),
      );
    }
  }

  Widget _reportOption(BuildContext sheetContext, String value, String label) {
    return ListTile(
      title: Text(label),
      onTap: () => Navigator.of(sheetContext).pop(value),
    );
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
