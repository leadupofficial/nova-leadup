import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/features/call_recording/call_recording_controller.dart';
import 'package:nova_mobile/features/call_recording/call_recording_settings_store.dart';

import '../helpers/fake_call_recording_platform.dart';
import '../helpers/test_harness.dart';

/// Behaviour of the call-recording import controller.
///
/// The point of this feature is what it *refuses* to do, so most of these tests
/// assert a refusal or an absence: no folder pick without an acknowledgement, no
/// upload without a selection, no "imported" mark on a file whose upload failed,
/// no bytes read for a file above the ceiling.
ProviderContainer callRecordingContainer(
  TestDependencies deps, {
  required FakeCallRecordingPlatform platform,
  required FakeHttpAdapter adapter,
}) {
  final network = fakeNetworkService(adapter, networkInfo: deps.networkInfo);
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(deps.preferences),
      authRepositoryProvider.overrideWithValue(deps.authRepository),
      onboardingServiceProvider.overrideWithValue(deps.onboardingService),
      wakeWordPlatformProvider.overrideWithValue(deps.wakeWordPlatform),
      crashReportingServiceProvider.overrideWithValue(deps.crashReporting),
      analyticsServiceProvider.overrideWithValue(deps.analytics),
      networkInfoServiceProvider.overrideWithValue(deps.networkInfo),
      healthServiceProvider.overrideWithValue(deps.healthService),
      networkServiceProvider.overrideWithValue(network),
      authNetworkServiceProvider.overrideWithValue(network),
      callRecordingPlatformProvider.overrideWithValue(platform),
    ],
  );
}

/// Answers the recording pipeline the way `services/api` does.
class RecordingPipelineServer {
  RecordingPipelineServer({this.createStatus = 201, this.uploadStatus = 200});

  final int createStatus;
  final int uploadStatus;

  final List<RequestOptions> requests = <RequestOptions>[];
  int created = 0;
  int uploads = 0;
  int processes = 0;
  int patches = 0;

  /// Set to fail the next upload with this status, the way a `413` arrives.
  int? uploadFailureStatus;

  /// What `GET /recordings/capabilities` reports as the upload ceiling.
  int maxUploadBytes = 0;

  Future<ResponseBody> handle(RequestOptions options) async {
    requests.add(options);
    final path = options.path;

    if (path.contains('/recordings/capabilities')) {
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{
          'transcription': 'async',
          'diarisation': false,
          'objectStorage': true,
          'maxUploadBytes': maxUploadBytes,
        },
      });
    }
    if (path.endsWith('/process')) {
      processes++;
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{'status': 'processing'},
      }, statusCode: 202);
    }
    if (path.endsWith('/audio')) {
      if (uploadFailureStatus != null) {
        final status = uploadFailureStatus!;
        uploadFailureStatus = null;
        return jsonResponse(<String, dynamic>{
          'success': false,
          'error': 'Payload too large',
        }, statusCode: status);
      }
      uploads++;
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{
          'recording': <String, dynamic>{
            'id': _idFrom(path),
            'title': 'x',
            'status': 'completed',
          },
          'storage': <String, dynamic>{
            'objectStorage': true,
            'key': 'recordings/x.m4a',
          },
        },
      });
    }
    if (options.method == 'PATCH') {
      patches++;
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{'id': _idFrom(path), 'title': 'x'},
      });
    }
    if (options.method == 'POST' && path.endsWith('/recordings')) {
      created++;
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{
          'id': 'rec-$created',
          'title': 'x',
          'status': 'recording',
        },
      }, statusCode: createStatus);
    }
    return jsonResponse(<String, dynamic>{'success': true, 'data': null});
  }

  static String _idFrom(String path) {
    final parts = path.split('/');
    final index = parts.indexOf('recordings');
    return index >= 0 && index + 1 < parts.length ? parts[index + 1] : 'rec';
  }
}

