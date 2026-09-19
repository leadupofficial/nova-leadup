import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/call_recording/call_recording_models.dart';
import 'package:nova_mobile/features/call_recording/call_recording_platform.dart';

/// Cross-language and manifest contract tests for call-recording import
/// (requirement 6c).
///
/// A Dart-only test cannot prove Android read a folder, but it *can* pin the
/// things that would otherwise go wrong silently:
///
///  * the method-channel name, and every result code, agreeing between Dart and
///    `NovaCallRecordingFolder.kt`;
///  * the two MIME/title rules the Kotlin policy and the Dart mirror share;
///  * and — most importantly — that the permissions and services this feature
///    must **never** acquire are absent from the manifest. Requirement 6c's
///    naive reading ("screen calls, transcribe unknown callers") is blocked by
///    platform policy, so the absence of `READ_CALL_LOG`, `ANSWER_PHONE_CALLS`,
///    `MANAGE_EXTERNAL_STORAGE`, `READ_MEDIA_AUDIO` and any Accessibility
///    service is the contract, not a nice-to-have.
void main() {
  final kotlinPolicy = File(
    'android/app/src/main/java/com/leadup/nova/CallRecordingFolderPolicy.kt',
  );
  final kotlinPlugin = File(
    'android/app/src/main/java/com/leadup/nova/NovaCallRecordingFolder.kt',
  );
  final kotlinFiles = File(
    'android/app/src/main/java/com/leadup/nova/NovaCallRecordingFiles.kt',
  );
  final manifestFile = File('android/app/src/main/AndroidManifest.xml');
  final mainActivity = File(
    'android/app/src/main/java/com/leadup/nova/MainActivity.kt',
  );

  late final String policy = kotlinPolicy.readAsStringSync();
  late final String plugin = kotlinPlugin.readAsStringSync();
  late final String fileHelper = kotlinFiles.readAsStringSync();
  late final String manifest = manifestFile.readAsStringSync();

  test('the Kotlin sources and the manifest exist where Dart expects them', () {
    expect(kotlinPolicy.existsSync(), isTrue);
    expect(kotlinPlugin.existsSync(), isTrue);
    expect(manifestFile.existsSync(), isTrue);
    expect(mainActivity.existsSync(), isTrue);
  });

  test('the MethodChannel name matches on both sides', () {
    expect(plugin, contains(MethodChannelCallRecordingPlatform.channelName));
    expect(
      plugin,
      contains('METHOD_CHANNEL_NAME = "nova/call_recording_folder"'),
    );
  });

  test('every Kotlin result code is one Dart understands', () {
    final kotlinCodes = RegExp(r'const val CODE_\w+ = "(\w+)"')
        .allMatches(plugin)
        .map((RegExpMatch m) => m.group(1)!)
        .toSet();
    final dartCodes = CallRecordingCode.values
        .map((CallRecordingCode c) => c.wireName)
        .toSet();

    expect(kotlinCodes, isNotEmpty);
    expect(
      dartCodes.containsAll(kotlinCodes),
      isTrue,
      reason: 'Kotlin codes $kotlinCodes must all be decodable in Dart',
    );
    // The shared vocabulary, pinned so neither side can rename one silently.
    expect(kotlinCodes, <String>{
      'ok',
      'supported',
      'unsupported',
      'cancelled',
      'needs_picker',
      'no_folder',
      'not_a_folder',
      'unreadable',
      'empty',
      'too_large',
      'invalid_argument',
      'failed',
    });
  });

  test('the Kotlin plugin implements every method the Dart platform calls', () {
    for (final method in <String>[
      'status',
      'pickFolder',
      'clearFolder',
      'listFiles',
      'readAudio',
    ]) {
      expect(
        plugin,
        contains('"$method" ->'),
        reason: '$method must be handled in NovaCallRecordingFolder.kt',
      );
    }
  });

  test('the policy constants and the Dart mirrors agree', () {
    expect(
      policy,
      contains(
        'const val FALLBACK_MIME_TYPE = "$callRecordingFallbackMimeType"',
      ),
    );
    expect(
      policy,
      contains('const val FALLBACK_TITLE = "$callRecordingFallbackTitle"'),
    );
  });

  test('the title rule matches the Kotlin policy for awkward names', () {
    // The Kotlin rule: the LAST dot splits the name, separators are dropped, a
    // leading dot is part of the name, and a name with nothing left means the
    // fallback. These are the names an OEM dialer actually writes, plus the ones
    // that would otherwise produce nonsense.
    const cases = <String, String>{
      'Call_20260101_143000.m4a': 'Call_20260101_143000',
      'recording.mp3': 'recording',
      'two.dots.amr': 'two.dots',
      'noextension': 'noextension',
      '/etc/passwd': 'etcpasswd',
      '.m4a': '.m4a',
      '   ': callRecordingFallbackTitle,
    };
    cases.forEach((String name, String expected) {
      expect(
        callRecordingTitleFor(name),
        expected,
        reason: 'title for "$name"',
      );
    });
  });

  test('the upload MIME rule matches the Kotlin policy', () {
    const cases = <String, String>{
      'audio/mp4': 'audio/mp4',
      'audio/amr-wb': 'audio/amr-wb',
    };
    cases.forEach((String mime, String expected) {
      expect(callRecordingUploadMimeType('call.m4a', mime), expected);
    });
    expect(
      callRecordingUploadMimeType('call.m4a', 'application/octet-stream'),
      'audio/mp4',
    );
    expect(callRecordingUploadMimeType('call.opus', null), 'audio/ogg');
    expect(
      callRecordingUploadMimeType('recording', null),
      callRecordingFallbackMimeType,
    );
  });

  test('the manifest grants no permission this feature must not have', () {
    for (final forbidden in <String>[
      // The call-log and call-control permissions the naive reading of 6c would
      // need. Google Play restricts READ_CALL_LOG to default dialers, and an app
      // cannot hear a call at all, so these must never appear.
      'android.permission.READ_CALL_LOG',
      'android.permission.WRITE_CALL_LOG',
      'android.permission.ANSWER_PHONE_CALLS',
      'android.permission.CALL_PHONE',
      'android.permission.PROCESS_OUTGOING_CALLS',
      'android.permission.MANAGE_OWN_CALLS',
      // Storage access that SAF makes unnecessary. ACTION_OPEN_DOCUMENT_TREE
      // needs no manifest permission: the user's tap is the grant.
      'android.permission.MANAGE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      // A call recorder's other route in, banned by Google in 2022.
      'android.permission.CAPTURE_AUDIO_OUTPUT',
      'android.permission.CAPTURE_VOICE_COMMUNICATION_OUTPUT',
      'android.permission.RECORD_AUDIO_HOTWORD',
      'android.permission.MODIFY_AUDIO_ROUTING',
    ]) {
      expect(
        manifest,
        isNot(contains(forbidden)),
        reason: '$forbidden must not be declared',
      );
    }
  });

  test('no Kotlin file calls a call-audio or call-log API', () {
    final sources = Directory('android/app/src/main/java/com/leadup/nova')
        .listSync()
        .whereType<File>()
        .where((File f) => f.path.endsWith('.kt'));
    for (final file in sources) {
      final source = file.readAsStringSync();
      expect(
        source,
        isNot(contains('AccessibilityService')),
        reason: '${file.path} must not declare an Accessibility service',
      );
      // The assertion is against the *API*, not against the permission's name —
      // the two call-recording files explain the platform limit in prose, and
      // the manifest test above is what proves the permissions themselves are
      // absent. These are the calls an attempted workaround would have to make.
      for (final forbidden in <String>[
        'MediaRecorder.AudioSource.VOICE_CALL',
        'MediaRecorder.AudioSource.VOICE_COMMUNICATION',
        'MediaRecorder.AudioSource.VOICE_RECOGNITION',
        'TelephonyManager',
        'TelecomManager',
        'CallLog',
        'Environment.getExternalStorageDirectory',
        'Environment.getExternalStoragePublicDirectory',
      ]) {
        expect(
          source,
          isNot(contains(forbidden)),
          reason: '${file.path} must not use $forbidden',
        );
      }
    }
  });

  test('the plugin opens the SAF folder picker and persists the grant', () {
    expect(plugin, contains('Intent.ACTION_OPEN_DOCUMENT_TREE'));
    expect(
      plugin,
      contains('takePersistableUriPermission'),
      reason: 'without it the folder grant dies with the process',
    );
    expect(
      plugin,
      contains('Intent.FLAG_GRANT_READ_URI_PERMISSION'),
    );
    // The picker is launched by the Activity, because only an Activity can
    // receive a system picker's result; the channel is registered with one.
    expect(plugin, contains('startActivityForResult'));
    expect(
      plugin,
      contains('onActivityResult'),
      reason: 'the Activity forwards the picker result to the channel',
    );
    expect(
      mainActivity.readAsStringSync(),
      contains('NovaCallRecordingFolder.registerChannels'),
      reason: 'the channel is wired from configureFlutterEngine like the rest',
    );
  });

  test('a listing returns files, never a scan of the whole device', () {
    // The only discovery call is `listFiles` on one tree URI. There is no
    // recursive walk and no fixed path anywhere in the native code. The reading
    // half lives in `NovaCallRecordingFiles.kt`; both halves are checked.
    for (final source in <String>[plugin, fileHelper]) {
      expect(source, isNot(contains('walkTopDown')));
      expect(source, isNot(contains('/storage/emulated')));
      // Every read goes through a document URI from the granted tree; nothing
      // opens a path built by string concatenation.
      expect(source, isNot(contains('java.io.File(')));
    }
    expect(
      plugin,
      contains('NovaCallRecordingFiles.list'),
      reason: 'the channel delegates the listing to the file helper',
    );
    expect(fileHelper, contains('buildChildDocumentsUriUsingTree'));
    expect(
      plugin,
      contains('DocumentsContract.Document.MIME_TYPE_DIR'),
      reason: 'a nested folder must be skipped, not descended into',
    );
  });
}
