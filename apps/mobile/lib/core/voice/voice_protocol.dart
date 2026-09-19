import 'dart:convert';
import 'dart:typed_data';

/// Frames the realtime voice server sends over `/api/v1/voice/realtime`.
///
/// The protocol is frozen and shared with the server team, so this file is the
/// single translation point between raw socket frames and typed events. Nothing
/// here touches Flutter, audio or networking, which makes the decoding rules
/// unit-testable against synthetic frames while the server is still being built.
sealed class VoiceServerEvent {
  const VoiceServerEvent();
}

/// `{"type":"ready"}` — the socket accepted the token and can take a turn.
final class VoiceReadyEvent extends VoiceServerEvent {
  const VoiceReadyEvent();
}

/// `{"type":"partial","text":"..."}` — provisional transcript, still speaking.
final class VoicePartialEvent extends VoiceServerEvent {
  const VoicePartialEvent(this.text);
  final String text;
}

/// `{"type":"final","text":"..."}` — the user's completed turn.
final class VoiceFinalEvent extends VoiceServerEvent {
  const VoiceFinalEvent(this.text);
  final String text;
}

/// `{"type":"token","text":"..."}` — one LLM delta.
final class VoiceTokenEvent extends VoiceServerEvent {
  const VoiceTokenEvent(this.text);
  final String text;
}

/// `{"type":"sentence","text":"...","index":N}` — a sentence handed to TTS.
final class VoiceSentenceEvent extends VoiceServerEvent {
  const VoiceSentenceEvent(this.text, this.index);
  final String text;
  final int index;
}

/// A binary frame: one MP3 chunk of the sentence currently being spoken.
final class VoiceAudioEvent extends VoiceServerEvent {
  const VoiceAudioEvent(this.bytes);
  final Uint8List bytes;
}

/// `{"type":"speaking","value":true|false}`.
final class VoiceSpeakingEvent extends VoiceServerEvent {
  const VoiceSpeakingEvent(this.value);
  final bool value;
}

/// `{"type":"done","text":"<full reply>"}`.
final class VoiceDoneEvent extends VoiceServerEvent {
  const VoiceDoneEvent(this.text);
  final String text;
}

/// `{"type":"error","code":"...","message":"..."}`.
final class VoiceServerErrorEvent extends VoiceServerEvent {
  const VoiceServerErrorEvent({required this.code, required this.message});
  final String code;
  final String message;
}

/// `{"type":"stt","provider":"deepgram","fallback":true,"reason":"..."}`.
///
/// Emitted when the recogniser named for the language could not serve the turn
/// and a backup is transcribing instead. The server says so honestly, and the UI
/// shows it: a turn that succeeded on a fallback should not look identical to one
/// that used the provider it was supposed to.
final class VoiceSttFallbackEvent extends VoiceServerEvent {
  const VoiceSttFallbackEvent({
    required this.provider,
    required this.fallback,
    required this.reason,
  });
  final String provider;
  final bool fallback;
  final String reason;
}

/// `{"type":"tts","provider":"deepgram","fallback":true,"reason":"..."}`.
///
/// The speech-side counterpart of [VoiceSttFallbackEvent]: the voice the user is
/// hearing is not the one the language nominally selects.
final class VoiceTtsFallbackEvent extends VoiceServerEvent {
  const VoiceTtsFallbackEvent({
    required this.provider,
    required this.fallback,
    required this.reason,
  });
  final String provider;
  final bool fallback;
  final String reason;
}

/// `{"type":"tool","name":"create_reminder","ok":true,"summary":"..."}`.
///
/// A write tool ran during this turn. Surfaced because a voice user who says
/// "remind me" otherwise gets no sign that anything was recorded until the reply
/// finishes — and the reply can take seconds.
final class VoiceToolEvent extends VoiceServerEvent {
  const VoiceToolEvent({
    required this.name,
    required this.ok,
    required this.summary,
  });
  final String name;
  final bool ok;

  /// The server's one-line statement of what happened, e.g.
  /// `Reminder "Buy milk" set for Sun 20 Sept, 06:00 pm (Asia/Kolkata).`
  final String summary;
}

/// A well-formed frame with a `type` this client build does not know.
///
/// Ignored by the controller rather than treated as a failure: the server may
/// add event types that an older client must keep working through.
final class VoiceUnknownEvent extends VoiceServerEvent {
  const VoiceUnknownEvent(this.type);
  final String type;
}