void main() {
  late FakeHttpAdapter adapter;
  late RecordingPipelineServer server;

  setUp(() {
    server = RecordingPipelineServer();
    adapter = FakeHttpAdapter(server.handle);
  });

  Future<ProviderContainer> containerWith(
    FakeCallRecordingPlatform platform, {
    Map<String, Object> prefs = const <String, Object>{},
  }) async {
    final deps = await createTestDependencies(preferences: prefs);
    addTearDown(deps.dispose);
    return callRecordingContainer(deps, platform: platform, adapter: adapter);
  }

  test('the folder picker is refused until the disclosure is acknowledged',
      () async {
    final platform = FakeCallRecordingPlatform();
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);

    final picked = await controller.pickFolder();

    expect(picked, isFalse);
    expect(platform.pickCalls, 0, reason: 'the picker must never open');
    expect(
      container.read(callRecordingControllerProvider).error,
      contains('acknowledge'),
    );
  });

  test('picking a folder stores it and leaves the feature off', () async {
    final platform = FakeCallRecordingPlatform();
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);

    controller.acknowledgeConsent(true);
    expect(await controller.pickFolder(), isTrue);
    await pumpEventQueue();

    final state = container.read(callRecordingControllerProvider);
    expect(state.settings.folder, testFolder);
    expect(
      state.isEnabled,
      isFalse,
      reason: 'granting a folder must not switch reading on by itself',
    );
    expect(platform.listCalls, 0, reason: 'nothing is listed until asked');
  });

  test('a cancelled picker changes nothing and says so', () async {
    final platform = FakeCallRecordingPlatform(
      pickCode: CallRecordingCode.cancelled,
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);

    expect(await controller.pickFolder(), isFalse);
    final state = container.read(callRecordingControllerProvider);
    expect(state.settings.folder, isNull);
    expect(state.error, isNotNull);
    expect(state.error, contains('Nothing was read'));
  });

  test('turning reading on without a folder is refused', () async {
    final platform = FakeCallRecordingPlatform();
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);

    await controller.setEnabled(true);

    final state = container.read(callRecordingControllerProvider);
    expect(state.isEnabled, isFalse);
    expect(state.error, contains('Choose a folder first'));
  });

  test('scanning lists only audio and reports what is new', () async {
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[
        callAsset(id: 'a', name: 'Call_20260101_143000.m4a'),
        callAsset(id: 'b', name: 'Call_20251231_090000.m4a'),
      ].cast(),
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();

    final state = container.read(callRecordingControllerProvider);
    expect(state.discovered, hasLength(2));
    expect(state.newAssets, hasLength(2));
    expect(state.scanStatus, CallRecordingCode.ok);
    expect(state.scanMessage, contains('2 audio files found'));
    expect(platform.lastListedTree, testFolder.treeUri);
  });

  test('a revoked grant pauses reading instead of silently emptying the list',
      () async {
    final platform = FakeCallRecordingPlatform(
      listingCode: CallRecordingCode.unreadable,
      listingMessage: 'Android no longer lets NOVA read that folder.',
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();

    final state = container.read(callRecordingControllerProvider);
    expect(state.isEnabled, isFalse);
    expect(state.hasFolder, isTrue, reason: 'the folder stays named');
    expect(state.scanStatus, CallRecordingCode.unreadable);
    expect(state.scanMessage, contains('no longer lets NOVA read'));
  });

  test('importing nothing is refused and reads nothing', () async {
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[callAsset()].cast(),
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();

    final id = await controller.importSelected();

    expect(id, isNull);
    expect(platform.readCalls, 0);
    expect(server.created, 0);
    expect(
      container.read(callRecordingControllerProvider).error,
      contains('Tick at least one recording'),
    );
  });

  test('select all new ticks the files this device has not imported', () async {
    final a = callAsset(id: 'a', name: 'a.m4a');
    final b = callAsset(id: 'b', name: 'b.m4a');
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[a, b].cast(),
    );
    final container = await containerWith(
      platform,
      prefs: <String, Object>{
        CallRecordingSettingsStore.folderUriKey: testFolder.treeUri,
        CallRecordingSettingsStore.folderNameKey: testFolder.displayName,
        CallRecordingSettingsStore.importedKey: <String>[a.uri],
      },
    );
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.scan();
    await pumpEventQueue();

    controller.selectAllNew();

    final state = container.read(callRecordingControllerProvider);
    expect(state.selected, <String>{b.uri});
    expect(state.newAssets, hasLength(1));
  });

  test('a selected file goes through the whole existing pipeline', () async {
    final asset = callAsset(id: 'a', durationSeconds: 95);
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[asset].cast(),
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();
    controller.toggleSelected(asset.uri);

    final id = await controller.importSelected();
    await pumpEventQueue();

    expect(id, 'rec-1');
    expect(server.created, 1, reason: 'createRecording');
    expect(server.patches, 1, reason: 'the file duration is saved');
    expect(server.uploads, 1, reason: 'uploadRecordingAudio');
    expect(server.processes, 1, reason: 'processRecording');
    expect(platform.readCalls, 1);
    expect(platform.lastReadUri, asset.uri);

    // The audio body is the raw bytes, never base64 or multipart.
    final upload = server.requests.firstWhere(
      (RequestOptions r) => r.path.endsWith('/audio'),
    );
    expect(upload.data, isA<List<int>>());
    expect(upload.headers['Content-Type'], 'audio/mp4');

    final state = container.read(callRecordingControllerProvider);
    expect(state.outcomes.single.ok, isTrue);
    expect(state.settings.importedFileIds, contains(asset.uri));
  });

  test('no duration is invented for a file whose container reports none',
      () async {
    final asset = callAsset(id: 'a', durationSeconds: null);
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[asset].cast(),
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();
    controller.toggleSelected(asset.uri);
    await controller.importSelected();

    expect(server.patches, 0, reason: 'nothing to save when there is no length');
    expect(server.uploads, 1, reason: 'the file is still imported');
    final upload = server.requests.firstWhere(
      (RequestOptions r) => r.path.endsWith('/audio'),
    );
    expect(upload.queryParameters.containsKey('durationSeconds'), isFalse);
  });

  test('a failed upload is not recorded as imported', () async {
    final asset = callAsset(id: 'a');
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[asset].cast(),
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();
    controller.toggleSelected(asset.uri);

    server.uploadFailureStatus = 413;
    final id = await controller.importSelected();
    await pumpEventQueue();

    expect(id, isNull);
    expect(server.processes, 0);
    final state = container.read(callRecordingControllerProvider);
    expect(state.outcomes.single.ok, isFalse);
    expect(state.outcomes.single.message, contains('too large'));
    expect(
      state.settings.importedFileIds,
      isNot(contains(asset.uri)),
      reason: 'a file that did not upload can be retried, not skipped',
    );
    expect(state.error, contains('too large'));
  });

  test('a file above the server ceiling is refused before it is read',
      () async {
    server.maxUploadBytes = 512;
    final asset = callAsset(id: 'a', sizeBytes: 4096);
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[asset].cast(),
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();
    controller.toggleSelected(asset.uri);

    final id = await controller.importSelected();
    await pumpEventQueue();

    expect(id, isNull);
    expect(platform.readCalls, 0, reason: 'the file is never read');
    expect(server.uploads, 0);
    expect(server.created, 0);
    expect(
      container.read(callRecordingControllerProvider).outcomes.single.message,
      contains('above the server'),
    );
  });

  test('a file the platform refuses to read is not uploaded and the row fails',
      () async {
    final asset = callAsset(id: 'a');
    final platform = FakeCallRecordingPlatform(
      listing: <dynamic>[asset].cast(),
      audioCode: CallRecordingCode.unreadable,
      audioMessage: 'Android no longer lets NOVA read that file.',
    );
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();
    controller.toggleSelected(asset.uri);

    final id = await controller.importSelected();
    await pumpEventQueue();

    expect(id, isNull);
    expect(server.created, 1);
    expect(server.uploads, 0);
    expect(server.processes, 0);
    // The row created for the failed read is marked failed, so the recordings
    // list never shows a recording that has no audio.
    final failed = server.requests.firstWhere(
      (RequestOptions r) =>
          r.method == 'PATCH' && jsonEncode(r.data).contains('failed'),
    );
    expect(failed.path, contains('/recordings/rec-1'));
  });

  test('forgetting the folder turns reading off and drops the stored grant',
      () async {
    final platform = FakeCallRecordingPlatform();
    final container = await containerWith(platform);
    final controller = container.read(callRecordingControllerProvider.notifier);
    controller.acknowledgeConsent(true);
    await controller.pickFolder();
    await controller.setEnabled(true);
    await pumpEventQueue();

    await controller.forgetFolder();

    final state = container.read(callRecordingControllerProvider);
    expect(state.hasFolder, isFalse);
    expect(state.isEnabled, isFalse);
    expect(state.discovered, isEmpty);
    expect(platform.clearCalls, 1);
  });

  test('the persisted consent tick does not survive a restart', () async {
    // Even with the feature stored as on, a fresh controller starts with the
    // acknowledgement unticked, so the folder picker is closed again.
    final deps = await createTestDependencies(
      preferences: <String, Object>{
        CallRecordingSettingsStore.enabledKey: true,
        CallRecordingSettingsStore.folderUriKey: testFolder.treeUri,
        CallRecordingSettingsStore.folderNameKey: testFolder.displayName,
      },
    );
    addTearDown(deps.dispose);
    final platform = FakeCallRecordingPlatform();
    final container = callRecordingContainer(
      deps,
      platform: platform,
      adapter: adapter,
    );
    final controller = container.read(callRecordingControllerProvider.notifier);
    await pumpEventQueue();

    expect(
      container.read(callRecordingControllerProvider).consentAcknowledged,
      isFalse,
    );
    expect(await controller.pickFolder(), isFalse);
    expect(platform.pickCalls, 0);
  });
}
