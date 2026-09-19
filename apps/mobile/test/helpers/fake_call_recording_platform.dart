import 'dart:typed_data';

import 'package:nova_mobile/features/call_recording/call_recording_models.dart';
import 'package:nova_mobile/features/call_recording/call_recording_platform.dart';

/// A folder the "user" granted, used by the default [FakeCallRecordingPlatform].
const CallRecordingFolderRef testFolder = CallRecordingFolderRef(
  treeUri: 'content://com.android.externalstorage.documents/tree/primary%3ARecordings',
  displayName: 'Recordings',
);

/// Scriptable transport for the call-recording folder.
///
/// Nothing here touches a platform channel, so a test can assert exactly what
/// the controller does with a folder, a file and a refusal without a device.
class FakeCallRecordingPlatform implements CallRecordingPlatform {
  FakeCallRecordingPlatform({
    this.supported = true,
    this.pickedFolder = testFolder,
    this.pickCode = CallRecordingCode.ok,
    this.pickMessage,
    this.listing,
    this.listingCode = CallRecordingCode.ok,
    this.listingMessage,
    this.audio,
    this.audioCode = CallRecordingCode.ok,
    this.audioMessage,
  });

  /// Whether this "platform" has a folder picker at all.
  bool supported;

  /// What a successful pick returns.
  CallRecordingFolderRef? pickedFolder;

  CallRecordingCode pickCode;
  String? pickMessage;

  /// What [listFiles] answers. Null means "the folder holds no audio".
  List<CallRecordingAsset>? listing;
  CallRecordingCode listingCode;
  String? listingMessage;

  /// What [readAudio] answers. Defaults to four readable bytes.
  List<int>? audio;
  CallRecordingCode audioCode;
  String? audioMessage;

  int pickCalls = 0;
  int listCalls = 0;
  int readCalls = 0;
  int clearCalls = 0;

  /// The `maxBytes` each read was asked for, so a test can prove the ceiling was
  /// passed down rather than discovered after the fact.
  final List<int?> readMaxBytes = <int?>[];

  /// The tree URI the last listing was asked about.
  String? lastListedTree;

  /// The file URI the last read was asked about.
  String? lastReadUri;

  @override
  Future<CallRecordingCode> status() async =>
      supported ? CallRecordingCode.supported : CallRecordingCode.unsupported;

  @override
  Future<CallRecordingPickResult> pickFolder({String? suggestedTreeUri}) async {
    pickCalls++;
    if (pickCode.isOk) {
      final folder = pickedFolder;
      if (folder == null) {
        return const CallRecordingPickResult(
          code: CallRecordingCode.failed,
          message: 'The picker returned no folder.',
        );
      }
      return CallRecordingPickResult(
        code: CallRecordingCode.ok,
        folder: folder,
      );
    }
    return CallRecordingPickResult(code: pickCode, message: pickMessage);
  }

  @override
  Future<CallRecordingListing> listFiles(String treeUri) async {
    listCalls++;
    lastListedTree = treeUri;
    if (!listingCode.isOk) {
      return CallRecordingListing(
        code: listingCode,
        message: listingMessage,
      );
    }
    return CallRecordingListing(
      code: CallRecordingCode.ok,
      files: listing ?? const <CallRecordingAsset>[],
      message: listingMessage,
    );
  }

  @override
  Future<CallRecordingBytes> readAudio(String uri, {int? maxBytes}) async {
    readCalls++;
    lastReadUri = uri;
    readMaxBytes.add(maxBytes);
    if (!audioCode.isOk) {
      return CallRecordingBytes(code: audioCode, message: audioMessage);
    }
    final bytes = audio ?? const <int>[1, 2, 3, 4];
    return CallRecordingBytes(
      code: CallRecordingCode.ok,
      bytes: Uint8List.fromList(bytes),
    );
  }

  @override
  Future<void> clearFolder() async => clearCalls++;

  @override
  Future<void> dispose() async {}
}

/// One discovered recording, with everything the file system would report.
CallRecordingAsset callAsset({
  String id = 'call-1',
  String name = 'Call_20260101_143000.m4a',
  String mimeType = 'audio/mp4',
  int? sizeBytes = 1024 * 1024,
  DateTime? modifiedAt,
  int? durationSeconds = 95,
}) {
  return CallRecordingAsset(
    uri: 'content://com.android.externalstorage.documents/document/'
        'primary%3ARecordings%2F$id',
    name: name,
    mimeType: mimeType,
    sizeBytes: sizeBytes,
    modifiedAt: modifiedAt ?? DateTime(2026, 1, 1, 14, 30),
    durationSeconds: durationSeconds,
  );
}
