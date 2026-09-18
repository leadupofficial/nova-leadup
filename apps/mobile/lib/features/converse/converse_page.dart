import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../../core/voice/voice_capture.dart';
import '../../core/voice/voice_playback.dart';
import 'tool_confirm_sheet.dart';

/// The active conversation id for this Converse session; `null` means "not yet
/// resolved" — the screen loads the newest conversation, or creates one.
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

enum _Phase { idle, connecting, listening, transcribing, thinking, speaking }

/// Converse — the primary live-companion screen. Port of `chat/converse.html`.
///
/// The voice loop is real: the mic drives [VoiceCapture] (the `record` plugin),
/// `POST /api/v1/voice/stt` transcribes it, the transcription goes through the
/// same [_send] path as typed text, and the reply is read aloud through
/// [VoicePlayback] (`just_audio`) when "speak replies" is on (default: off).
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

  late final VoiceCapture _capture;
  late final VoicePlayback _playback;
  StreamSubscription<VoiceCaptureEvent>? _captureSub;
  StreamSubscription<bool>? _speakingSub;

  bool _busy = false;
  bool _listening = false;
  bool _transcribing = false;
  bool _speaking = false;

  /// Off by default: NOVA must never start talking at a user unprompted.
  bool _speakReplies = false;

  String? _notice;
  bool _noticeIsError = false;
  bool _promptedApproval = false;

  @override
  void initState() {
    super.initState();
    _capture = ref.read(voiceCaptureProvider);
    _playback = ref.read(voicePlaybackProvider);
    _captureSub = _capture.events.listen(_onCaptureEvent);
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
    _captureSub?.cancel();
    _speakingSub?.cancel();
    // Never leave the microphone open or NOVA talking behind the screen.
    unawaited(_capture.cancel());
    unawaited(_playback.stop());
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _showNotice(String? message, {bool error = false}) {
    _notice = message;
    _noticeIsError = error;
  }

  void _noticeError(String message) {
    setState(() => _showNotice(message, error: true));
  }

  /// Blueprint §5.7: a side-effecting action must be confirmed before it runs.
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
      if (mounted) _noticeError(_friendly(e));
    }
  }

  /// Resolves the thread id, creating the conversation on the first send.
  Future<String?> _threadId() async {
    final existing = ref.read(activeConversationProvider);
    if (existing != null) return existing;
    try {
      final created = await ref
          .read(novaMutationsProvider)
          .startConversation(title: 'New conversation');
      ref.read(activeConversationProvider.notifier).set(created.id);
      return created.id;
    } catch (e) {
      if (mounted) _noticeError(_friendly(e));
      return null;
    }
  }

  /// Starts or stops a real recording. The clip arrives through
  /// [_onCaptureEvent] rather than as a return value, so a stop triggered by
  /// the max-duration safety cap takes the same path as a user stop.
  Future<void> _toggleMic() async {
    if (_transcribing) return;
    if (_capture.isRecording) {
      await _capture.stop();
      return;
    }
    // Do not let the mic hear NOVA still talking.
    await _playback.stop();
    if (mounted) setState(() => _showNotice(null));
    try {
      await _capture.start();
      if (mounted) setState(() => _listening = true);
    } on VoiceCaptureException catch (error) {
      // Permission denials, a missing mic and start failures each carry their
      // own user-facing message. Nothing is swallowed.
      if (mounted) _noticeError(error.message);
    }
  }

  void _onCaptureEvent(VoiceCaptureEvent event) {
    if (!mounted) return;
    switch (event) {
      case VoiceClipCaptured(:final clip):
        setState(() {
          _listening = false;
          _transcribing = true;
          _showNotice(null);
        });
        unawaited(_transcribe(clip));
      case VoiceCaptureFailed(:final error):
        setState(() {
          _listening = false;
          _transcribing = false;
        });
        _noticeError(error.message);
    }
  }

  Future<void> _transcribe(VoiceClip clip) async {
    final String transcript;
    try {
      // The requested language picks the STT provider: 'en' routes to Deepgram.
      transcript = await ref
          .read(novaApiProvider)
          .transcribeAudio(audioBase64: clip.base64Data);
    } catch (error) {
      if (!mounted) return;
      setState(() => _transcribing = false);
      _noticeError('Could not transcribe that recording. ${_friendly(error)}');
      return;
    }

    if (!mounted) return;
    setState(() => _transcribing = false);
    final text = transcript.trim();
    if (text.isEmpty) {
      _noticeError('No speech was detected. Try again a little closer.');
      return;
    }
    await _send(text);
  }

  /// Reads [text] aloud if "speak replies" is on.
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

  Future<void> _stopSpeaking() async {
    await _playback.stop();
    if (mounted) setState(() => _speaking = false);
  }

  Future<void> _send(String text) async {
    if (text.trim().isEmpty || _busy) return;
    setState(() { _busy = true; _showNotice(null); });

    final conversationId = await _threadId();
    if (!mounted) return;
    if (conversationId == null) {
      setState(() => _busy = false);
      return;
    }

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
          .send(conversationId, text.trim());
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
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: NovaMotion.ui,
          curve: Curves.easeOut,
        );
      }
    });
  }

  _Phase _phase(String? conversationId) {
    if (_listening) return _Phase.listening;
    if (_transcribing) return _Phase.transcribing;
    if (_busy) return _Phase.thinking;
    if (_speaking) return _Phase.speaking;
    return conversationId == null ? _Phase.connecting : _Phase.idle;
  }

  NovaAvatarState _avatarState(_Phase phase) => switch (phase) {
    _Phase.listening => NovaAvatarState.listening,
    _Phase.transcribing || _Phase.thinking => NovaAvatarState.thinking,
    _Phase.speaking => NovaAvatarState.speaking,
    _ => NovaAvatarState.idle,
  };

  Widget _statusPill(_Phase phase) {
    final c = context.nova;
    final (label, tone) = switch (phase) {
      _Phase.listening => ('Listening', c.danger),
      _Phase.transcribing => ('Transcribing', c.accent),
      _Phase.thinking => ('Thinking', c.accent),
      _Phase.speaking => ('Speaking', c.success),
      _Phase.connecting => ('Connecting', c.warning),
      _Phase.idle => ('Ready', c.success),
    };
    // A repeating pulse would make `pumpAndSettle` hang, so only live voice
    // states and the connecting state animate.
    final animate = phase == _Phase.listening ||
        phase == _Phase.transcribing ||
        phase == _Phase.connecting;
    return NovaStatusPill(
      label: label,
      tone: tone,
      animate: animate,
      icon: phase == _Phase.speaking ? Icons.volume_up_rounded : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final messages = ref.watch(transcriptProvider);
    final conversationId = ref.watch(activeConversationProvider);
    final phase = _phase(conversationId);
    final busy = _busy || _transcribing || _listening;

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
                  status: _statusPill(phase),
                  speakReplies: _speakReplies,
                  onBack: () => context.go('/'),
                  onHistory: () => context.push('/conversations'),
                  onToggleSpeak: () =>
                      setState(() => _speakReplies = !_speakReplies),
                ),

                if (_notice != null)
                  NovaChatNotice(
                    message: _notice!,
                    tone: _noticeIsError ? c.danger : c.warning,
                    icon: _noticeIsError
                        ? Icons.error_outline_rounded
                        : Icons.info_outline_rounded,
                  ),

                NovaConverseHeader(state: _avatarState(phase)),

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

                NovaQuickActions(enabled: !busy, onPick: _send),

                if (_speaking)
                  Padding(
                    padding: const EdgeInsets.only(bottom: NovaSpace.xs),
                    child: NovaChip(
                      label: 'Stop speaking',
                      icon: Icons.stop_rounded,
                      selected: true,
                      onTap: () => unawaited(_stopSpeaking()),
                    ),
                  ),

                NovaComposer(
                  controller: _input,
                  enabled: !busy,
                  micActive: _listening,
                  hint: _listening
                      ? 'Listening… tap the mic to stop'
                      : 'Type a message…',
                  onSend: _send,
                  onMic: busy && !_listening
                      ? null
                      : () => unawaited(_toggleMic()),
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