/// A frame that could not be interpreted at all (bad JSON, wrong shape).
class VoiceProtocolException implements Exception {
  const VoiceProtocolException(this.message, {this.cause});

  final String message;
  final Object? cause;

  @override
  String toString() => 'VoiceProtocolException: $message';
}

/// Turns raw WebSocket frames into [VoiceServerEvent]s.
class VoiceProtocolDecoder {
  const VoiceProtocolDecoder();

  /// Decodes one frame.
  ///
  /// Throws [VoiceProtocolException] for anything that is neither a binary
  /// audio frame nor a JSON object with a `type`. A decoder that silently
  /// produced `null` would hide a real protocol drift.
  VoiceServerEvent decode(Object? frame) {
    if (frame is Uint8List) return VoiceAudioEvent(frame);
    if (frame is List<int>) return VoiceAudioEvent(Uint8List.fromList(frame));

    if (frame is! String) {
      throw VoiceProtocolException(
        'Unsupported frame of type ${frame.runtimeType}; '
        'expected text or binary.',
      );
    }

    final Object? decoded;
    try {
      decoded = jsonDecode(frame);
    } catch (error) {
      throw VoiceProtocolException('Frame is not valid JSON.', cause: error);
    }
    if (decoded is! Map) {
      throw const VoiceProtocolException(
        'Frame is JSON but not an object with a "type".',
      );
    }

    final map = <String, Object?>{};
    for (final entry in decoded.entries) {
      map[entry.key.toString()] = entry.value;
    }

    final type = map['type']?.toString() ?? '';
    return switch (type) {
      'ready' => const VoiceReadyEvent(),
      'partial' => VoicePartialEvent(_string(map['text'])),
      'final' => VoiceFinalEvent(_string(map['text'])),
      'token' => VoiceTokenEvent(_string(map['text'])),
      'sentence' => VoiceSentenceEvent(
        _string(map['text']),
        _int(map['index']),
      ),
      'speaking' => VoiceSpeakingEvent(map['value'] == true),
      'tool' => VoiceToolEvent(
        name: map['name']?.toString() ?? 'unknown',
        ok: map['ok'] == true,
        summary: map['summary']?.toString() ?? '',
      ),
      'stt' => VoiceSttFallbackEvent(
        provider: map['provider']?.toString() ?? 'unknown',
        fallback: map['fallback'] == true,
        reason: map['reason']?.toString() ?? '',
      ),
      'tts' => VoiceTtsFallbackEvent(
        provider: map['provider']?.toString() ?? 'unknown',
        fallback: map['fallback'] == true,
        reason: map['reason']?.toString() ?? '',
      ),
      'done' => VoiceDoneEvent(_string(map['text'])),
      'error' => VoiceServerErrorEvent(
        code: map['code']?.toString() ?? 'unknown',
        message: map['message']?.toString() ?? 'The voice server reported an error.',
      ),
      _ => VoiceUnknownEvent(type),
    };
  }

  static String _string(Object? value) => value?.toString() ?? '';

  static int _int(Object? value) {
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }
}

/// Encodes the client → server control frames.
///
/// Kept next to the decoder so both halves of the frozen protocol are defined
/// in one place and a test can assert the exact wire shape.
class VoiceProtocolEncoder {
  const VoiceProtocolEncoder();

  /// `{"type":"start","language":"<code>"}`.
  String start({required String language}) =>
      jsonEncode(<String, Object?>{'type': 'start', 'language': language});

  /// `{"type":"stop"}`.
  String stop() => jsonEncode(<String, Object?>{'type': 'stop'});

  /// `{"type":"cancel"}`.
  String cancel() => jsonEncode(<String, Object?>{'type': 'cancel'});

  /// `{"type":"text","text":"..."}`.
  String text(String text) =>
      jsonEncode(<String, Object?>{'type': 'text', 'text': text});
}

/// The bare language codes the frozen protocol accepts in `start`.
const Set<String> kVoiceProtocolLanguages = <String>{'en', 'ta', 'hi', 'auto'};

/// Maps a `NovaAvatarPrefs.languagePolicy` onto a protocol language code.
///
/// The persona setting also carries app-only policies such as `tanglish`,
/// which has no wire code: those fall back to `auto` so the server detects the
/// language itself instead of the client inventing one.
String normalizeVoiceLanguage(String? languagePolicy) {
  final value = (languagePolicy ?? 'auto').trim().toLowerCase();
  return kVoiceProtocolLanguages.contains(value) ? value : 'auto';
}
