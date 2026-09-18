import 'dart:async';

import 'device_tts.dart';
import 'voice_realtime_state.dart';

/// The on-device TTS fallback for one realtime turn.
///
/// The cloud provider can fail mid-turn (`TTS_ERROR`). Rather than throwing the
/// reply away, the controller hands every sentence here; this object speaks it
/// through the platform engine, keeps the UI's engine/notice state honest, and
/// holds the turn open until the device has actually finished talking.
///
/// [read]/[write] are the controller's state accessors. Everything this
/// fallback changes — which voice is speaking, the explanation notice, whether
/// the phase may fall back to `listening` — is visible state, so centralising
/// it here keeps the controller's event switch about events rather than
/// synthesiser bookkeeping.
class VoiceDeviceFallback {
  VoiceDeviceFallback({
    required DeviceTts tts,
    required this.read,
    required this.write,
    required this.cloudPlaying,
  }) {
    _queue = DeviceSpeechQueue(tts)
      ..onActiveChanged = _onActiveChanged
      ..onStateChanged = _publish;
  }

  late final DeviceSpeechQueue _queue;

  /// The controller's state accessors: the fallback's effects are visible
  /// state, so it reads and writes the turn directly rather than passing a
  /// result back through the event switch.
  final VoiceRealtimeState Function() read;
  final void Function(VoiceRealtimeState) write;
  final bool Function() cloudPlaying;

  String _languagePolicy = 'auto';

  /// True while `done` has committed the reply but the device engine is still
  /// reading it out, so the phase must stay `speaking`.
  bool _heldTurn = false;

  /// True once this turn has switched to device speech.
  bool get isDeviceEnabled => _queue.isDeviceEnabled;

  /// True while an utterance is queued or being spoken.
  bool get isActive => _queue.isActive;

  /// Starts a new reply under [languagePolicy] (a `NovaAvatarPrefs` value),
  /// forgetting the previous turn entirely.
  void beginTurn(String languagePolicy) {
    _languagePolicy = languagePolicy;
    _heldTurn = false;
    _queue.resetTurn();
  }

  /// Records a sentence, speaking it immediately once the fallback is on.
  ///
  /// Every sentence is recorded because the server emits the first one *before*
  /// cloud synthesis fails; [enable] replays the ones already seen.
  void record(String sentence) {
    _queue.record(
      sentence,
      languageTag: resolveDeviceLanguageTag(
        languagePolicy: _languagePolicy,
        text: sentence,
      ),
    );
  }

  /// Switches this reply to the device engine, replaying recorded sentences.
  void enable() => _queue.enableDevice();

  /// Records that cloud audio arrived for sentence [sentenceIndex], so the
  /// fallback never repeats a sentence the cloud already voiced.
  void noteCloudAudio(int sentenceIndex) =>
      _queue.noteCloudAudio(sentenceIndex);

  /// Keeps the phase at `speaking` until the device engine finishes. Called
  /// when `done` arrives mid-utterance.
  void holdTurn() => _heldTurn = true;

  /// Silences the device engine and forgets the held turn. Idempotent.
  Future<void> stop() async {
    _heldTurn = false;
    await _queue.stop();
  }

  Future<void> dispose() => _queue.stop();

  /// Mirrors the queue's engine/notice state into the turn's visible state.
  void _publish() {
    write(
      read().copyWith(
        speechSource: _queue.source,
        deviceLanguageTag: _queue.languageTag,
        speechNotice: _queue.notice,
        // `copyWith` cannot null a field, so a reset turn clears both.
        clearSpeechNotice: _queue.notice == null,
      ),
    );
  }

  void _onActiveChanged(bool active) {
    final wasHeld = _heldTurn;
    if (!active) _heldTurn = false;
    final current = read();
    write(
      current.copyWith(
        // Device speech and cloud playback are the two ways NOVA can be
        // audible; whichever is live decides the flag.
        audible: active || cloudPlaying(),
        phase: (!active && wasHeld)
            ? (current.micActive
                  ? VoiceRealtimePhase.listening
                  : VoiceRealtimePhase.idle)
            : null,
      ),
    );
  }
}
