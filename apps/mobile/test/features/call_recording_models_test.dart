import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/call_recording/call_recording_models.dart';
import 'package:nova_mobile/features/call_recording/call_recording_settings_store.dart';

import '../helpers/test_harness.dart';

/// The data layer: what the channel's answer means, and what is persisted.
///
/// Two facts matter most here. An unrecognised code is never treated as success,
/// and a file whose container carries no duration is reported as having none
/// rather than being given a plausible-looking number.
void main() {
  group('wire codes', () {
    test('every Kotlin answer maps to the matching code', () {
      for (final code in CallRecordingCode.values) {
        expect(CallRecordingCode.fromWire(code.wireName), code);
      }
    });

    test('only ok counts as success', () {
      expect(CallRecordingCode.ok.isOk, isTrue);
      expect(
        CallRecordingCode.supported.isOk,
        isFalse,
        reason: 'a capability answer is not a granted folder',
      );
    });

    test('an unrecognised answer is unknown, never ok', () {
      expect(CallRecordingCode.fromWire('something_new'), CallRecordingCode.unknown);
      expect(CallRecordingCode.fromWire(null), CallRecordingCode.unknown);
      expect(CallRecordingCode.unknown.isOk, isFalse);
    });
  });

  group('asset parsing', () {
    test('a full payload round-trips', () {
      final asset = CallRecordingAsset.fromMap(<String, dynamic>{
        'uri': 'content://tree/doc/a',
        'name': 'Call_20260101_143000.m4a',
        'mimeType': 'audio/mp4',
        'sizeBytes': 2048,
        'modifiedMs': DateTime(2026, 1, 1, 14, 30).millisecondsSinceEpoch,
        'durationMs': 95000,
      });

      expect(asset, isNotNull);
      expect(asset!.title, 'Call_20260101_143000');
      expect(asset.durationSeconds, 95);
      expect(asset.durationLabel, '01:35');
      expect(asset.sizeLabel, '2.0 KB');
      expect(asset.modifiedAt, DateTime(2026, 1, 1, 14, 30));
    });

    test('a missing duration stays missing instead of being guessed', () {
      final asset = CallRecordingAsset.fromMap(const <String, dynamic>{
        'uri': 'content://tree/doc/a',
        'name': 'call.m4a',
        'mimeType': 'audio/mp4',
      });

      expect(asset, isNotNull);
      expect(asset!.hasDuration, isFalse);
      expect(asset.durationLabel, isNull);
      expect(asset.durationSeconds, isNull);
    });

    test('a negative size is reported as unknown, not as zero', () {
      final asset = CallRecordingAsset.fromMap(const <String, dynamic>{
        'uri': 'content://tree/doc/a',
        'name': 'call.m4a',
        'mimeType': 'audio/mp4',
        'sizeBytes': -1,
      });

      expect(asset!.hasSize, isFalse);
      expect(asset.sizeLabel, 'Size not reported');
    });

    test('a payload with no uri or name is dropped, not half-built', () {
      expect(CallRecordingAsset.fromMap(const <String, dynamic>{}), isNull);
      expect(
        CallRecordingAsset.fromMap(const <String, dynamic>{'uri': 'content://a'}),
        isNull,
      );
    });

    test('a missing mime type is filled from the extension', () {
      final asset = CallRecordingAsset.fromMap(const <String, dynamic>{
        'uri': 'content://tree/doc/a',
        'name': 'call.opus',
      });
      expect(asset!.mimeType, 'audio/ogg');
    });
  });

  group('listing and read results', () {
    test('a failed listing carries no files, whatever the payload says', () {
      final listing = CallRecordingListing.fromMap(const <String, dynamic>{
        'code': 'unreadable',
        'message': 'Android no longer lets NOVA read that folder.',
        'files': <dynamic>[
          <String, dynamic>{'uri': 'content://a', 'name': 'call.m4a'},
        ],
      });

      expect(listing.isOk, isFalse);
      expect(listing.files, isEmpty);
      expect(listing.message, contains('no longer lets'));
    });

    test('a successful listing with no files is empty, not broken', () {
      final listing = CallRecordingListing.fromMap(const <String, dynamic>{
        'code': 'ok',
        'files': <dynamic>[],
      });
      expect(listing.isOk, isTrue);
      expect(listing.isEmpty, isTrue);
    });

    test('read bytes come through as a Uint8List', () {
      final bytes = CallRecordingBytes.fromMap(
        <String, dynamic>{'code': 'ok', 'bytes': Uint8List.fromList(<int>[1, 2, 3])},
      );
      expect(bytes.isOk, isTrue);
      expect(bytes.byteLength, 3);
    });

    test('ok with no bytes is not a success', () {
      final bytes = CallRecordingBytes.fromMap(const <String, dynamic>{'code': 'ok'});
      expect(bytes.isOk, isFalse);
      expect(bytes.code, CallRecordingCode.failed);
      expect(bytes.message, isNotNull);
    });

    test('too_large is preserved with its message', () {
      final bytes = CallRecordingBytes.fromMap(const <String, dynamic>{
        'code': 'too_large',
        'message': 'That file is 90000000 bytes, above the limit.',
      });
      expect(bytes.code, CallRecordingCode.tooLarge);
      expect(bytes.isOk, isFalse);
      expect(bytes.message, contains('above the limit'));
    });
  });

  group('pick results', () {
    test('ok with a folder is a success and names the folder', () {
      final result = CallRecordingPickResult.fromMap(const <String, dynamic>{
        'code': 'ok',
        'treeUri': 'content://com.android.externalstorage.documents/tree/primary%3ARecordings',
        'displayName': 'Recordings',
      });
      expect(result.isOk, isTrue);
      expect(result.folder!.displayName, 'Recordings');
    });

    test('ok without a tree URI is a failure, never a granted folder', () {
      final result = CallRecordingPickResult.fromMap(const <String, dynamic>{'code': 'ok'});
      expect(result.isOk, isFalse);
      expect(result.message, contains('named none'));
    });

    test('a refusal always carries a sentence', () {
      for (final code in <String>[
        'cancelled',
        'unsupported',
        'needs_picker',
        'unreadable',
        'not_a_folder',
      ]) {
        final result = CallRecordingPickResult.fromMap(<String, dynamic>{'code': code});
        expect(result.isOk, isFalse);
        expect(result.message, isNotNull, reason: 'code $code needs wording');
        expect(result.message!.trim(), isNotEmpty);
      }
    });

    test('a folder name falls back to the URI when none is reported', () {
      final result = CallRecordingPickResult.fromMap(const <String, dynamic>{
        'code': 'ok',
        'treeUri': 'content://tree/primary%3AMusic%2FCall',
      });
      expect(result.folder!.displayName, 'primary%3AMusic%2FCall');
    });
  });

  group('settings store', () {
    test('a fresh install has read nothing and stored nothing', () async {
      final prefs = await mockPreferences();
      final store = CallRecordingSettingsStore(prefs);

      final settings = store.read();
      expect(settings.enabled, isFalse);
      expect(settings.hasFolder, isFalse);
      expect(settings.canRead, isFalse);
      expect(settings.importedFileIds, isEmpty);
    });

    test('a folder and the imported ids are remembered', () async {
      final prefs = await mockPreferences();
      final store = CallRecordingSettingsStore(prefs);
      const folder = CallRecordingFolderRef(
        treeUri: 'content://tree/primary%3ARecordings',
        displayName: 'Recordings',
      );

      await store.setFolder(folder);
      await store.markImported(<String>['content://a', 'content://b']);

      final settings = store.read();
      expect(settings.folder, folder);
      expect(settings.importedFileIds, <String>{'content://a', 'content://b'});
    });

    test('choosing a different folder forgets the previous imports', () async {
      final prefs = await mockPreferences();
      final store = CallRecordingSettingsStore(prefs);

      await store.setFolder(
        const CallRecordingFolderRef(treeUri: 'content://tree/one', displayName: 'one'),
      );
      await store.markImported(<String>['content://a']);

      await store.setFolder(
        const CallRecordingFolderRef(treeUri: 'content://tree/two', displayName: 'two'),
      );

      expect(store.read().importedFileIds, isEmpty);
      expect(store.read().folder!.treeUri, 'content://tree/two');
    });

    test('re-choosing the same folder keeps the imports', () async {
      final prefs = await mockPreferences();
      final store = CallRecordingSettingsStore(prefs);
      const folder = CallRecordingFolderRef(
        treeUri: 'content://tree/one',
        displayName: 'one',
      );

      await store.setFolder(folder);
      await store.markImported(<String>['content://a']);
      await store.setFolder(folder);

      expect(store.read().importedFileIds, <String>{'content://a'});
    });

    test('the imported list is bounded', () async {
      final prefs = await mockPreferences();
      final store = CallRecordingSettingsStore(prefs);

      await store.markImported(
        List<String>.generate(
          CallRecordingSettingsStore.importedLimit + 20,
          (int i) => 'content://file-$i',
        ),
      );

      final ids = store.read().importedFileIds;
      expect(ids, hasLength(CallRecordingSettingsStore.importedLimit));
      // The oldest twenty are dropped; the newest survive.
      expect(ids, contains('content://file-20'));
      expect(ids, isNot(contains('content://file-19')));
      expect(ids, contains('content://file-319'));
    });

    test('forgetting a folder turns reading off and drops the grant', () async {
      final prefs = await mockPreferences();
      final store = CallRecordingSettingsStore(prefs);

      await store.setFolder(
        const CallRecordingFolderRef(treeUri: 'content://tree/one', displayName: 'one'),
      );
      await store.setEnabled(true);
      await store.markImported(<String>['content://a']);

      await store.clearFolder();

      final settings = store.read();
      expect(settings.enabled, isFalse);
      expect(settings.hasFolder, isFalse);
      expect(settings.importedFileIds, isEmpty);
      // The two folder keys are removed outright; the imported list is emptied
      // rather than removed, which reads back as "nothing imported" either way.
      expect(prefs.get(CallRecordingSettingsStore.folderUriKey), isNull);
      expect(prefs.get(CallRecordingSettingsStore.folderNameKey), isNull);
      expect(
        prefs.getStringList(CallRecordingSettingsStore.importedKey),
        isEmpty,
      );
    });

    test('the store writes only the keys it declares', () async {
      final prefs = await mockPreferences();
      final store = CallRecordingSettingsStore(prefs);

      await store.setEnabled(true);
      await store.setFolder(
        const CallRecordingFolderRef(treeUri: 'content://tree/one', displayName: 'one'),
      );
      await store.markImported(<String>['content://a']);

      final written = prefs.getKeys().where(
        (String key) => key.startsWith('nova_call_recording'),
      );
      expect(written.toSet(), CallRecordingSettingsStore.allKeys.toSet());
    });
  });
}
