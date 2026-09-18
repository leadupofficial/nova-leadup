import 'dart:async';

import 'package:audio_session/audio_session.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';

/// Plays MP3 chunks as they arrive, one continuous utterance at a time.
///
/// [VoicePlayback] stages a complete clip in a temp file, which cannot start
/// until the server has synthesised the whole reply. This instead feeds a
/// single `just_audio` stream source for the whole turn: a new `sentence`
/// appends bytes to the *same* open stream, so there is no restart and no
/// audible gap between sentences, and playback begins on the first chunk.
abstract interface class VoiceStreamPlayback {
  /// Emits whenever audible playback starts or stops.
  Stream<bool> get playingStream;

  bool get isPlaying;

  /// Opens one utterance. Idempotent per turn; call on the first sentence.
  void beginTurn();

  /// Appends encoded MP3 bytes to the open utterance.
  void addChunk(List<int> bytes);

  /// Closes the byte stream so the player can reach the end of the reply and
  /// finish naturally (the already-buffered audio still plays out).
  Future<void> endTurn();

  /// Stops immediately and drops every queued byte. Used for barge-in, for the
  /// server's `speaking:false`, and for cancellation. Idempotent.
  Future<void> stop();

  Future<void> dispose();
}

/// The real implementation, backed by `just_audio`.
class Mp3StreamPlayback implements VoiceStreamPlayback {
  Mp3StreamPlayback({AudioPlayer Function()? playerFactory})
    : _playerFactory = playerFactory ?? AudioPlayer.new;

  final AudioPlayer Function() _playerFactory;

  AudioPlayer? _player;
  StreamSubscription<bool>? _playingSub;
  StreamSubscription<ProcessingState>? _stateSub;
  final StreamController<bool> _playing = StreamController<bool>.broadcast();

  /// The single byte sink for the current utterance. Never replaced while the
  /// utterance is open, which is what keeps playback gapless.
  StreamController<List<int>>? _bytes;
  bool _turnOpen = false;
  bool _sessionConfigured = false;
  bool _isPlaying = false;
  bool _disposed = false;

  @override
  Stream<bool> get playingStream => _playing.stream;

  @override
  bool get isPlaying => _isPlaying;

  @override
  void beginTurn() {
    if (_disposed || _turnOpen) return;
    _turnOpen = true;
    final controller = StreamController<List<int>>();
    _bytes = controller;
    unawaited(_start(_StreamAudioSource(controller, 'audio/mpeg')));
  }

  @override
  void addChunk(List<int> bytes) {
    if (bytes.isEmpty) return;
    final controller = _bytes;
    if (controller == null || controller.isClosed) return;
    controller.add(bytes);
  }

  @override
  Future<void> endTurn() async {
    _turnOpen = false;
    await _closeBytes();
  }

  @override
  Future<void> stop() async {
    _turnOpen = false;
    _setPlaying(false);
    // Closing first drops any bytes still queued in our sink; `player.stop()`
    // then drops whatever the platform player had already buffered.
    await _closeBytes();
    final player = _player;
    if (player == null) return;
    try {
      await player.stop();
    } catch (error) {
      debugPrint('[Mp3StreamPlayback] stop failed: $error');
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _turnOpen = false;
    await _playingSub?.cancel();
    _playingSub = null;
    await _stateSub?.cancel();
    _stateSub = null;
    await _closeBytes();
    await _playing.close();

    final player = _player;
    _player = null;
    try {
      await player?.dispose();
    } catch (error) {
      debugPrint('[Mp3StreamPlayback] dispose failed: $error');
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  Future<void> _start(_StreamAudioSource source) async {
    await _configureSession();
    if (_disposed || !_turnOpen) return;

    final player = _ensurePlayer();
    try {
      await player.setAudioSource(source);
      if (_disposed || !_turnOpen) return;
      // `play()` completes when playback finishes; never block the socket
      // handler on it.
      unawaited(
        player.play().catchError((Object error) {
          debugPrint('[Mp3StreamPlayback] playback failed: $error');
          _setPlaying(false);
        }),
      );
    } catch (error) {
      debugPrint('[Mp3StreamPlayback] could not start the stream: $error');
      _setPlaying(false);
      await _closeBytes();
    }
  }

  Future<void> _closeBytes() async {
    final controller = _bytes;
    _bytes = null;
    if (controller == null || controller.isClosed) return;
    try {
      await controller.close();
    } catch (error) {
      debugPrint('[Mp3StreamPlayback] closing the byte stream failed: $error');
    }
  }

  AudioPlayer _ensurePlayer() {
    final existing = _player;
    if (existing != null) return existing;

    final player = _playerFactory();
    _player = player;
    _playingSub = player.playingStream.listen(_setPlaying);
    _stateSub = player.processingStateStream.listen((state) {
      // A stream source reaches `completed` once its byte stream is closed and
      // the buffer has drained; that is the end of the reply.
      if (state == ProcessingState.completed) {
        _turnOpen = false;
        _setPlaying(false);
      }
    });
    return player;
  }

  Future<void> _configureSession() async {
    if (_sessionConfigured) return;
    try {
      final session = await AudioSession.instance;
      await session.configure(const AudioSessionConfiguration.speech());
      _sessionConfigured = true;
    } catch (error) {
      // Best effort: playback can still work with the platform default session.
      debugPrint('[Mp3StreamPlayback] audio session not configured: $error');
    }
  }

  void _setPlaying(bool value) {
    if (_isPlaying == value) return;
    _isPlaying = value;
    if (!_playing.isClosed) _playing.add(value);
  }
}

/// A `just_audio` stream source over one live, never-restarted byte stream.
///
/// `rangeRequestsSupported: false` tells `just_audio` to read the stream
/// sequentially from start to finish instead of issuing byte-range requests —
/// exactly what a live, length-unknown MP3 feed needs. `sourceLength` and
/// `contentLength` stay `null` because the server never says how long the reply
/// will be.
///
/// This API is marked `@experimental` by `just_audio`; it is used deliberately
/// because it is the only in-memory streaming source the package exposes, and
/// the alternative (writing each sentence to a file) is what produced the
/// audible gaps this replaces.
// ignore: experimental_member_use
class _StreamAudioSource extends StreamAudioSource {
  _StreamAudioSource(this._controller, this._contentType)
    : super(tag: 'nova-realtime-voice');

  final StreamController<List<int>> _controller;
  final String _contentType;
  bool _consumed = false;

  @override
  // ignore: experimental_member_use
  Future<StreamAudioResponse> request([int? start, int? end]) async {
    if (_consumed) {
      // A second request would try to listen to a single-subscription stream
      // twice; answer with an empty body instead of throwing.
      // ignore: experimental_member_use
      return StreamAudioResponse(
        sourceLength: null,
        contentLength: null,
        offset: 0,
        stream: const Stream<List<int>>.empty(),
        contentType: _contentType,
        rangeRequestsSupported: false,
      );
    }
    _consumed = true;
    // ignore: experimental_member_use
    return StreamAudioResponse(
      sourceLength: null,
      contentLength: null,
      offset: 0,
      stream: _controller.stream,
      contentType: _contentType,
      rangeRequestsSupported: false,
    );
  }
}

/// The app-wide streaming playback service.
final voiceStreamPlaybackProvider = Provider<VoiceStreamPlayback>((ref) {
  final playback = Mp3StreamPlayback();
  ref.onDispose(playback.dispose);
  return playback;
});
