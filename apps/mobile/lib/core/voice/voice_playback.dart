import 'dart:async';
import 'dart:io';

import 'package:audio_session/audio_session.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';

/// Raised when assistant audio could not be prepared or played.
class VoicePlaybackException implements Exception {
  const VoicePlaybackException(this.message, {this.cause});

  final String message;
  final Object? cause;

  @override
  String toString() => 'VoicePlaybackException: $message';
}

typedef TempDirectoryProvider = Future<Directory> Function();

/// Plays the bytes returned by `NovaApi.synthesizeSpeech`.
///
/// One player, one utterance at a time: [play] stops anything already playing
/// before it starts, and [stop] is always safe to call. The audio session is
/// configured for spoken assistant audio so playback ducks rather than fights
/// the user's music and is routed to the speaker on iOS.
///
/// The clip is staged in the cache directory because `just_audio`'s stable API
/// plays files rather than in-memory buffers; the file is deleted on stop,
/// on natural completion, and on dispose.
class VoicePlayback {
  VoicePlayback({
    AudioPlayer Function()? playerFactory,
    TempDirectoryProvider? temporaryDirectory,
  }) : _playerFactory = playerFactory ?? AudioPlayer.new,
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory;

  final AudioPlayer Function() _playerFactory;
  final TempDirectoryProvider _temporaryDirectory;

  AudioPlayer? _player;
  StreamSubscription<bool>? _playingSub;
  StreamSubscription<ProcessingState>? _stateSub;
  final _playing = StreamController<bool>.broadcast();
  bool _isPlaying = false;
  bool _sessionConfigured = false;
  bool _disposed = false;
  String? _clipPath;

  /// Emits whenever audible playback starts or stops.
  Stream<bool> get playingStream => _playing.stream;

  bool get isPlaying => _isPlaying;

  /// Decodes and plays [bytes]. Throws [VoicePlaybackException] when the audio
  /// cannot be handed to the platform.
  Future<void> play(List<int> bytes, {String contentType = 'audio/mpeg'}) async {
    if (_disposed) {
      throw const VoicePlaybackException(
        'The audio player has already been disposed.',
      );
    }
    if (bytes.isEmpty) {
      throw const VoicePlaybackException('There was no audio to play.');
    }

    // Never let two utterances overlap.
    await stop();
    await _configureSession();

    final player = _ensurePlayer();
    _playingSub ??= player.playingStream.listen(_setPlaying);

    _clipPath = await _writeClip(bytes, contentType);
    try {
      await player.setFilePath(_clipPath!);
    } catch (error) {
      _setPlaying(false);
      await _deleteClip();
      throw VoicePlaybackException(
        'The spoken reply could not be played: $error',
        cause: error,
      );
    }

    // `play()` completes when playback finishes; do not block the caller on it.
    unawaited(
      player.play().catchError((Object error) {
        debugPrint('[VoicePlayback] playback failed: $error');
        _setPlaying(false);
      }),
    );
  }

  /// Stops playback immediately and removes the staged clip. Idempotent.
  Future<void> stop() async {
    _setPlaying(false);
    final player = _player;
    if (player != null) {
      try {
        await player.stop();
      } catch (error) {
        debugPrint('[VoicePlayback] stop failed: $error');
      }
    }
    await _deleteClip();
  }

  /// Releases the player and the session. Idempotent.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _playingSub?.cancel();
    _playingSub = null;
    await _stateSub?.cancel();
    _stateSub = null;
    await _playing.close();
    final player = _player;
    _player = null;
    try {
      await player?.dispose();
    } catch (error) {
      debugPrint('[VoicePlayback] dispose failed: $error');
    }
    await _deleteClip();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  AudioPlayer _ensurePlayer() {
    final existing = _player;
    if (existing != null) return existing;

    final player = _playerFactory();
    _player = player;
    _stateSub = player.processingStateStream.listen((state) {
      if (state == ProcessingState.completed) {
        // `playing` stays true past the end of the clip; drop the session so
        // the "Stop speaking" affordance cannot linger.
        unawaited(stop());
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
      debugPrint('[VoicePlayback] audio session not configured: $error');
    }
  }

  Future<String> _writeClip(List<int> bytes, String contentType) async {
    final directory = await _temporaryDirectory();
    final file = File(
      '${directory.path}/nova_reply_${DateTime.now().microsecondsSinceEpoch}'
      '.${_extensionFor(contentType)}',
    );
    await file.writeAsBytes(bytes, flush: true);
    return file.path;
  }

  Future<void> _deleteClip() async {
    final path = _clipPath;
    _clipPath = null;
    if (path == null) return;
    try {
      final file = File(path);
      if (await file.exists()) await file.delete();
    } catch (error) {
      debugPrint('[VoicePlayback] could not delete $path: $error');
    }
  }

  String _extensionFor(String contentType) {
    final type = contentType.toLowerCase();
    if (type.contains('wav')) return 'wav';
    if (type.contains('ogg') || type.contains('opus')) return 'ogg';
    if (type.contains('mp4') || type.contains('aac') || type.contains('m4a')) {
      return 'm4a';
    }
    return 'mp3';
  }

  void _setPlaying(bool value) {
    if (_isPlaying == value) return;
    _isPlaying = value;
    if (!_playing.isClosed) _playing.add(value);
  }
}

/// The app-wide playback service.
final voicePlaybackProvider = Provider<VoicePlayback>((ref) {
  final playback = VoicePlayback();
  ref.onDispose(playback.dispose);
  return playback;
});
