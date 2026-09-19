import 'package:flutter/foundation.dart';

/// The data types for call-recording import (requirement 6c).
///
/// Split from `call_recording_controller.dart` so each file stays small; the
/// controller re-exports them, so the controller remains the one import a caller
/// needs.
///
/// ## What these types describe
///
/// Not a call. A **file the user already owns**, written by their own dialer, in
/// a folder they chose. NOVA never hears a call, never records one and never
/// reads the call log — see [CallRecordingFolderPolicy] on the Android side for
/// why that version of the requirement cannot be built.

/// Every outcome code the Kotlin side can return over
/// `nova/call_recording_folder`.
///
/// The wire names are frozen: `NovaCallRecordingFolder.kt` declares the same
/// strings as `CODE_*` constants and `call_recording_contract_test.dart` asserts
/// the two lists agree, so neither side can rename one silently.
enum CallRecordingCode {
  /// The call worked and changed nothing the user did not ask for.
  ok('ok'),

  /// Android can do this here. Not a success on its own — it is the answer to
  /// `status`, which reports capability, not a granted folder.
  supported('supported'),

  /// This device has no system folder picker, so NOVA cannot be pointed at a
  /// folder at all.
  unsupported('unsupported'),

  /// The user dismissed the picker. Nothing was read and nothing was uploaded.
  cancelled('cancelled'),

  /// Android would not let NOVA keep access to the folder, so it would have been
  /// forgotten on the next restart. The user must choose again — preferring the
  /// system Files app.
  needsPicker('needs_picker'),

  /// No folder has been chosen (or the argument named none).
  noFolder('no_folder'),

  /// The URI is not a document tree NOVA can read.
  notAFolder('not_a_folder'),

  /// The grant exists but Android refused the read — the user revoked access, or
  /// the provider is gone. Nothing was read and nothing was uploaded.
  unreadable('unreadable'),

  /// The file has no bytes, so there is nothing to transcribe.
  empty('empty'),

  /// The file is above the per-upload ceiling. It was not read and not sent.
  tooLarge('too_large'),

  /// The call was malformed.
  invalidArgument('invalid_argument'),

  /// An unexpected platform failure. Never reported as a success.
  failed('failed'),

  /// A code this build does not know. Treated as a failure, never as `ok`.
  unknown('unknown');

  const CallRecordingCode(this.wireName);

  /// The exact string the Kotlin half sends.
  final String wireName;

  /// Maps a wire code to its enum value, degrading an unrecognised code to
  /// [unknown] rather than throwing inside a channel reply.
  static CallRecordingCode fromWire(Object? value) {
    final text = value?.toString() ?? '';
    for (final code in values) {
      if (code.wireName == text) return code;
    }
    return CallRecordingCode.unknown;
  }

  /// True only for [ok]. `supported` is deliberately **not** success: it is a
  /// capability answer, and treating it as one is how an app claims to have read
  /// a folder it was never given.
  bool get isOk => this == CallRecordingCode.ok;
}

/// The folder the user granted, as Android remembers it.
@immutable
class CallRecordingFolderRef {
  const CallRecordingFolderRef({required this.treeUri, required this.displayName});

  /// The persisted `content://` tree URI. This is the whole of the grant's
  /// identity; NOVA stores nothing else about the folder.
  final String treeUri;

  /// The folder's own display name, for the settings screen.
  final String displayName;

  factory CallRecordingFolderRef.fromMap(Map<dynamic, dynamic> map) {
    final uri = (map['treeUri'] ?? '').toString();
    final name = (map['displayName'] ?? '').toString().trim();
    return CallRecordingFolderRef(
      treeUri: uri,
      displayName: name.isEmpty ? _lastPathSegment(uri) : name,
    );
  }

  static String _lastPathSegment(String uri) {
    final trimmed = uri.endsWith('/')
        ? uri.substring(0, uri.length - 1)
        : uri;
    final slash = trimmed.lastIndexOf('/');
    final segment = slash < 0 ? trimmed : trimmed.substring(slash + 1);
    return segment.isEmpty ? trimmed : segment;
  }

  @override
  bool operator ==(Object other) =>
      other is CallRecordingFolderRef &&
      other.treeUri == treeUri &&
      other.displayName == displayName;

  @override
  int get hashCode => Object.hash(treeUri, displayName);
}

/// One audio file found in the granted folder.
///
/// Only what the file system reports. There is no caller identity, no contact
/// and no phone number here, because a file name is genuinely all NOVA has —
/// inventing the rest is the failure mode this feature exists to avoid.
@immutable
class CallRecordingAsset {
  const CallRecordingAsset({
    required this.uri,
    required this.name,
    required this.mimeType,
    this.sizeBytes,
    this.modifiedAt,
    this.durationSeconds,
  });

