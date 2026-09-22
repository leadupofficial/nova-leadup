import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../config/remote_config_provider.dart';
import '../../services/voice_stream_service.dart';
import 'device_tts.dart';
import 'voice_capture.dart';
import 'voice_device_fallback.dart';
import 'voice_protocol.dart';
import 'voice_realtime_state.dart';
import 'voice_stream_capture.dart';
import 'voice_streaming_playback.dart';
import 'voice_tool_approval.dart';

export 'voice_realtime_state.dart';
export 'voice_tool_approval.dart';

/// Owns the whole realtime voice turn: socket, microphone, event decoding,
/// playback and the state machine.
///
/// Finished turns accumulate in [VoiceRealtimeState.commits] for the screen to
/// render; provisional text stays until `final`/`done` replaces it.
///
/// Speech has two engines: the cloud one streams MP3 over the socket, and a
/// failure (`TTS_ERROR`) falls back to the platform via [VoiceDeviceFallback].
class VoiceRealtimeController extends Notifier<VoiceRealtimeState> {
  static const _decoder = VoiceProtocolDecoder();
  static const _encoder = VoiceProtocolEncoder();

  late VoiceStreamService _service;
  late VoiceStreamCapture _capture;
  late VoiceStreamPlayback _playback;
  late VoiceDeviceFallback _deviceSpeech;

  StreamSubscription<dynamic>? _messages;
  StreamSubscription<VoiceStreamStatus>? _statuses;
  StreamSubscription<Object>? _socketErrors;
  StreamSubscription<Uint8List>? _frames;
  StreamSubscription<VoiceCaptureException>? _captureErrors;
  StreamSubscription<bool>? _playing;

  /// Bumped on teardown so an `await` in flight from a previous socket cannot
  /// write to a rebuilt (or disposed) notifier.
  int _generation = 0;

  /// True when the error currently displayed was caused by a socket drop rather
  /// than by the server, so a successful reconnect can clear it.
  bool _socketFault = false;

  /// The language policy the current turn was started with, kept raw so the
  /// device engine can map `tanglish`/`auto` itself.
  String _languagePolicy = 'auto';

  bool get isConnected => _service.isConnected;

  @override
  VoiceRealtimeState build() {
    // Watch (not read): a new service is created when the user signs in or out,
    // and this controller must rebuild against it rather than keep a socket
    // that was opened with a token that no longer exists.
    _service = ref.watch(voiceStreamServiceProvider);
    _capture = ref.watch(voiceStreamCaptureProvider);
    _playback = ref.watch(voiceStreamPlaybackProvider);
    _deviceSpeech = VoiceDeviceFallback(
      tts: ref.watch(deviceTtsProvider),
      read: () => state,
      write: _set,
      cloudPlaying: () => _playback.isPlaying,
    );

    _messages = _service.messages.listen(_onFrame);
    _statuses = _service.statuses.listen(_onStatus);
    _socketErrors = _service.errors.listen(_onSocketError);
    _frames = _capture.frames.listen(_onMicFrame);
    _captureErrors = _capture.errors.listen(_onCaptureError);
    _playing = _playback.playingStream.listen(_onPlayingChanged);

    ref.onDispose(_teardown);
    _socketFault = false;
    return const VoiceRealtimeState();
  }

  // ── public API ────────────────────────────────────────────────────────────

