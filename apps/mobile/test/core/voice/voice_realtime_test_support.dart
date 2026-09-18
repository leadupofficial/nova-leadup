import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/voice/device_tts.dart';
import 'package:nova_mobile/core/voice/voice_capture.dart';
import 'package:nova_mobile/core/voice/voice_realtime_controller.dart';
import 'package:nova_mobile/core/voice/voice_stream_capture.dart';
import 'package:nova_mobile/core/voice/voice_streaming_playback.dart';
import 'package:nova_mobile/services/voice_stream_service.dart';

/// Shared fakes for the realtime voice controller tests.
///
/// Nothing here touches a platform channel or a real socket, so the whole state
/// machine can be driven from synthetic server frames while the server side of
/// the protocol is still being built.

/// A socket whose lifecycle the test drives by hand.
class FakeVoiceSocket implements VoiceSocket {
  final StreamController<dynamic> controller =
      StreamController<dynamic>.broadcast();
  final List<dynamic> sent = <dynamic>[];
  bool closed = false;

  @override
  Stream<dynamic> get stream => controller.stream;

  @override
  void add(dynamic data) {
    if (closed) throw StateError('socket already closed');
    sent.add(data);
  }

  @override
  Future<void> close() async {
    closed = true;
    if (!controller.isClosed) await controller.close();
  }

  /// Server pushes a frame.
  void push(dynamic frame) {
    if (!controller.isClosed) controller.add(frame);
  }

  /// Simulates the server dropping the connection.
  Future<void> drop() => close();
}

class ScriptedConnector implements VoiceSocketConnector {
  final List<FakeVoiceSocket> sockets = <FakeVoiceSocket>[];
  int connectCalls = 0;

  FakeVoiceSocket get last => sockets.last;

  @override
  Future<VoiceSocket> connect(Uri uri, {Map<String, dynamic>? headers}) async {
    connectCalls++;
    final socket = FakeVoiceSocket();
    sockets.add(socket);
    return socket;
  }
}

class FakeStreamCapture implements VoiceStreamCapture {
  final StreamController<Uint8List> _frames =
      StreamController<Uint8List>.broadcast();
  final StreamController<VoiceCaptureException> _errors =
      StreamController<VoiceCaptureException>.broadcast();

  bool _streaming = false;
  int startCalls = 0;
  int stopCalls = 0;

  /// When set, [start] throws instead of opening the microphone.
  VoiceCaptureException? failWith;

  @override
  Stream<Uint8List> get frames => _frames.stream;

  @override
  Stream<VoiceCaptureException> get errors => _errors.stream;

  @override
  bool get isStreaming => _streaming;

  @override
  Future<void> start() async {
    startCalls++;
    final failure = failWith;
    if (failure != null) throw failure;
    _streaming = true;
  }

  @override
  Future<void> stop() async {
    stopCalls++;
    _streaming = false;
  }

  @override
  Future<void> dispose() async {
    await _frames.close();
    await _errors.close();
  }

  void emit(List<int> bytes) => _frames.add(Uint8List.fromList(bytes));
  void failLater(VoiceCaptureException error) => _errors.add(error);
}

class FakeStreamPlayback implements VoiceStreamPlayback {
  final StreamController<bool> _playing = StreamController<bool>.broadcast();
  final List<List<int>> chunks = <List<int>>[];
  @override
  bool isPlaying = false;
  bool _turnOpen = false;
  int beginTurns = 0;
  int endTurns = 0;
  int stops = 0;

  @override
  Stream<bool> get playingStream => _playing.stream;

  // Mirrors the real implementation's contract: one open utterance per turn, so
  // a second `sentence` must not reopen (and therefore not restart) playback.
  @override
  void beginTurn() {
    if (_turnOpen) return;
    _turnOpen = true;
    beginTurns++;
  }

  @override
  void addChunk(List<int> bytes) {
    if (!_turnOpen) throw StateError('audio chunk without an open turn');
    chunks.add(bytes);
  }

  @override
  Future<void> endTurn() async {
    _turnOpen = false;
    endTurns++;
  }

  @override
  Future<void> stop() async {
    _turnOpen = false;
    stops++;
    isPlaying = false;
  }

  int acknowledgements = 0;

  @override
  Future<void> acknowledge() async => acknowledgements++;

  @override
  Future<void> dispose() async => _playing.close();
}

class VoiceRealtimeHarness {
  VoiceRealtimeHarness({
    FakeStreamCapture? capture,
    FakeStreamPlayback? playback,
    FakeDeviceTts? deviceTts,
  }) {
    this.capture = capture ?? FakeStreamCapture();
    this.playback = playback ?? FakeStreamPlayback();
    this.deviceTts = deviceTts ?? FakeDeviceTts();
    service = VoiceStreamService(
      uri: Uri.parse('ws://localhost:3001/api/v1/voice/realtime?token=t'),
      connector: connector,
      config: const VoiceReconnectConfig(
        initialDelay: Duration(milliseconds: 5),
        maxDelay: Duration(milliseconds: 20),
      ),
    );
    container = ProviderContainer(
      overrides: [
        voiceStreamServiceProvider.overrideWithValue(service),
        voiceStreamCaptureProvider.overrideWithValue(this.capture),
        voiceStreamPlaybackProvider.overrideWithValue(this.playback),
        deviceTtsProvider.overrideWithValue(this.deviceTts),
      ],
    );
    controller = container.read(voiceRealtimeProvider.notifier);
  }

  final ScriptedConnector connector = ScriptedConnector();
  late final FakeStreamCapture capture;
  late final FakeStreamPlayback playback;
  late final FakeDeviceTts deviceTts;
  late final VoiceStreamService service;
  late final ProviderContainer container;
  late final VoiceRealtimeController controller;

  VoiceRealtimeState get state => container.read(voiceRealtimeProvider);

  FakeVoiceSocket get socket => connector.last;

  /// The control frames (not raw PCM) the client wrote, as decoded maps.
  List<Map<String, dynamic>> get controlFrames => socket.sent
      .whereType<String>()
      .map((frame) => jsonDecode(frame) as Map<String, dynamic>)
      .toList();

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    container.dispose();
    await service.close();
    await capture.dispose();
    await playback.dispose();
    await deviceTts.dispose();
  }

  bool _disposed = false;
}

/// A device speech engine that records what it was asked to say.
class FakeDeviceTts implements DeviceTts {
  FakeDeviceTts({Set<String> unsupported = const <String>{}})
    : unsupported = <String>{...unsupported};

  /// BCP-47 tags this "device" has no voice for. Growable, so a test can add
  /// one after construction.
  final Set<String> unsupported;

  /// Every utterance, in the order it was spoken.
  final List<String> spoken = <String>[];

  /// The language each utterance was spoken in, index-aligned with [spoken].
  final List<String?> spokenLanguages = <String?>[];

  /// When set, a spoken utterance stays in flight until this completes, so a
  /// test can observe the turn while the device engine is still talking.
  Completer<void>? hold;

  int stops = 0;
  int disposes = 0;

  @override
  Future<bool> canSpeak(String? languageTag) async =>
      languageTag == null || !unsupported.contains(languageTag);

  @override
  Future<void> speak(String text, {String? languageTag}) async {
    spoken.add(text);
    spokenLanguages.add(languageTag);
    await hold?.future;
  }

  @override
  Future<void> stop() async => stops++;

  @override
  Future<void> dispose() async => disposes++;
}

/// Lets pending microtasks and one short timer tick run.
Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 2));
