import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';

import 'voice_realtime_state.dart';

/// On-device speech synthesis.
///
/// The cloud provider is a single point of failure: when Sarvam is out of
/// credit or its key is rejected, NOVA can still hear the user but produces no
/// voice at all. This seam lets the realtime controller fall back to the
/// platform engine, which needs no key, no account and no credits, and lets
/// tests substitute a fake so nothing touches a platform channel under test.
abstract interface class DeviceTts {
  /// Whether the engine has a voice for [languageTag] (BCP-47).
  ///
  /// A null tag means "the device default voice", which always counts as
  /// available. Implementations must not throw: an engine that cannot answer
  /// is treated as capable, so speech is attempted rather than skipped.
  Future<bool> canSpeak(String? languageTag);

  /// Speaks [text], completing when the utterance finishes or is stopped.
  ///
  /// [languageTag] is BCP-47; null leaves the engine on its default voice.
  /// Never throws: a synthesiser failure is not worth failing a turn over.
  Future<void> speak(String text, {String? languageTag});

  /// Stops the current utterance and drops anything the engine has queued.
  Future<void> stop();

  Future<void> dispose();
}

/// The real implementation, backed by `flutter_tts`.
///
/// The engine is created lazily so that merely constructing this object (which
/// happens whenever the controller is built, including in tests) does not touch
/// a platform channel.
class FlutterTtsDeviceTts implements DeviceTts {
  FlutterTtsDeviceTts({FlutterTts Function()? engineFactory})
    : _engineFactory = engineFactory ?? FlutterTts.new;

  final FlutterTts Function() _engineFactory;
  FlutterTts? _engine;
  Completer<void>? _utterance;
  bool _configured = false;
  bool _disposed = false;

  FlutterTts get _tts => _engine ??= _engineFactory();

  @override
  Future<bool> canSpeak(String? languageTag) async {
    if (languageTag == null) return true;
    final wanted = _baseLanguage(languageTag);

    final installed = await _installedLanguages();
    if (installed != null) return installed.contains(wanted);

    // No usable voice list; ask the engine directly.
    try {
      final available = await _tts.isLanguageAvailable(languageTag);
      return available == true;
    } catch (error) {
      debugPrint('[DeviceTts] language check failed: $error');
      // Unknown. Attempt the utterance rather than staying silent on a guess.
      return true;
    }
  }

  @override
  Future<void> speak(String text, {String? languageTag}) async {
    if (_disposed || text.trim().isEmpty) return;

    final utterance = Completer<void>();
    _utterance = utterance;

    final engine = _tts;
    engine.setCompletionHandler(() => _finish(utterance));
    engine.setCancelHandler(() => _finish(utterance));
    engine.setErrorHandler((message) {
      debugPrint('[DeviceTts] synthesis failed: $message');
      _finish(utterance);
    });

    try {
      await _configure();
      if (languageTag != null) await engine.setLanguage(languageTag);
      await engine.speak(text);
    } catch (error) {
      // A missing engine or voice must degrade to silence, never to a crash or
      // a failed turn.
      debugPrint('[DeviceTts] speak failed: $error');
      _finish(utterance);
    }

    await utterance.future;
  }