  /// Begins a turn: barge in on anything in flight, connect, `start`, then open
  /// the microphone.
  ///
  /// [language] is a `NovaAvatarPrefs.languagePolicy` value; it is normalised to
  /// a bare protocol code by [normalizeVoiceLanguage].
  Future<void> startTurn({String language = 'auto'}) async {
    final generation = _generation;

    // Operator gate. `capabilities.voice` is the server's combined answer for the
    // VOICE_ASSISTANT/VOICE_STT/VOICE_TTS flags *and* the voice/STT/TTS kill switches,
    // so this single check is what makes an admin change visible here. It runs before
    // anything is sent: opening the microphone and then failing would leave the user
    // speaking into a dead session, and the mic would already be open.
    if (!ref.read(voiceCapabilityEnabledProvider)) {
      _fail(
        code: 'voice_disabled',
        message: ref.read(remoteConfigProvider).config.maintenance.enabled
            ? 'NOVA is under maintenance. Voice is unavailable right now.'
            : 'Voice has been temporarily disabled. You can still type to NOVA.',
      );
      return;
    }

    // A turn started from under an open confirmation sheet supersedes it: send
    // the "no" before the cancel, so the tool is refused rather than left
    // waiting on a request nobody is looking at any more.
    decideApproval(approve: false);
    await _bargeIn(generation);
    if (generation != _generation) return;

    _languagePolicy = language;
    _deviceSpeech.beginTurn(language);
    _set(const VoiceRealtimeState(phase: VoiceRealtimePhase.connecting));

    final connected = await _ensureConnected();
    if (generation != _generation) return;
    if (!connected) {
      _fail(
        code: 'offline',
        message: 'Cannot reach the NOVA voice server. Check your connection.',
      );
      return;
    }

    final accepted = _service.send(
      _encoder.start(language: normalizeVoiceLanguage(language)),
    );
    if (!accepted) {
      _fail(
        code: 'offline',
        message: 'The voice connection is not ready. Try again.',
      );
      return;
    }

    try {
      await _capture.start();
    } on VoiceCaptureException catch (error) {
      if (generation != _generation) return;
      // The turn was announced to the server but no audio will follow; close it
      // rather than leave the server waiting for a `stop` that never comes.
      _service.send(_encoder.cancel());
      _fail(code: error.failure.name, message: error.message);
      return;
    }
    if (generation != _generation) return;

    _set(
      const VoiceRealtimeState(
        phase: VoiceRealtimePhase.listening,
        micActive: true,
        connected: true,
      ),
    );
  }

  /// The user finished speaking. Closes the microphone and waits for `final`.
  Future<void> stopTurn() async {
    if (state.phase != VoiceRealtimePhase.listening) return;
    _service.send(_encoder.stop());
    await _capture.stop();
    _set(state.copyWith(phase: VoiceRealtimePhase.thinking, micActive: false));
  }

  /// Aborts the turn on the server and locally. Always safe to call.
  Future<void> cancel() async {
    // Anything the sheet was asking is now moot: refuse it explicitly so the
    // server does not hold the tool open until its timeout.
    decideApproval(approve: false);
    _service.send(_encoder.cancel());
    await _capture.stop();
    await _playback.stop();
    await _deviceSpeech.stop();
    _set(const VoiceRealtimeState(phase: VoiceRealtimePhase.idle));
  }

  /// Sends typed input through the same realtime pipeline.
  ///
  /// The screen keeps typed messages on the REST path because that is where the
  /// turn is persisted; this exists so the frozen protocol's `text` frame is
  /// implemented and covered, and so a future caller need not re-derive it.
  Future<bool> sendText(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return false;

    final generation = _generation;
    await _playback.stop();
    await _deviceSpeech.stop();
    if (generation != _generation) return false;
    if (!await _ensureConnected()) return false;
    if (generation != _generation) return false;

    final accepted = _service.send(_encoder.text(trimmed));
    if (accepted) {
      _set(
        const VoiceRealtimeState(
          phase: VoiceRealtimePhase.thinking,
          connected: true,
        ),
      );
    }
    return accepted;
  }

  /// Clears a displayed error and returns to [VoiceRealtimePhase.idle].
  void clearError() {
    if (state.phase != VoiceRealtimePhase.error) return;
    _socketFault = false;
    _set(const VoiceRealtimeState(phase: VoiceRealtimePhase.idle));
  }

