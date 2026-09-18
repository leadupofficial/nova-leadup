import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Whether wake word detection can run on this device, and why not when it cannot.
@immutable
class WakeWordAvailability {
  const WakeWordAvailability({
    required this.available,
    required this.reason,
    this.detail,
    this.models = const <String>[],
  });

  final bool available;

  /// Machine-readable reason, mirroring the native `availability` method:
  /// `ok`, `unsupported_platform`, `missing_shared_models`, `no_wake_word_model`.
  final String reason;

  final String? detail;

  /// Names of the installed wake words, e.g. `['hey_jarvis']`.
  final List<String> models;

  static const WakeWordAvailability unsupportedPlatform = WakeWordAvailability(
    available: false,
    reason: 'unsupported_platform',
    detail: 'Wake word detection is currently implemented for Android only.',
  );

  factory WakeWordAvailability.fromMap(Map<dynamic, dynamic> map) {
    final rawModels = map['models'];
    return WakeWordAvailability(
      available: map['available'] == true,
      reason: (map['reason'] ?? 'unknown').toString(),
      detail: map['detail']?.toString(),
      models: rawModels is List
          ? rawModels.map((dynamic value) => value.toString()).toList(growable: false)
          : const <String>[],
    );
  }

  /// A message suitable for display to the user.
  String get userMessage {
    switch (reason) {
      case 'ok':
        return models.isEmpty
            ? 'Wake word is available.'
            : 'Listening for ${models.join(" or ")}.';
      case 'unsupported_platform':
        return 'Wake word detection is not available on this platform yet.';
      case 'missing_shared_models':
        return 'The wake word models are missing from this build.';
      case 'no_wake_word_model':
        return 'No wake word is installed in this build.';
      case 'permission_denied':
        return 'NOVA needs microphone and notification access to listen for the wake word.';
      default:
        return detail ?? 'Wake word detection is unavailable.';
    }
  }
}

/// Events pushed from the native wake word service.
sealed class WakeWordEvent {
  const WakeWordEvent();
}

class WakeWordListening extends WakeWordEvent {
  const WakeWordListening({this.models = const <String>[]});
  final List<String> models;
}

class WakeWordStopped extends WakeWordEvent {
  const WakeWordStopped();
}

class WakeWordServiceStateChanged extends WakeWordEvent {
  const WakeWordServiceStateChanged({required this.running});
  final bool running;
}

class WakeWordDetected extends WakeWordEvent {
  const WakeWordDetected({required this.name, required this.score, required this.at});
  final String name;
  final double score;
  final DateTime at;
}

class WakeWordFailure extends WakeWordEvent {
  const WakeWordFailure({required this.code, required this.message});
  final String code;
  final String message;
}

/// Platform boundary for wake word detection. Swapped out in tests.
abstract interface class WakeWordPlatform {
  Future<WakeWordAvailability> availability();

  Future<bool> start();

  Future<bool> stop();

  Future<bool> isRunning();

  Stream<WakeWordEvent> get events;
}

/// Talks to `WakeWordService.kt` over the `nova/wake_word` channels.
class MethodChannelWakeWordPlatform implements WakeWordPlatform {
  static const MethodChannel _methodChannel = MethodChannel('nova/wake_word');
  static const EventChannel _eventChannel = EventChannel('nova/wake_word/events');

  Stream<WakeWordEvent>? _events;

  @override
  Stream<WakeWordEvent> get events {
    return _events ??= _eventChannel
        .receiveBroadcastStream()
        .map(_decode)
        .where((WakeWordEvent? event) => event != null)
        .cast<WakeWordEvent>();
  }

  @override
  Future<WakeWordAvailability> availability() async {
    try {
      final result = await _methodChannel.invokeMethod<dynamic>('availability');
      if (result is Map) return WakeWordAvailability.fromMap(result);
      return const WakeWordAvailability(
        available: false,
        reason: 'unknown',
        detail: 'The native layer returned no availability information.',
      );
    } on PlatformException catch (error) {
      return WakeWordAvailability(
        available: false,
        reason: 'platform_error',
        detail: error.message,
      );
    } on MissingPluginException {
      return WakeWordAvailability.unsupportedPlatform;
    }
  }

  @override
  Future<bool> start() async {
    try {
      return await _methodChannel.invokeMethod<bool>('start') ?? false;
    } on PlatformException catch (error) {
      debugPrint('[WakeWord] start failed: ${error.message}');
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<bool> stop() async {
    try {
      return await _methodChannel.invokeMethod<bool>('stop') ?? false;
    } on PlatformException catch (error) {
      debugPrint('[WakeWord] stop failed: ${error.message}');
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<bool> isRunning() async {
    try {
      return await _methodChannel.invokeMethod<bool>('isRunning') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  WakeWordEvent? _decode(dynamic raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    switch (map['type']) {
      case 'listening':
        final models = map['models'];
        return WakeWordListening(
          models: models is List
              ? models.map((dynamic value) => value.toString()).toList(growable: false)
              : const <String>[],
        );
      case 'stopped':
        return const WakeWordStopped();
      case 'state':
        return WakeWordServiceStateChanged(running: map['running'] == true);
      case 'detected':
        return WakeWordDetected(
          name: (map['name'] ?? 'unknown').toString(),
          score: (map['score'] as num?)?.toDouble() ?? 0,
          at: DateTime.fromMillisecondsSinceEpoch(
            (map['ts'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
          ),
        );
      case 'error':
        return WakeWordFailure(
          code: (map['code'] ?? 'unknown').toString(),
          message: (map['message'] ?? 'Unknown wake word error').toString(),
        );
      default:
        return null;
    }
  }
}

/// Used on platforms without a native implementation, and in tests.
class UnsupportedWakeWordPlatform implements WakeWordPlatform {
  const UnsupportedWakeWordPlatform();

  @override
  Future<WakeWordAvailability> availability() async => WakeWordAvailability.unsupportedPlatform;

  @override
  Future<bool> start() async => false;

  @override
  Future<bool> stop() async => false;

  @override
  Future<bool> isRunning() async => false;

  @override
  Stream<WakeWordEvent> get events => const Stream<WakeWordEvent>.empty();
}
