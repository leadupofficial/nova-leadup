import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../services/voice_stream_service.dart';
import 'voice_capture.dart';
import 'voice_protocol.dart';
import 'voice_realtime_state.dart';
import 'voice_stream_capture.dart';
import 'voice_streaming_playback.dart';

export 'voice_realtime_state.dart';

/// Owns the whole realtime voice turn: socket, microphone, event decoding,
/// playback and the state machine.
///
/// The controller never touches the UI directly. Finished turns accumulate in
/// [VoiceRealtimeState.commits] so the screen decides how (and whether) to put
/// them in the transcript, and provisional text stays in the state until
/// `final`/`done` replaces it.
class VoiceRealtimeController extends Notifier<VoiceRealtimeState> {
  static const _decoder = VoiceProtocolDecoder();
  static const _encoder = VoiceProtocolEncoder();

  late VoiceStreamService _service;
  late VoiceStreamCapture _capture;
  late VoiceStreamPlayback _playback;

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

  bool get isConnected => _service.isConnected;

  @override
  VoiceRealtimeState build() {
    // Watch (not read): a new service is created when the user signs in or out,
    // and this controller must rebuild against it rather than keep a socket
    // that was opened with a token that no longer exists.
    _service = ref.watch(voiceStreamServiceProvider);
    _capture = ref.watch(voiceStreamCaptureProvider);
    _playback = ref.watch(voiceStreamPlaybackProvider);

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
    await _bargeIn(generation);
    if (generation != _generation) return;

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
    _service.send(_encoder.cancel());
    await _capture.stop();
    await _playback.stop();
    _set(const VoiceRealtimeState(phase: VoiceRealtimePhase.idle));
  }

  /// Sends typed input through the same realtime pipeline.
  ///
  /// The screen keeps typed messages on the REST path because that is where the
  /// turn is persisted to the conversation; this exists so the frozen
  /// protocol's `text` frame is implemented and covered, and so a future caller
  /// does not have to re-derive it.
  Future<bool> sendText(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return false;

    final generation = _generation;
    await _playback.stop();
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
        // `final` closes the user's turn and opens the reply; the provisional
        // transcript is replaced by the committed bubble.
        //
        // Acknowledge immediately: the wait that follows is the model's
        // time-to-first-token, which is most of the gap before NOVA speaks, so
        // an instant blip makes it read as thinking rather than nothing at all.
        unawaited(_playback.acknowledge());
        _set(
          _appendCommit(
            text,
            user: true,
          ).copyWith(phase: VoiceRealtimePhase.thinking, partial: ''),
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
        // Open the single continuous player before the audio arrives so the
        // first chunk starts without a scheduling gap. A new sentence appends
        // to the same open stream, so it never restarts playback.
        _playback.beginTurn();
        _set(
          state.copyWith(
            phase: VoiceRealtimePhase.speaking,
            sentenceIndex: index,
            reply: state.reply.isEmpty ? text : state.reply,
          ),
        );

      case VoiceAudioEvent(:final bytes):
        _playback.addChunk(bytes);
        if (state.phase != VoiceRealtimePhase.speaking) {
          _set(state.copyWith(phase: VoiceRealtimePhase.speaking));
        }

      case VoiceSpeakingEvent(:final value):
        if (value) {
          _set(state.copyWith(phase: VoiceRealtimePhase.speaking));
        } else {
          // The server says it is done talking: flush, do not let the player
          // keep a stale buffer alive.
          unawaited(_playback.stop());
          if (state.phase == VoiceRealtimePhase.speaking) {
            _set(state.copyWith(phase: VoiceRealtimePhase.thinking));
          }
        }

      case VoiceDoneEvent(:final text):
        unawaited(_playback.endTurn());
        _set(
          _appendCommit(
            text,
            user: false,
          ).copyWith(
            // Not necessarily idle. The microphone is left open and the
            // provider's VAD is already listening for the next utterance, so
            // reporting idle here told the user the session had stopped while it
            // was still live and still capturing. That is what made hands-free
            // conversation look broken: the turn really had ended, but the
            // session had not.
            phase: state.micActive
                ? VoiceRealtimePhase.listening
                : VoiceRealtimePhase.idle,
            reply: '',
          ),
        );

      case VoiceServerErrorEvent(:final code, :final message):
        unawaited(_capture.stop());
        unawaited(_playback.stop());
        _fail(code: code, message: message);

      case VoiceUnknownEvent(:final type):
        debugPrint('[VoiceRealtime] ignoring unknown event "$type"');
    }
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
        _socketFault = true;
        unawaited(_capture.stop());
        unawaited(_playback.stop());
        if (state.phase == VoiceRealtimePhase.idle ||
            state.phase == VoiceRealtimePhase.error) {
          _set(state.copyWith(connected: false, micActive: false));
        } else {
          _fail(
            code: 'reconnecting',
            message: 'The voice connection dropped. Reconnecting…',
          );
        }

      case VoiceStreamStatus.disconnected:
      case VoiceStreamStatus.closed:
        _socketFault = true;
        unawaited(_capture.stop());
        unawaited(_playback.stop());
        if (state.phase == VoiceRealtimePhase.idle ||
            state.phase == VoiceRealtimePhase.error) {
          _set(state.copyWith(connected: false, micActive: false));
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
    _fail(code: error.failure.name, message: error.message);
  }

  void _onPlayingChanged(bool playing) {
    if (state.audible == playing) return;
    _set(state.copyWith(audible: playing));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /// Stops the microphone and any NOVA audio, and tells the server to abort
  /// whatever it was doing. This is the barge-in path.
  Future<void> _bargeIn(int generation) async {
    final wasActive = state.isTurnActive;
    if (wasActive) _service.send(_encoder.cancel());
    await _capture.stop();
    await _playback.stop();
    if (generation != _generation) return;
    if (wasActive) _set(const VoiceRealtimeState(phase: VoiceRealtimePhase.idle));
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
  }
}

final voiceRealtimeProvider =
    NotifierProvider<VoiceRealtimeController, VoiceRealtimeState>(
      VoiceRealtimeController.new,
    );