  /// Clears the "speaking with the on-device voice" notice without touching the
  /// turn: the fallback is still in effect, the user has just acknowledged it.
  void dismissSpeechNotice() {
    if (state.speechNotice == null) return;
    _set(state.copyWith(clearSpeechNotice: true));
  }

  void dismissToolNotice() {
    if (state.toolNotice == null) return;
    _set(state.copyWith(toolNotice: null, clearToolNotice: true));
  }

  /// Answers the pending confirmation sheet (§5.7).
  ///
  /// Sends the decision for the exact request the sheet displayed and clears it
  /// from the state. Every path that closes the sheet must call this: an
  /// unanswered request is a refusal on the server, but a *rejection* that is
  /// sent immediately is better than leaving the turn to wait out its timeout.
  ///
  /// Safe to call when nothing is pending (the turn may have been cancelled
  /// while the sheet was open) — it then does nothing.
  void decideApproval({required bool approve}) {
    final pending = state.pendingApproval;
    if (pending == null) return;
    _service.send(
      _encoder.approvalResponse(
        approvalId: pending.approvalId,
        approve: approve,
        turnId: pending.turnId,
      ),
    );
    _set(state.copyWith(clearPendingApproval: true));
    debugPrint(
      '[VoiceRealtime] tool approval ${approve ? 'granted' : 'denied'}: '
      '${pending.tool} (${pending.approvalId})',
    );
  }

  // ── event handling ────────────────────────────────────────────────────────

