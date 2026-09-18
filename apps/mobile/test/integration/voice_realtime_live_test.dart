@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/voice/device_tts.dart';
import 'package:nova_mobile/core/voice/voice_realtime_controller.dart';
import 'package:nova_mobile/core/voice/voice_stream_capture.dart';
import 'package:nova_mobile/core/voice/voice_streaming_playback.dart';
import 'package:nova_mobile/services/voice_stream_service.dart';

import '../core/voice/voice_realtime_test_support.dart';

/// Contract test: the **real** realtime voice client against a **real** server.
///
/// The unit tests drive the controller with synthetic frames, which proves the
/// state machine but not the wire. This one opens an actual WebSocket to
/// `ApiConfig.voiceWs`, streams actual speech at it, and asserts the client
/// surfaces what comes back — the only thing faked is the microphone and the
/// speaker, because a test runner has neither.
///
/// The audio is a real 16 kHz mono PCM WAV whose path comes from
/// `NOVA_VOICE_PCM`; generate one for the language you want to check:
///
/// ```bash
/// # any 16 kHz mono s16le WAV works
/// NOVA_LIVE_API=1 NOVA_VOICE_PCM=/tmp/ta_16k.wav \
///   flutter test --dart-define=API_URL=https://nova.leadup.in \
///   test/integration/voice_realtime_live_test.dart
/// ```
void main() {
  final live = Platform.environment['NOVA_LIVE_API'] == '1';
  final pcmPath = Platform.environment['NOVA_VOICE_PCM'];
  final language = Platform.environment['NOVA_VOICE_LANG'] ?? 'ta';
  final email =
      Platform.environment['NOVA_LIVE_EMAIL'] ?? 'admin@nova.leadup.in';
  final password =
      Platform.environment['NOVA_LIVE_PASSWORD'] ??
      'NovaOwner-eea269bd943c7a5e';

  test(
    'a spoken turn streams partials, a final and audio back to the client',
    () async {
      final pcm = _readPcm16kMono(pcmPath!);
      expect(pcm.length, greaterThan(16000), reason: 'need at least ~0.5s');

      final token = await _login(email, password);
      final capture = FakeStreamCapture();
      final playback = FakeStreamPlayback();
      // The device voice is a speaker substitute, like the fake capture is a
      // microphone substitute: a test runner has neither.
      final deviceTts = FakeDeviceTts();

      // The REAL connector and the REAL endpoint; only mic and speaker are fakes.
      final service = VoiceStreamService(
        uri: _realtimeUri(token),
        config: const VoiceReconnectConfig(
          initialDelay: Duration(milliseconds: 100),
          maxDelay: Duration(milliseconds: 400),
        ),
      );
      final container = ProviderContainer(
        overrides: [
          voiceStreamServiceProvider.overrideWithValue(service),
          voiceStreamCaptureProvider.overrideWithValue(capture),
          voiceStreamPlaybackProvider.overrideWithValue(playback),
          deviceTtsProvider.overrideWithValue(deviceTts),
        ],
      );
      addTearDown(() async {
        container.dispose();
        await service.close();
        await capture.dispose();
        await playback.dispose();
        await deviceTts.dispose();
      });

      final controller = container.read(voiceRealtimeProvider.notifier);
      final partials = <String>[];
      String? finalTurn;
      String reply = '';
      String? turnError;
      container.listen(voiceRealtimeProvider, (previous, next) {
        if (next.partial.isNotEmpty) partials.add(next.partial);
        if (next.reply.isNotEmpty) reply = next.reply;
        if (next.errorMessage != null) turnError = next.errorMessage;
        for (final commit in next.commits) {
          if (commit.user) finalTurn ??= commit.text;
        }
      });

      await controller.startTurn(language: language);
      await _pump(pcm, capture, const Duration(milliseconds: 100));
      await controller.stopTurn();

      // Wait for the reply to finish arriving and to be voiced by one engine or
      // the other.
      final deadline = DateTime.now().add(const Duration(seconds: 45));
      while (DateTime.now().isBefore(deadline)) {
        final voiced =
            playback.chunks.isNotEmpty || deviceTts.spoken.isNotEmpty;
        if (reply.isNotEmpty && voiced) break;
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }

      // ignore: avoid_print
      print(
        'partials=${partials.length} first=${partials.isEmpty ? "-" : partials.first} '
        'final=${finalTurn ?? "-"} replyChars=${reply.length} '
        'audioChunks=${playback.chunks.length} deviceWords=${deviceTts.spoken.length} '
        'error=${turnError ?? "-"}',
      );

      expect(finalTurn, isNotNull, reason: 'no final transcript came back');
      expect(finalTurn!.trim(), isNotEmpty);
      expect(partials, isNotEmpty, reason: 'no interim transcript came back');
      expect(reply, isNotEmpty, reason: 'no assistant reply came back');
      // Sarvam is out of credit, so the cloud path legitimately returns no
      // audio; the reply must then be voiced by the on-device engine. When
      // credits return, the audio half of this assertion covers the cloud path
      // again — either engine is acceptable, silence is not.
      expect(
        playback.chunks.isNotEmpty || deviceTts.spoken.isNotEmpty,
        isTrue,
        reason: 'neither cloud audio nor device speech was produced',
      );
      // The whole point of the fallback: a dead TTS provider must not turn the
      // turn into an error and throw the reply away.
      expect(turnError, isNull, reason: 'TTS_ERROR must not fail the turn');
    },
    skip: !live || pcmPath == null
        ? 'set NOVA_LIVE_API=1 and NOVA_VOICE_PCM=<16kHz mono wav>'
        : null,
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test(
    'a second utterance is understood without pressing anything again',
    () async {
      final pcm = _readPcm16kMono(pcmPath!);
      final token = await _login(email, password);
      final capture = FakeStreamCapture();
      final playback = FakeStreamPlayback();
      final deviceTts = FakeDeviceTts();

      final service = VoiceStreamService(
        uri: _realtimeUri(token),
        config: const VoiceReconnectConfig(
          initialDelay: Duration(milliseconds: 100),
          maxDelay: Duration(milliseconds: 400),
        ),
      );
      final container = ProviderContainer(
        overrides: [
          voiceStreamServiceProvider.overrideWithValue(service),
          voiceStreamCaptureProvider.overrideWithValue(capture),
          voiceStreamPlaybackProvider.overrideWithValue(playback),
          deviceTtsProvider.overrideWithValue(deviceTts),
        ],
      );
      addTearDown(() async {
        container.dispose();
        await service.close();
        await capture.dispose();
        await playback.dispose();
        await deviceTts.dispose();
      });

      final controller = container.read(voiceRealtimeProvider.notifier);
      // Counted, not deduplicated by text: this test speaks the same clip twice,
      // so identical transcripts are two turns, not one repeated commit.
      var userTurns = 0;
      var replyTurns = 0;
      container.listen(voiceRealtimeProvider, (previous, next) {
        final users = next.commits.where((c) => c.user).length;
        final replies = next.commits.length - users;
        if (users > userTurns) userTurns = users;
        if (replies > replyTurns) replyTurns = replies;
      });

      // ONE tap opens the session. Everything after this is hands-free: the
      // provider's VAD decides where each turn ends, so the user never presses
      // stop between turns.
      await controller.startTurn(language: language);
      await _pump(pcm, capture, const Duration(milliseconds: 100));
      await _awaitAtLeast(() => userTurns, 1);

      // Wait for NOVA to finish answering before speaking again, which is what
      // a person does. Talking over the reply is a different behaviour — it is
      // barge-in, and the server handles it by design.
      await _awaitAtLeast(() => replyTurns, 1);

      // Deliberately no second startTurn/stopTurn: just keep talking.
      await _pump(pcm, capture, const Duration(milliseconds: 100));
      await _awaitAtLeast(() => userTurns, 2);
      // Wait for the second answer too, or the assertion races the reply.
      await _awaitAtLeast(() => replyTurns, 2);

      // ignore: avoid_print
      print('handsFreeTurns=$userTurns replies=$replyTurns');

      expect(
        userTurns,
        greaterThanOrEqualTo(2),
        reason: 'the second utterance produced no turn — VAD did not roll over',
      );
      expect(
        replyTurns,
        greaterThanOrEqualTo(2),
        reason: 'the second utterance got no reply',
      );
    },
    skip: !live || pcmPath == null
        ? 'set NOVA_LIVE_API=1 and NOVA_VOICE_PCM=<16kHz mono wav>'
        : null,
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test(
    'speaking while NOVA talks cuts it off (barge-in)',
    () async {
      final pcm = _readPcm16kMono(pcmPath!);
      final token = await _login(email, password);
      final capture = FakeStreamCapture();
      final playback = FakeStreamPlayback();
      final deviceTts = FakeDeviceTts();

      final service = VoiceStreamService(
        uri: _realtimeUri(token),
        config: const VoiceReconnectConfig(
          initialDelay: Duration(milliseconds: 100),
          maxDelay: Duration(milliseconds: 400),
        ),
      );
      final container = ProviderContainer(
        overrides: [
          voiceStreamServiceProvider.overrideWithValue(service),
          voiceStreamCaptureProvider.overrideWithValue(capture),
          voiceStreamPlaybackProvider.overrideWithValue(playback),
          deviceTtsProvider.overrideWithValue(deviceTts),
        ],
      );
      addTearDown(() async {
        container.dispose();
        await service.close();
        await capture.dispose();
        await playback.dispose();
        await deviceTts.dispose();
      });

      final controller = container.read(voiceRealtimeProvider.notifier);
      var speakingSamples = 0;
      var stopsDuringSpeech = 0;
      var wasSpeaking = false;
      container.listen(voiceRealtimeProvider, (previous, next) {
        final speaking = next.phase == VoiceRealtimePhase.speaking;
        if (speaking) speakingSamples++;
        if (wasSpeaking && !speaking) stopsDuringSpeech++;
        wasSpeaking = speaking;
      });

      await controller.startTurn(language: language);
      await _pump(pcm, capture, const Duration(milliseconds: 100));
      await _awaitAtLeast(() => speakingSamples, 1);

      // Talk over the reply. The microphone is still open, so this reaches the
      // server, whose energy detector and provider VAD are the barge-in cue.
      await _pump(pcm, capture, const Duration(milliseconds: 100));

      final deadline = DateTime.now().add(const Duration(seconds: 20));
      while (DateTime.now().isBefore(deadline) && stopsDuringSpeech == 0) {
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }

      // ignore: avoid_print
      print('bargeInStops=$stopsDuringSpeech playbackStops=${playback.stops}');

      expect(
        stopsDuringSpeech,
        greaterThanOrEqualTo(1),
        reason: 'speaking over the reply did not interrupt it',
      );
      expect(
        playback.stops,
        greaterThanOrEqualTo(1),
        reason: 'the local player was never flushed on barge-in',
      );
    },
    skip: !live || pcmPath == null
        ? 'set NOVA_LIVE_API=1 and NOVA_VOICE_PCM=<16kHz mono wav>'
        : null,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}

/// Waits until [read] reaches [count], or gives up.
Future<void> _awaitAtLeast(int Function() read, int count) async {
  final deadline = DateTime.now().add(const Duration(seconds: 60));
  while (DateTime.now().isBefore(deadline)) {
    if (read() >= count) return;
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
}

Uri _realtimeUri(String token) {
  final base = Uri.parse(
    const String.fromEnvironment(
      'API_URL',
      defaultValue: 'https://nova.leadup.in',
    ),
  );
  return base.replace(
    scheme: base.scheme == 'https' ? 'wss' : 'ws',
    path: '/api/v1/voice/realtime',
    queryParameters: {'token': token},
  );
}

Future<String> _login(String email, String password) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse(
        '${const String.fromEnvironment('API_URL', defaultValue: 'https://nova.leadup.in')}'
        '/api/v1/auth/login',
      ),
    );
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({'email': email, 'password': password}));
    final response = await request.close();
    final body = jsonDecode(await response.transform(utf8.decoder).join());
    final token = (body['data'] ?? body)['access_token'] as String?;
    if (token == null) {
      throw StateError('login did not return an access token: $body');
    }
    return token;
  } finally {
    client.close();
  }
}

