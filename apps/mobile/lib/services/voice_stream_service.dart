import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Connection lifecycle for the voice streaming socket.
enum VoiceStreamStatus {
  disconnected,
  connecting,
  connected,
  reconnecting,
  closed,
}

/// Reconnect policy: exponential backoff with jitter, capped.
@immutable
class VoiceReconnectConfig {
  const VoiceReconnectConfig({
    this.initialDelay = const Duration(milliseconds: 500),
    this.maxDelay = const Duration(seconds: 30),
    this.multiplier = 2.0,
    this.jitter = 0.2,
    this.maxAttempts = 0,
  });

  /// A value of 0 for [maxAttempts] means "retry until explicitly closed".
  final int maxAttempts;
  final Duration initialDelay;
  final Duration maxDelay;
  final double multiplier;

  /// Fraction of the computed delay to randomise, 0.0-1.0.
  final double jitter;

  /// Delay before attempt number [attempt] (0-based).
  Duration computeDelay(int attempt, {Random? random}) {
    if (attempt <= 0) return initialDelay;
    final exponentialMs = initialDelay.inMilliseconds * pow(multiplier, attempt);
    final rng = random ?? Random();
    final jitterFraction = (rng.nextDouble() * 2 - 1) * jitter;
    final totalMs = exponentialMs * (1 + jitterFraction);
    return Duration(
      milliseconds: totalMs.round().clamp(0, maxDelay.inMilliseconds),
    );
  }
}

/// A live socket. Abstracted so the reconnect logic is testable without a network.
abstract interface class VoiceSocket {
  Stream<dynamic> get stream;
  void add(dynamic data);
  Future<void> close();
}

/// Opens sockets. The default implementation uses `web_socket_channel`.
abstract interface class VoiceSocketConnector {
  Future<VoiceSocket> connect(Uri uri, {Map<String, dynamic>? headers});
}

class _ChannelVoiceSocket implements VoiceSocket {
  _ChannelVoiceSocket(this._channel);

  final WebSocketChannel _channel;

  @override
  Stream<dynamic> get stream => _channel.stream;

  @override
  void add(dynamic data) => _channel.sink.add(data);

  @override
  Future<void> close() async => _channel.sink.close();
}

class DefaultVoiceSocketConnector implements VoiceSocketConnector {
  const DefaultVoiceSocketConnector();

  /// Connects using the native dart:io WebSocket so we can pass the
  /// authorization header instead of putting the token in the query string.
  ///
  /// Query-string tokens appear in server logs, proxy logs, and HTTP
  /// referrer headers. Moving the token to an `Authorization` header keeps
  /// it out of the URL entirely. The server side (`realtime/index.ts`) checks
  /// both the `token` query parameter and the `Authorization` header, so
  /// removing the query parameter does not break any deployment.
  @override
  Future<VoiceSocket> connect(Uri uri, {Map<String, dynamic>? headers}) async {
    final wsHeaders = <String, String>{};
    if (headers != null) {
      for (final entry in headers.entries) {
        if (entry.value is String) {
          wsHeaders[entry.key] = entry.value as String;
        }
      }
    }

    // Strip the token query parameter: the bearer is now in the header.
    final uriWithoutToken = uri.replace(queryParameters: <String, String>{});

    final channel = IOWebSocketChannel.connect(
      uriWithoutToken,
      headers: wsHeaders,
    );
    return _ChannelVoiceSocket(channel);
  }
}

/// A reconnecting WebSocket client for real-time voice streaming.
///
/// `NetworkService` only retries plain HTTP requests. The voice socket had no
/// reconnect logic at all: any dropped connection (network handover, app backgrounded,
/// server restart) ended the session silently and permanently. This adds automatic
/// reconnection with exponential backoff and jitter, so a brief drop is invisible and
/// a sustained outage is reported through [statuses] and [errors].
class VoiceStreamService {
  VoiceStreamService({
    Uri? uri,
    this.uriResolver,
    this.connector = const DefaultVoiceSocketConnector(),
    this.config = const VoiceReconnectConfig(),
    this.headers,
    this.headersResolver,
  }) : assert(
         uri != null || uriResolver != null,
         'VoiceStreamService needs either a fixed uri or a uriResolver.',
       ),
       _uri = uri;

  final Uri? _uri;