  void _onFrame(dynamic frame) {
    final VoiceServerEvent event;
    try {
      event = _decoder.decode(frame);
    } on VoiceProtocolException catch (error) {
      debugPrint('[VoiceRealtime] dropped frame: $error');
      return;
    }

    switch (event) {
      case VoiceReadyEvent():
        final clearingFault = _socketFault && state.hasError;
        _socketFault = false;
        _set(
          state.copyWith(
            connected: true,
            phase: clearingFault ? VoiceRealtimePhase.idle : state.phase,
            clearError: clearingFault,
          ),
        );

      case VoicePartialEvent(:final text):
        // The visible "words appear as you speak" moment.
        _set(state.copyWith(partial: text));

      case VoiceFinalEvent(:final text):
        // `final` opens the reply and supersedes the last one outright: a
        // device utterance still being read out must not talk over it.
        _deviceSpeech.beginTurn(_languagePolicy);
        unawaited(_playback.acknowledge());
        _set(
          _appendCommit(text, user: true).copyWith(
            phase: VoiceRealtimePhase.thinking,
            partial: '',
            speechSource: VoiceSpeechSource.cloud,
            clearSpeechNotice: true,
          ),
        );
      case VoiceTokenEvent(:final text):
        _set(
          state.copyWith(
            reply: state.reply + text,
            phase: state.phase == VoiceRealtimePhase.speaking
                ? VoiceRealtimePhase.speaking
                : VoiceRealtimePhase.thinking,
          ),
        );
      case VoiceSentenceEvent(:final text, :final index):
        // Recorded unconditionally: the server sends the first sentence before
        // it discovers cloud TTS is down, so the fallback must replay it.
        _deviceSpeech.record(text);
        if (!_deviceSpeech.isDeviceEnabled) {
          // Open the single player before audio arrives so the first chunk
          // starts without a scheduling gap; later sentences append to the
          // same open stream and never restart it.
          _playback.beginTurn();
        }
        _set(
          state.copyWith(
            phase: VoiceRealtimePhase.speaking,
            sentenceIndex: index,
            reply: state.reply.isEmpty ? text : state.reply,
          ),
        );

      case VoiceAudioEvent(:final bytes):
        if (_deviceSpeech.isDeviceEnabled) {
          // Cloud synthesis already failed; anything still in flight would
          // restart a player the device engine has replaced.
          debugPrint('[VoiceRealtime] dropping cloud audio after TTS_ERROR');
        } else {
          _deviceSpeech.noteCloudAudio(state.sentenceIndex);
          _playback.addChunk(bytes);
          if (state.phase != VoiceRealtimePhase.speaking) {
            _set(state.copyWith(phase: VoiceRealtimePhase.speaking));
          }
        }

      case VoiceSpeakingEvent(:final value):
        if (value) {
          _set(state.copyWith(phase: VoiceRealtimePhase.speaking));
        } else {
          // The server says it is done talking: flush, do not let the player or
          // the device engine keep a stale utterance alive.
          unawaited(_playback.stop());
          unawaited(_deviceSpeech.stop());
          if (state.phase == VoiceRealtimePhase.speaking) {
            _set(state.copyWith(phase: VoiceRealtimePhase.thinking));
          }
        }

      case VoiceDoneEvent(:final text):
        final committed = _appendCommit(text, user: false);
        if (_deviceSpeech.isDeviceEnabled && _deviceSpeech.isActive) {
          // The device engine is still reading the reply out. Commit the text
          // now, but stay in `speaking` until it finishes: reporting
          // `listening` while NOVA is audibly talking would be a lie.
          _deviceSpeech.holdTurn();
          _set(
            committed.copyWith(reply: '', phase: VoiceRealtimePhase.speaking),
          );
        } else {
          unawaited(_playback.endTurn());
          _set(
            committed.copyWith(
              // Not necessarily idle. The microphone is left open and the
              // provider's VAD is already listening for the next utterance, so
              // reporting idle here told the user the session had stopped while
              // it was still live — which made hands-free look broken.
              phase: state.micActive
                  ? VoiceRealtimePhase.listening
                  : VoiceRealtimePhase.idle,
              reply: '',
            ),
          );
        }
      case VoiceServerErrorEvent(:final code, :final message):
        if (code == 'TTS_ERROR') {
          // Not a turn failure. The reply is already on screen and the device
          // can still say it; aborting here is what made one provider outage
          // produce total silence. Buffered audio drains rather than being cut
          // off mid-word.
          unawaited(_playback.endTurn());
          _deviceSpeech.enable();
        } else {
          unawaited(_capture.stop());
          unawaited(_playback.stop());
          unawaited(_deviceSpeech.stop());
          _fail(code: code, message: message);
        }

      case VoiceToolEvent(:final name, :final ok, :final summary, :final approval):
        // A write tool ran. Announced immediately rather than waiting for the
        // reply, because the whole point is that the user said "remind me" and
        // wants to know it was recorded. The summary is the server's own wording
        // and already names the item and its time, so it is shown as-is.
        //
        // A tool the approval gate stopped is not a tool failure, and must not
        // be reported as one: if the notice said "could not create reminder" the
        // user would think something broke rather than that NOVA is waiting for
        // them (or that their own "no" was honoured).
        final stopped = approval != null;
        _set(
          state.copyWith(
            toolNotice: stopped
                ? summary
                : (ok ? summary : 'Could not $name — the action failed.'),
            toolNoticeStopped: stopped,
          ),
        );

      case VoiceApprovalRequestEvent(
        :final approvalId,
        :final turnId,
        :final tool,
        :final level,
        :final summary,
        :final input,
        :final expiresAt,
      ):
        // §5.7: a side-effecting action is held until the user confirms it. The
        // server has already stopped; this surfaces the request so the screen
        // can raise the Tool Confirmation sheet, and nothing is sent back until
        // the user answers.
        //
        // Audio is stopped first: the sheet is a decision about what NOVA is
        // about to do, and NOVA talking over it — or continuing to hold the
        // microphone open — is exactly the "hands-free flow" in which a prompt
        // would otherwise be missed. It also means the next thing the user says
        // is an answer to the sheet, not a barge-in.
        unawaited(_playback.stop());
        unawaited(_deviceSpeech.stop());
        unawaited(_capture.stop());
        _set(
          state.copyWith(
            partial: '',
            reply: '',
            micActive: false,
            phase: VoiceRealtimePhase.thinking,
            pendingApproval: VoiceToolApproval(
              approvalId: approvalId,
              turnId: turnId,
              tool: tool,
              permissionLevel: level,
              summary: summary,
              input: input,
              expiresAt: expiresAt,
            ),
          ),
        );

      case VoiceSttFallbackEvent(:final provider, :final fallback, :final reason):
        if (!fallback) break;
        // The recogniser named for this language could not serve the turn and a
        // backup is transcribing instead. Surfaced rather than swallowed: the
        // whole reason the Sarvam outage went unnoticed was that a turn running
        // on a fallback looked exactly like one that was not.
        _set(
          state.copyWith(
            speechNotice:
                'Listening with $provider — the usual recogniser is unavailable'
                '${reason.isEmpty ? '.' : ' (${_shortReason(reason)}).'}',
          ),
        );

      case VoiceTtsFallbackEvent(:final provider, :final fallback, :final reason):
        if (!fallback) break;
        _set(
          state.copyWith(
            speechNotice:
                'Speaking with $provider — the usual voice is unavailable'
                '${reason.isEmpty ? '.' : ' (${_shortReason(reason)}).'}',
          ),
        );

      case VoiceUnknownEvent(:final type):
        debugPrint('[VoiceRealtime] ignoring unknown event "$type"');
    }
  }

