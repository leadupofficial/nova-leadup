@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
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
      Platform.environment['NOVA_LIVE_PASSWORD'] ?? 'NovaOwner-eea269bd943c7a5e';

  test(
    'a spoken turn streams partials, a final and audio back to the client',
    () async {
      final pcm = _readPcm16kMono(pcmPath!);
      expect(pcm.length, greaterThan(16000), reason: 'need at least ~0.5s');

      final token = await _login(email, password);
      final capture = FakeStreamCapture();
      final playback = FakeStreamPlayback();

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
        ],
      );
      addTearDown(() async {
        container.dispose();
        await service.close();
        await capture.dispose();
        await playback.dispose();
      });

      final controller = container.read(voiceRealtimeProvider.notifier);
      final partials = <String>[];
      String? finalTurn;
      String reply = '';
      container.listen(voiceRealtimeProvider, (previous, next) {
        if (next.partial.isNotEmpty) partials.add(next.partial);
        if (next.reply.isNotEmpty) reply = next.reply;
        for (final commit in next.commits) {
          if (commit.user) finalTurn ??= commit.text;
        }
      });

      await controller.startTurn(language: language);
      await _pump(pcm, capture, const Duration(milliseconds: 100));
      await controller.stopTurn();

      // Wait for the reply to finish arriving.
      final deadline = DateTime.now().add(const Duration(seconds: 45));
      while (DateTime.now().isBefore(deadline)) {
        if (reply.isNotEmpty && playback.chunks.isNotEmpty) break;
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }

      // ignore: avoid_print
      print('partials=${partials.length} first=${partials.isEmpty ? "-" : partials.first} '
          'final=${finalTurn ?? "-"} replyChars=${reply.length} '
          'audioChunks=${playback.chunks.length}');

      expect(finalTurn, isNotNull, reason: 'no final transcript came back');
      expect(finalTurn!.trim(), isNotEmpty);
      expect(partials, isNotEmpty, reason: 'no interim transcript came back');
      expect(reply, isNotEmpty, reason: 'no assistant reply came back');
      expect(
        playback.chunks,
        isNotEmpty,
        reason: 'no audio was streamed back for playback',
      );
      expect(
        playback.chunks.fold<int>(0, (sum, c) => sum + c.length),
        greaterThan(1000),
        reason: 'audio came back but was suspiciously small',
      );
    },
    skip: !live || pcmPath == null
        ? 'set NOVA_LIVE_API=1 and NOVA_VOICE_PCM=<16kHz mono wav>'
        : null,
    timeout: const Timeout(Duration(minutes: 2)),
  );
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