  @override
  Future<void> stop() async {
    _finishCurrent();
    final engine = _engine;
    if (engine == null) return;
    try {
      await engine.stop();
    } catch (error) {
      debugPrint('[DeviceTts] stop failed: $error');
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await stop();
    _engine = null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  Future<void> _configure() async {
    if (_configured) return;
    _configured = true;
    try {
      // 0.0-1.0 on both Android and iOS, where 0.5 is the natural rate.
      await _tts.setSpeechRate(0.5);
      await _tts.setPitch(1.0);
      await _tts.setVolume(1.0);
    } catch (error) {
      debugPrint('[DeviceTts] could not configure the engine: $error');
    }
  }

  /// The installed voices, as base language subtags, or null when the engine
  /// could not tell us (an empty list is the Android API 21/22 bug, not an
  /// answer).
  Future<Set<String>?> _installedLanguages() async {
    try {
      final languages = await _tts.getLanguages;
      if (languages is! List || languages.isEmpty) return null;
      return languages.map((l) => _baseLanguage(l.toString())).toSet();
    } catch (error) {
      debugPrint('[DeviceTts] getLanguages failed: $error');
      return null;
    }
  }

  void _finish(Completer<void> utterance) {
    if (!utterance.isCompleted) utterance.complete();
  }

  void _finishCurrent() {
    final utterance = _utterance;
    _utterance = null;
    if (utterance != null) _finish(utterance);
  }
}

/// `ta-IN`, `ta_IN`, `ta` → `ta`.
String _baseLanguage(String tag) =>
    tag.replaceAll('_', '-').split('-').first.trim().toLowerCase();

/// BCP-47 tags for the languages NOVA ships, keyed by the app's language policy.
const Map<String, String> _kDeviceLanguageByPolicy = <String, String>{
  'en': 'en-IN',
  'ta': 'ta-IN',
  'hi': 'hi-IN',
};

/// Resolves the BCP-47 tag the device engine should use.
///
/// [languagePolicy] is a `NovaAvatarPrefs.languagePolicy` value (`en`, `ta`,
/// `hi`, `tanglish`, `auto`, …). `auto` and `tanglish` have no fixed language,
/// so they follow the script the reply is actually written in; when that cannot
/// be determined (Latin text) the answer is `null`, meaning "the device default
/// voice" — the honest choice rather than guessing English.
String? resolveDeviceLanguageTag({
  required String? languagePolicy,
  required String text,
}) {
  final policy = (languagePolicy ?? 'auto').trim().toLowerCase();
  final mapped = _kDeviceLanguageByPolicy[policy];
  if (mapped != null) return mapped;
  return _tagForScript(text);
}

/// Tamil (U+0B80–U+0BFF) and Devanagari (U+0900–U+097F) are the two
/// non-Latin scripts NOVA's replies are written in.
String? _tagForScript(String text) {
  for (final rune in text.runes) {
    if (rune >= 0x0B80 && rune <= 0x0BFF) return 'ta-IN';
    if (rune >= 0x0900 && rune <= 0x097F) return 'hi-IN';
  }
  return null;
}

/// Owns the device-speech fallback for one turn.
///
/// It records every sentence the server produces (the first one arrives *before*
/// cloud synthesis fails, so it would otherwise be lost), speaks them in order
/// once the fallback is enabled, and exposes which voice the reply is actually
/// coming from so the UI can say so. Serialising utterances here — rather than
/// relying on the engine's queue mode, which differs between Android and iOS —
/// means sentence N+1 can never truncate sentence N, and one [stop] drops the
/// whole backlog, the contract the cloud player already honours.
class DeviceSpeechQueue {
  DeviceSpeechQueue(this._tts);

  final DeviceTts _tts;
  final List<_Utterance> _pending = <_Utterance>[];
  final List<_Utterance> _recorded = <_Utterance>[];
  bool _draining = false;
  bool _active = false;
  bool _deviceEnabled = false;
  int _generation = 0;

  /// Which engine is voicing the reply, for the state machine and the UI.
  VoiceSpeechSource source = VoiceSpeechSource.cloud;

  /// The BCP-47 tag in use, or null for the device default.
  String? languageTag;

  /// A one-line explanation of the fallback, shown in the UI.
  String? notice;

  /// The sentence index cloud audio was last received for, or -1. Sentences the
  /// cloud already voiced are not re-spoken when the fallback turns on.
  int _audioThrough = -1;

  /// Fires when the queue starts and stops being audible.
  void Function(bool active)? onActiveChanged;

  /// Fires whenever [source], [languageTag] or [notice] change.
  void Function()? onStateChanged;

  /// True while an utterance is queued or being spoken.
  bool get isActive => _active;

  /// True once this turn has switched to device speech.
  bool get isDeviceEnabled => _deviceEnabled;

  /// Records that cloud audio arrived for sentence [sentenceIndex].
  void noteCloudAudio(int sentenceIndex) {
    if (sentenceIndex > _audioThrough) _audioThrough = sentenceIndex;
  }

  /// Records a sentence for the current turn, speaking it immediately when the
  /// fallback is already enabled.
  void record(String text, {String? languageTag}) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    final utterance = _Utterance(trimmed, languageTag);
    _recorded.add(utterance);
    if (_deviceEnabled) _enqueue(utterance);
  }

  /// Switches this turn to device speech, replaying the sentences the server
  /// already sent but the cloud never voiced.
  void enableDevice() {
    if (_deviceEnabled) return;
    _deviceEnabled = true;
    _publish(
      VoiceSpeechSource.device,
      _recorded.isEmpty ? null : _recorded.first.languageTag,
      'Cloud voice is unavailable — NOVA is speaking with the on-device voice.',
    );
    // Sentence indices are contiguous and in order, so skipping the cloud-voiced
    // prefix is safe and stops a half-played sentence being repeated.
    final start = (_audioThrough + 1).clamp(0, _recorded.length);
    for (final utterance in _recorded.skip(start)) {
      _enqueue(utterance);
    }
  }

  /// Forgets the current turn. Call on a new user turn or on cancellation.
  void resetTurn() {
    _recorded.clear();
    _pending.clear();
    _audioThrough = -1;
    _deviceEnabled = false;
    _publish(VoiceSpeechSource.cloud, null, null);
  }

  /// Drops every queued utterance and silences the one in flight.
  Future<void> stop() async {
    _generation++;
    _pending.clear();
    _draining = false;
    _setActive(false);
    await _tts.stop();
  }

  /// Stops speech. The engine itself is owned by [deviceTtsProvider], which
  /// disposes it when the provider goes away.
  Future<void> dispose() => stop();

  void _enqueue(_Utterance utterance) {
    _pending.add(utterance);
    // Drain in the background so the socket handler is never blocked on speech.
    unawaited(_drain());
  }

  Future<void> _drain() async {
    if (_draining) return;
    _draining = true;
    final generation = _generation;
    _setActive(true);
    try {
      while (_pending.isNotEmpty && generation == _generation) {
        final next = _pending.removeAt(0);
        final tag = next.languageTag;
        if (tag != null && !await _tts.canSpeak(tag)) {
          if (generation != _generation) break;
          _publish(
            VoiceSpeechSource.deviceUnavailable,
            tag,
            'Cloud voice is unavailable and this device has no voice for '
            '$tag, so NOVA cannot read the reply aloud.',
          );
          continue;
        }
        if (generation != _generation) break;
        await _tts.speak(next.text, languageTag: tag);
      }
    } catch (error) {
      debugPrint('[DeviceSpeechQueue] drain failed: $error');
    } finally {
      // A `stop()` during an `await` already reset the queue and owns the
      // active flag; only the generation that finished naturally may clear it.
      if (generation == _generation) {
        _draining = false;
        _setActive(false);
      }
    }
  }

  void _publish(VoiceSpeechSource next, String? tag, String? nextNotice) {
    if (source == next && languageTag == tag && notice == nextNotice) return;
    source = next;
    languageTag = tag;
    notice = nextNotice;
    onStateChanged?.call();
  }

  void _setActive(bool value) {
    if (_active == value) return;
    _active = value;
    onActiveChanged?.call(value);
  }
}

@immutable
class _Utterance {
  const _Utterance(this.text, this.languageTag);

  final String text;
  final String? languageTag;
}

/// The app-wide device speech engine.
final deviceTtsProvider = Provider<DeviceTts>((ref) {
  final tts = FlutterTtsDeviceTts();
  ref.onDispose(tts.dispose);
  return tts;
});