  /// Trims a provider error down to something that fits a notice.
  ///
  /// Providers bury the reason after the close code — Sarvam sends
  /// "sarvam closed the stream (1003): Credits exhausted. Visit the API
  /// Dashboard…" — so taking the first clause alone would report the numeric
  /// code and drop the one part that says what is wrong. Prefer whichever
  /// clause actually names the problem.
  String _shortReason(String reason) {
    final clauses = reason
        .split(RegExp(r'[.:\n]'))
        .map((clause) => clause.trim())
        .where((clause) => clause.isNotEmpty)
        .toList();
    if (clauses.isEmpty) return '';

    const signals = <String>[
      'credit',
      'quota',
      'key',
      'unauthor',
      'forbidden',
      'rate limit',
      'not configured',
      'unavailable',
      'exhaust',
      'invalid',
    ];
    final informative = clauses.firstWhere(
      (clause) =>
          signals.any((signal) => clause.toLowerCase().contains(signal)),
      orElse: () => clauses.first,
    );
    return informative.length <= 60
        ? informative
        : '${informative.substring(0, 59)}…';
  }

  void _onMicFrame(Uint8List chunk) {
    if (!state.micActive || chunk.isEmpty) return;
    // A dropped frame is expected when the socket is down; the status handler
    // already reports the connection fault.
    _service.send(chunk);
  }

  void _onStatus(VoiceStreamStatus status) {
    switch (status) {
      case VoiceStreamStatus.connecting:
        if (state.phase == VoiceRealtimePhase.idle) {
          _set(state.copyWith(connected: false));
        }

      case VoiceStreamStatus.connected:
        // `_socketFault` is deliberately NOT cleared here: a socket being up
        // does not prove the token was accepted. Only a `ready` frame (or the
        // user dismissing the notice) clears a fault-driven error.
        _set(state.copyWith(connected: true));

      case VoiceStreamStatus.reconnecting:
      case VoiceStreamStatus.disconnected:
      case VoiceStreamStatus.closed:
        _socketFault = true;
        unawaited(_capture.stop());
        unawaited(_playback.stop());
        unawaited(_deviceSpeech.stop());
        if (state.phase == VoiceRealtimePhase.idle ||
            state.phase == VoiceRealtimePhase.error) {
          _set(state.copyWith(connected: false, micActive: false));
        } else if (status == VoiceStreamStatus.reconnecting) {
          _fail(
            code: 'reconnecting',
            message: 'The voice connection dropped. Reconnecting…',
          );
        } else {
          _fail(
            code: 'disconnected',
            message: 'The voice connection closed. Try again.',
          );
        }
    }
  }