  /// Resolves the connection URI at *each* attempt instead of once at
  /// construction.
  ///
  /// The access token is a query parameter and expires after 15 minutes, so a
  /// URI captured at construction time would make every reconnect after that
  /// point fail authentication forever. Supplying a resolver means a reconnect
  /// (and the first connect) always carries the current token.
  final Uri Function()? uriResolver;

  final VoiceSocketConnector connector;
  final VoiceReconnectConfig config;
  final Map<String, dynamic>? headers;
  final Map<String, dynamic> Function()? headersResolver;

  /// Resolved headers for the next connection attempt, refreshed on each
  /// connect so that short-lived bearer tokens are always current.
  Map<String, dynamic>? get resolvedHeaders => headersResolver?.call() ?? headers;

  /// The URI used for the next connection attempt.
  Uri get uri => uriResolver?.call() ?? _uri!;

  final StreamController<dynamic> _messages = StreamController<dynamic>.broadcast();
  final StreamController<VoiceStreamStatus> _statuses =
      StreamController<VoiceStreamStatus>.broadcast();
  final StreamController<Object> _errors = StreamController<Object>.broadcast();

  VoiceSocket? _socket;
  StreamSubscription<dynamic>? _subscription;
  Timer? _retryTimer;
  int _attempt = 0;
  bool _closed = false;
  bool _connecting = false;
  VoiceStreamStatus _status = VoiceStreamStatus.disconnected;

  /// Incoming server frames.
  Stream<dynamic> get messages => _messages.stream;

  /// Connection lifecycle transitions.
  Stream<VoiceStreamStatus> get statuses => _statuses.stream;

  /// Errors from failed connection attempts.
  Stream<Object> get errors => _errors.stream;

  VoiceStreamStatus get status => _status;

  bool get isConnected => _status == VoiceStreamStatus.connected;

  /// Number of consecutive failed attempts since the last successful connect.
  int get attempt => _attempt;

  /// Opens the socket, reconnecting automatically until [close] is called.
  Future<void> connect() async {
    if (_closed || _connecting || isConnected) return;
    await _open(isReconnect: false);
  }

  Future<void> _open({required bool isReconnect}) async {
    _connecting = true;
    _setStatus(
      isReconnect ? VoiceStreamStatus.reconnecting : VoiceStreamStatus.connecting,
    );

    try {
      final socket = await connector.connect(uri, headers: resolvedHeaders);
      if (_closed) {
        await socket.close();
        return;
      }

      _socket = socket;
      _subscription = socket.stream.listen(
        _messages.add,
        onError: (Object error) {
          _errors.add(error);
          _scheduleReconnect();
        },
        onDone: _scheduleReconnect,
        cancelOnError: false,
      );

      _attempt = 0;
      _setStatus(VoiceStreamStatus.connected);
    } catch (error) {
      _errors.add(error);
      _scheduleReconnect();
    } finally {
      _connecting = false;
    }
  }

  void _scheduleReconnect() {
    if (_closed) return;

    unawaited(_teardownSocket());

    if (config.maxAttempts > 0 && _attempt >= config.maxAttempts) {
      _setStatus(VoiceStreamStatus.disconnected);
      return;
    }

    final delay = config.computeDelay(_attempt);
    _attempt++;
    _setStatus(VoiceStreamStatus.reconnecting);

    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () {
      unawaited(_open(isReconnect: true));
    });
  }

  /// Sends a frame. Returns false when the socket is not currently connected, so the
  /// caller can drop rather than silently buffer stale audio.
  bool send(dynamic data) {
    if (!isConnected || _socket == null) return false;
    try {
      _socket!.add(data);
      return true;
    } catch (error) {
      _errors.add(error);
      _scheduleReconnect();
      return false;
    }
  }

  /// Permanently closes the stream and cancels any pending reconnect.
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    await _teardownSocket();
    _setStatus(VoiceStreamStatus.closed);
    await _messages.close();
    await _statuses.close();
    await _errors.close();
  }

  Future<void> _teardownSocket() async {
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();

    final socket = _socket;
    _socket = null;
    try {
      await socket?.close();
    } catch (_) {
      // Closing an already-broken socket is not interesting.
    }
  }

  void _setStatus(VoiceStreamStatus status) {
    if (_status == status) return;
    _status = status;
    if (!_statuses.isClosed) _statuses.add(status);
  }
}
