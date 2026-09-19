import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'call_recording_models.dart';

/// The platform boundary for reading the user's own call-recording folder.
/// Swapped out in tests.
///
/// Mirrors `NotificationAssistantPlatform` and `DeviceControlPlatform`: one
/// interface, one Android `MethodChannel` implementation, and an unsupported
/// fallback that reports `supported: false` so the screen explains itself
/// instead of offering a picker that could never open.
///
/// ## The whole feature is three calls, and none of them scans
///
///  * [pickFolder] — the user chooses a folder in the system picker and the
///    grant is made durable. Nothing is read first.
///  * [listFiles] — the audio files in **that** folder. Never a recursive walk,
///    never a location NOVA guessed, never a file the user did not point at.
///  * [readAudio] — the bytes of one file the user selected on screen.
///
/// There is no method here that could record a call, listen to one, or read the
/// call log, because Android does not permit the first two and Google Play
/// restricts the third to default dialers.
abstract interface class CallRecordingPlatform {
  /// Always succeeds on Android; `supported: false` elsewhere.
  Future<CallRecordingCode> status();

  /// Opens the system folder picker and answers when the user has chosen or
  /// dismissed it. The grant is persisted with
  /// `takePersistableUriPermission`, so it survives a restart.
  Future<CallRecordingPickResult> pickFolder({String? suggestedTreeUri});

  /// Whether the persisted grant for [treeUri] is still usable, and the audio
  /// files inside it.
  Future<CallRecordingListing> listFiles(String treeUri);

  /// The bytes of one file.
  ///
  /// [maxBytes] applies the server's own ceiling to a local file before anything
  /// is read; the native side also refuses anything above its hard limit.
  Future<CallRecordingBytes> readAudio(String uri, {int? maxBytes});

  /// Forgets the grant in this process. Android's persisted permission is the
  /// user's to revoke; this only drops NOVA's stored URI.
  Future<void> clearFolder();

  Future<void> dispose();
}

/// Talks to `NovaCallRecordingFolder.kt` over the
/// `nova/call_recording_folder` channel, following the same `MethodChannel`
/// shape as the notifications and device-control platforms.
class MethodChannelCallRecordingPlatform implements CallRecordingPlatform {
  static const MethodChannel _channel = MethodChannel(
    'nova/call_recording_folder',
  );

  /// The exact channel name, so a contract test can assert Dart and Kotlin agree.
  static const String channelName = 'nova/call_recording_folder';

  /// The hard ceiling the Kotlin half enforces. Mirrored here so the UI can
  /// refuse an oversized file before the channel is even called.
  static const int maxReadableBytes = 64 * 1024 * 1024;

  @override
  Future<CallRecordingCode> status() async {
    try {
      final result = await _channel.invokeMethod<dynamic>('status');
      if (result is Map) {
        return CallRecordingCode.fromWire(result['code']);
      }
      return CallRecordingCode.unsupported;
    } on MissingPluginException {
      return CallRecordingCode.unsupported;
    } on PlatformException {
      return CallRecordingCode.failed;
    }
  }

  @override
  Future<CallRecordingPickResult> pickFolder({String? suggestedTreeUri}) async {
    try {
      final result = await _channel.invokeMethod<dynamic>('pickFolder', {
        'suggestedName': suggestedTreeUri,
      });
      if (result is Map) return CallRecordingPickResult.fromMap(result);
      return const CallRecordingPickResult(
        code: CallRecordingCode.failed,
        message:
            'Android returned no answer for the folder picker, so no folder was '
            'granted.',
      );
    } on MissingPluginException {
      return const CallRecordingPickResult(
        code: CallRecordingCode.unsupported,
        message:
            'This build has no Android folder picker, so NOVA cannot be pointed '
            'at a call-recording folder.',
      );
    } on PlatformException catch (error) {
      // The native handler answers refusals as results, never as exceptions, so
      // reaching here means the channel itself broke.
      return CallRecordingPickResult(
        code: CallRecordingCode.failed,
        message:
            'The folder could not be chosen: '
            '${error.message ?? 'Android refused the request'}. Nothing was read.',
      );
    }
  }

  @override
  Future<CallRecordingListing> listFiles(String treeUri) async {
    try {
      final result = await _channel.invokeMethod<dynamic>('listFiles', {
        'treeUri': treeUri,
      });
      if (result is Map) return CallRecordingListing.fromMap(result);
      return const CallRecordingListing(
        code: CallRecordingCode.failed,
        message: 'Android returned no file list for that folder.',
      );
    } on MissingPluginException {
      return const CallRecordingListing(
        code: CallRecordingCode.unsupported,
        message: 'This build cannot list files from a folder.',
      );
    } on PlatformException catch (error) {
      return CallRecordingListing(
        code: CallRecordingCode.unreadable,
        message:
            'That folder could not be read: '
            '${error.message ?? 'Android refused the read'}.',
      );
    }
  }

  @override
  Future<CallRecordingBytes> readAudio(String uri, {int? maxBytes}) async {
    try {
      final result = await _channel.invokeMethod<dynamic>('readAudio', {
        'uri': uri,
        'maxBytes': maxBytes,
      });
      if (result is Map) return CallRecordingBytes.fromMap(result);
      return const CallRecordingBytes(
        code: CallRecordingCode.failed,
        message: 'Android returned no bytes for that file.',
      );
    } on MissingPluginException {
      return const CallRecordingBytes(
        code: CallRecordingCode.unsupported,
        message: 'This build cannot read files from a folder.',
      );
    } on PlatformException catch (error) {
      return CallRecordingBytes(
        code: CallRecordingCode.unreadable,
        message:
            'That file could not be read: '
            '${error.message ?? 'Android refused the read'}.',
      );
    }
  }

  @override
  Future<void> clearFolder() async {
    try {
      await _channel.invokeMethod<void>('clearFolder');
    } on MissingPluginException {
      // Nothing was granted on this platform.
    } on PlatformException catch (error) {
      if (kDebugMode) {
        debugPrint('[CallRecording] clearFolder failed: ${error.message}');
      }
    }
  }

  @override
  Future<void> dispose() async {}
}

/// Used on platforms without a native implementation, and in tests.
class UnsupportedCallRecordingPlatform implements CallRecordingPlatform {
  const UnsupportedCallRecordingPlatform();

  static const String _reason =
      'Reading a call-recording folder is implemented for Android only. NOVA '
      'never records, listens to, or screens a call on any platform.';

  @override
  Future<CallRecordingCode> status() async => CallRecordingCode.unsupported;

  @override
  Future<CallRecordingPickResult> pickFolder({String? suggestedTreeUri}) async =>
      const CallRecordingPickResult(
        code: CallRecordingCode.unsupported,
        message: _reason,
      );

  @override
  Future<CallRecordingListing> listFiles(String treeUri) async =>
      const CallRecordingListing(
        code: CallRecordingCode.unsupported,
        message: _reason,
      );

  @override
  Future<CallRecordingBytes> readAudio(String uri, {int? maxBytes}) async =>
      const CallRecordingBytes(
        code: CallRecordingCode.unsupported,
        message: _reason,
      );

  @override
  Future<void> clearFolder() async {}

  @override
  Future<void> dispose() async {}
}