  void _onSocketError(Object error) {
    debugPrint('[VoiceRealtime] socket error: $error');
  }

  void _onCaptureError(VoiceCaptureException error) {
    unawaited(_playback.stop());
    unawaited(_deviceSpeech.stop());
    _fail(code: error.failure.name, message: error.message);
  }

  void _onPlayingChanged(bool playing) {
    final audible = playing || _deviceSpeech.isActive;
    if (state.audible == audible) return;
    _set(state.copyWith(audible: audible));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /// Stops the microphone and NOVA audio and tells the server to abort.
  Future<void> _bargeIn(int generation) async {
    final wasActive = state.isTurnActive;
    if (wasActive) _service.send(_encoder.cancel());
    await _capture.stop();
    await _playback.stop();
    await _deviceSpeech.stop();
    if (generation != _generation) return;
    if (wasActive) {
      _set(const VoiceRealtimeState(phase: VoiceRealtimePhase.idle));
    }
  }

  /// Opens the socket and waits for it to report connected.
  Future<bool> _ensureConnected() async {
    if (_service.isConnected) return true;
    if (_service.status == VoiceStreamStatus.closed) return false;

    // Subscribe before connecting so a fast `connected` event cannot be missed
    // between the call and the first listen.
    final completer = Completer<bool>();
    late StreamSubscription<VoiceStreamStatus> subscription;
    subscription = _service.statuses.listen((status) {
      if (completer.isCompleted) return;
      if (status == VoiceStreamStatus.connected) {
        completer.complete(true);
      } else if (status == VoiceStreamStatus.disconnected ||
          status == VoiceStreamStatus.closed) {
        completer.complete(false);
      }
    });

    try {
      await _service.connect();
      return await completer.future.timeout(
        const Duration(seconds: 10),
        onTimeout: () => false,
      );
    } catch (error) {
      debugPrint('[VoiceRealtime] connect failed: $error');
      return false;
    } finally {
      await subscription.cancel();
    }
  }

  /// Appends [text] to the committed turns when it is not blank.
  VoiceRealtimeState _appendCommit(String text, {required bool user}) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return state;
    return state.copyWith(
      commits: <VoiceTurnCommit>[
        ...state.commits,
        VoiceTurnCommit(text: trimmed, user: user),
      ],
    );
  }

  void _fail({required String code, required String message}) {
    _set(
      VoiceRealtimeState(
        phase: VoiceRealtimePhase.error,
        errorCode: code,
        errorMessage: message,
        connected: _service.isConnected,
      ),
    );
  }

  void _set(VoiceRealtimeState next) {
    // Every caller reaches this after at least one `await` — `cancel()` stops capture, playback and
    // device speech before landing here — and the provider can be disposed in that gap. Writing
    // state on a disposed provider throws `UnmountedRefException`, which in a widget test surfaces
    // *after* the test body has finished: the E2E converse run reported "Some tests failed" with
    // every assertion passed and nothing pointing at the cause. The guard is the same one
    // `briefing_controller.dart` already uses on its async paths.
    if (!ref.mounted) return;
    state = next;
  }

  void _teardown() {
    _generation++;
    _messages?.cancel();
    _statuses?.cancel();
    _socketErrors?.cancel();
    _frames?.cancel();
    _captureErrors?.cancel();
    _playing?.cancel();
    _messages = null;
    _statuses = null;
    _socketErrors = null;
    _frames = null;
    _captureErrors = null;
    _playing = null;

    // Never leave the microphone open or NOVA talking when this controller goes
    // away (sign-out, provider rebuild, app teardown).
    unawaited(_capture.stop());
    unawaited(_playback.stop());
    unawaited(_deviceSpeech.stop());
  }
}

final voiceRealtimeProvider =
    NotifierProvider<VoiceRealtimeController, VoiceRealtimeState>(
      VoiceRealtimeController.new,
    );