  /// The document URI, which is also the identity used to remember which files
  /// have already been imported.
  final String uri;

  final String name;
  final String mimeType;

  /// Null or negative when the provider would not report a size.
  final int? sizeBytes;

  final DateTime? modifiedAt;

  /// Null when the container carries no duration. The screen says "duration not
  /// available" rather than showing a length NOVA did not read.
  final int? durationSeconds;

  /// What the recording is called once imported: the file name without its
  /// extension. Never a guessed caller name.
  String get title => callRecordingTitleFor(name);

  bool get hasSize => sizeBytes != null && sizeBytes! >= 0;
  bool get hasDuration => durationSeconds != null && durationSeconds! > 0;

  /// e.g. `12.4 MB`, or "size not reported" when the provider gave none.
  String get sizeLabel {
    final bytes = sizeBytes;
    if (bytes == null || bytes < 0) return 'Size not reported';
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  /// `mm:ss`, or null when the container carried no duration.
  String? get durationLabel {
    final seconds = durationSeconds;
    if (seconds == null || seconds <= 0) return null;
    final m = seconds ~/ 60;
    final s = seconds % 60;
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  /// `yyyy-mm-dd hh:mm`, in the device's local zone, or null when unknown.
  String? get modifiedLabel {
    final at = modifiedAt;
    if (at == null) return null;
    final local = at.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} '
        '${two(local.hour)}:${two(local.minute)}';
  }

  /// Builds one from the map the Kotlin half puts on the channel.
  ///
  /// Every key is optional on the native side, so a malformed entry degrades to
  /// a file NOVA will not offer rather than throwing inside the channel reply.
  static CallRecordingAsset? fromMap(Map<dynamic, dynamic> map) {
    final uri = (map['uri'] ?? '').toString();
    final name = (map['name'] ?? '').toString();
    if (uri.isEmpty || name.isEmpty) return null;

    final rawSize = map['sizeBytes'];
    final size = rawSize is num ? rawSize.toInt() : null;
    final rawModified = map['modifiedMs'];
    final modifiedMs = rawModified is num ? rawModified.toInt() : null;
    final rawDuration = map['durationMs'];
    final durationMs = rawDuration is num ? rawDuration.toInt() : null;

    return CallRecordingAsset(
      uri: uri,
      name: name,
      mimeType: (map['mimeType'] ?? '').toString().trim().isEmpty
          ? callRecordingUploadMimeType(name, null)
          : (map['mimeType']).toString(),
      sizeBytes: size == null || size < 0 ? null : size,
      modifiedAt: modifiedMs == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(modifiedMs),
      durationSeconds: durationMs == null || durationMs <= 0
          ? null
          : (durationMs / 1000).round(),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is CallRecordingAsset &&
      other.uri == uri &&
      other.name == name &&
      other.mimeType == mimeType &&
      other.sizeBytes == sizeBytes &&
      other.modifiedAt == modifiedAt &&
      other.durationSeconds == durationSeconds;

  @override
  int get hashCode => Object.hash(
    uri,
    name,
    mimeType,
    sizeBytes,
    modifiedAt,
    durationSeconds,
  );
}

/// The result of `pickFolder`. Exactly one of [folder] and [message] is
/// meaningful: a success must carry a folder, and a refusal must say why.
@immutable
class CallRecordingPickResult {
  const CallRecordingPickResult({
    required this.code,
    this.folder,
    this.message,
  });

  final CallRecordingCode code;

  /// Present only when [code] is [CallRecordingCode.ok].
  final CallRecordingFolderRef? folder;

  /// The honest, user-facing explanation of a refusal.
  final String? message;

  bool get isOk => code.isOk && folder != null;

  factory CallRecordingPickResult.fromMap(Map<dynamic, dynamic> map) {
    final code = CallRecordingCode.fromWire(map['code']);
    final message = (map['message'] ?? '').toString().trim();
    if (code.isOk) {
      final folder = CallRecordingFolderRef.fromMap(map);
      if (folder.treeUri.isNotEmpty) {
        return CallRecordingPickResult(code: code, folder: folder);
      }
      return const CallRecordingPickResult(
        code: CallRecordingCode.failed,
        message:
            'Android reported that a folder was chosen but named none, so NOVA '
            'has nothing to read.',
      );
    }
    return CallRecordingPickResult(
      code: code,
      message: message.isEmpty ? _defaultMessage(code) : message,
    );
  }

  static String _defaultMessage(CallRecordingCode code) => switch (code) {
    CallRecordingCode.cancelled =>
      'No folder was chosen, so NOVA still has nothing to read.',
    CallRecordingCode.unsupported =>
      'This device has no system folder picker, so NOVA cannot read call '
          'recordings here.',
    CallRecordingCode.unreadable =>
      'Android would not let NOVA read that folder. Nothing was read.',
    CallRecordingCode.unknown =>
      'Android answered something this build does not understand. Treat it as a '
          'refusal: nothing was read.',
    _ => 'The folder could not be chosen ($code). Nothing was read.',
  };
}

/// The result of `listFiles`.
@immutable
class CallRecordingListing {
  const CallRecordingListing({
    required this.code,
    this.files = const <CallRecordingAsset>[],
    this.message,
  });

  final CallRecordingCode code;
  final List<CallRecordingAsset> files;

  /// Why the folder could not be read, when it could not.
  final String? message;

  bool get isOk => code.isOk;

  /// True when the folder was read successfully and simply holds no audio.
  bool get isEmpty => code.isOk && files.isEmpty;

  factory CallRecordingListing.fromMap(Map<dynamic, dynamic> map) {
    final code = CallRecordingCode.fromWire(map['code']);
    final raw = map['files'];
    final files = raw is List
        ? raw
              .whereType<Map>()
              .map(CallRecordingAsset.fromMap)
              .whereType<CallRecordingAsset>()
              .toList()
        : const <CallRecordingAsset>[];
    final message = (map['message'] ?? '').toString().trim();
    return CallRecordingListing(
      code: code,
      files: code.isOk ? files : const <CallRecordingAsset>[],
      message: message.isEmpty ? null : message,
    );
  }
}

/// The result of `readAudio`.
@immutable
class CallRecordingBytes {
  const CallRecordingBytes({required this.code, this.bytes, this.message});

  final CallRecordingCode code;

  /// The file's bytes. Present only on success.
  final Uint8List? bytes;

  final String? message;

  bool get isOk => code.isOk && bytes != null && bytes!.isNotEmpty;

  int get byteLength => bytes?.length ?? 0;

  factory CallRecordingBytes.fromMap(Map<dynamic, dynamic> map) {
    final code = CallRecordingCode.fromWire(map['code']);
    final raw = map['bytes'];
    final message = (map['message'] ?? '').toString().trim();
    if (code.isOk && (raw is Uint8List || raw is List<int>)) {
      final bytes = raw is Uint8List
          ? raw
          : Uint8List.fromList(raw as List<int>);
      return CallRecordingBytes(code: code, bytes: bytes);
    }
    return CallRecordingBytes(
      code: code.isOk ? CallRecordingCode.failed : code,
      message: message.isEmpty
          ? 'That file was not read, so nothing was uploaded.'
          : message,
    );
  }
}

// ─── Shared wording, mirrored from the Kotlin policy ──────────────────────────

/// The title used when a file name has nothing usable left in it. Mirrors
/// `CallRecordingFolderPolicy.FALLBACK_TITLE`.
const String callRecordingFallbackTitle = 'Call recording';

/// The container type declared when neither the provider nor the extension is
/// conclusive. Mirrors `CallRecordingFolderPolicy.FALLBACK_MIME_TYPE`.
const String callRecordingFallbackMimeType = 'audio/mp4';

/// The extension→container mapping, mirrored from the Kotlin policy.
///
/// The Kotlin half decides this for the real listing; this copy is what [fromMap]
/// uses when a payload arrives without a usable `mimeType`, so the two cannot
/// drift on the values a test can see.
String callRecordingUploadMimeType(String name, String? mimeType) {
  final type = (mimeType ?? '').trim().toLowerCase();
  if (type.startsWith('audio/')) return type;
  final dot = name.lastIndexOf('.');
  final extension = dot < 0 || dot == name.length - 1
      ? ''
      : name.substring(dot + 1).toLowerCase();
  return switch (extension) {
    'aac' => 'audio/aac',
    'amr' => 'audio/amr',
    'awb' => 'audio/amr-wb',
    'flac' => 'audio/flac',
    'm4a' || 'm4b' || 'mp4' => 'audio/mp4',
    'mp3' => 'audio/mpeg',
    'oga' || 'ogg' || 'opus' => 'audio/ogg',
    'wav' => 'audio/wav',
    '3gp' || '3gpp' => 'audio/3gpp',
    _ => callRecordingFallbackMimeType,
  };
}

/// The recording title for a file name. Mirrors
/// `CallRecordingFolderPolicy.titleFor`.
///
/// The **last** dot splits the name, so `call.2026.01.01.m4a` keeps its date
/// rather than losing everything after the first dot — the same rule the Kotlin
/// half uses.
String callRecordingTitleFor(String name) {
  final dot = name.lastIndexOf('.');
  final withoutExtension = dot > 0 ? name.substring(0, dot) : name;
  final cleaned = withoutExtension
      .replaceAll(RegExp(r'[\x00-\x1F\x7F/\\]'), '')
      .trim();
  return cleaned.isEmpty ? callRecordingFallbackTitle : cleaned;
}