/// Streams the PCM in ~100 ms frames so the server sees live speech rather than
/// a single dump, which is what the VAD boundary depends on.
Future<void> _pump(
  Uint8List pcm,
  FakeStreamCapture capture,
  Duration frame,
) async {
  const sampleRate = 16000;
  final frameBytes = sampleRate * 2 * frame.inMilliseconds ~/ 1000;
  for (var offset = 0; offset < pcm.length; offset += frameBytes) {
    final end = (offset + frameBytes).clamp(0, pcm.length);
    capture.emit(pcm.sublist(offset, end));
    await Future<void>.delayed(frame);
  }
}

/// Reads a 16 kHz mono 16-bit WAV and returns just the PCM payload.
Uint8List _readPcm16kMono(String path) {
  final bytes = File(path).readAsBytesSync();
  if (bytes.length < 44) throw StateError('not a WAV: $path');

  var offset = 12;
  int? dataOffset;
  int? dataLength;
  int? sampleRate;
  int? channels;

  while (offset + 8 <= bytes.length) {
    final id = String.fromCharCodes(bytes.sublist(offset, offset + 4));
    final size = ByteData.sublistView(
      bytes,
      offset + 4,
      offset + 8,
    ).getUint32(0, Endian.little);
    if (id == 'fmt ') {
      channels = ByteData.sublistView(
        bytes,
        offset + 10,
        offset + 12,
      ).getUint16(0, Endian.little);
      sampleRate = ByteData.sublistView(
        bytes,
        offset + 12,
        offset + 16,
      ).getUint32(0, Endian.little);
    } else if (id == 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size.isOdd ? 1 : 0);
  }

  if (dataOffset == null || dataLength == null) {
    throw StateError('no data chunk in $path');
  }
  if (sampleRate != 16000 || channels != 1) {
    throw StateError(
      'expected 16 kHz mono, got ${sampleRate}Hz/${channels}ch — resample first',
    );
  }
  return Uint8List.sublistView(
    bytes,
    dataOffset,
    (dataOffset + dataLength).clamp(0, bytes.length),
  );
}
