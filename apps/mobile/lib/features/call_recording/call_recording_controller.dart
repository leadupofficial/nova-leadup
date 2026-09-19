import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/api/providers.dart';
import 'call_recording_platform.dart';
import 'call_recording_settings_store.dart';
import 'call_recording_state.dart';

export 'call_recording_state.dart';

/// Bridges the granted folder to the app and drives the existing recording
/// pipeline for each file the user selects.
///
/// ## What this controller will not do
///
/// It does not record a call, does not open a call's audio, and does not read
/// the call log — Android does not permit the first two and Google Play
/// restricts the third. It reads files the user already owns, in a folder they
/// chose, and only the ones they ticked.
///
/// ## Reusing the pipeline
///
/// Each file goes through exactly the three calls the meeting recorder uses —
/// `createRecording`, `uploadRecordingAudio`, `processRecording` — so results
/// land in the same place with the same presentation. There is no second upload
/// path and no parallel summary store.
class CallRecordingController extends Notifier<CallRecordingState> {
  bool _disposed = false;

  @override
  CallRecordingState build() {
    ref.onDispose(() {
      _disposed = true;
    });
    final settings = ref.read(callRecordingSettingsStoreProvider).read();
    // Scheduled, not awaited: `build()` must stay synchronous.
    unawaited(_probe(settings));
    return CallRecordingState(settings: settings);
  }

  /// Reads what this platform and this deployment allow, without touching the
  /// folder: nothing is listed until the user asks for it.
  Future<void> _probe(CallRecordingSettings initial) async {
    final status = await ref.read(callRecordingPlatformProvider).status();
    if (_disposed) return;

    NovaRecordingCapabilities? capabilities;
    try {
      capabilities = await ref.read(novaApiProvider).getRecordingCapabilities();
    } on NovaApiException catch (e) {
      // Not fatal: the ceiling is only a hint, and the upload still reports a
      // 413 in the server's own words. Say nothing rather than blocking a scan.
      debugPrint('[CallRecording] capabilities unavailable: ${e.message}');
    }
    if (_disposed) return;

    state = state.copyWith(status: status, capabilities: capabilities);

    // A folder granted on a previous run is re-checked on open, so a grant
    // revoked in Android Settings is discovered here rather than at import time.
    if (initial.hasFolder && initial.enabled) {
      await scan();
    }
  }

  // ─── Consent and the folder ───────────────────────────────────────────────

  void acknowledgeConsent(bool value) => state = state.copyWith(
    consentAcknowledged: value,
    clearError: value,
  );

  /// Opens the system folder picker.
  ///
  /// Refused until the disclosure has been acknowledged, so the folder is never
  /// granted by a mis-tap on a screen the user has not read.
  Future<bool> pickFolder() async {
    if (!state.consentAcknowledged) {
      state = state.copyWith(
        error:
            'Read and acknowledge what this does before choosing a folder. '
            'NOVA reads files you already own; it never records a call.',
      );
      return false;
    }
    state = state.copyWith(busy: true, clearError: true, clearScanMessage: true);
    final result = await ref.read(callRecordingPlatformProvider).pickFolder();

    if (_disposed) return false;
    if (!result.isOk) {
      state = state.copyWith(
        busy: false,
        status: result.code == CallRecordingCode.unsupported
            ? CallRecordingCode.unsupported
            : state.status,
        error: result.message ??
            'That folder could not be chosen. Nothing was read.',
        clearError: false,
      );
      return false;
    }

    await ref.read(callRecordingSettingsStoreProvider).setFolder(result.folder!);
    final settings = ref.read(callRecordingSettingsStoreProvider).read();
    state = state.copyWith(
      settings: settings,
      busy: false,
      discovered: const <CallRecordingAsset>[],
      selected: const <String>{},
      scanStatus: null,
      clearScanMessage: true,
    );
    return true;
  }

  /// Turns reading on or off. Nothing is read while it is off.
  Future<void> setEnabled(bool enabled) async {
    if (enabled && !state.consentAcknowledged) {
      state = state.copyWith(
        error:
            'Acknowledge the disclosure before turning this on. NOVA reads '
            'recordings your own dialer made — it does not record calls.',
      );
      return;
    }
    if (enabled && !state.hasFolder) {
      state = state.copyWith(
        error: 'Choose a folder first. NOVA only ever reads a folder you picked.',
      );
      return;
    }
    await ref.read(callRecordingSettingsStoreProvider).setEnabled(enabled);
    state = state.copyWith(
      settings: ref.read(callRecordingSettingsStoreProvider).read(),
      clearError: true,
    );
    if (enabled) await scan();
  }

  /// Forgets the folder. The grant itself is the user's to revoke in Android
  /// Settings; this drops the stored URI so nothing is read from it again.
  Future<void> forgetFolder() async {
    state = state.copyWith(busy: true, clearError: true, clearScanMessage: true);
    await ref.read(callRecordingPlatformProvider).clearFolder();
    await ref.read(callRecordingSettingsStoreProvider).clearFolder();
    if (_disposed) return;
    state = state.copyWith(
      settings: ref.read(callRecordingSettingsStoreProvider).read(),
      discovered: const <CallRecordingAsset>[],
      selected: const <String>{},
      scanStatus: null,
      busy: false,
    );
  }

  // ─── Discovery ────────────────────────────────────────────────────────────

  /// Lists the audio files in the granted folder.
  ///
  /// This is the only place a file is ever discovered, and it runs only when the
  /// user asks (or when the feature is turned on). A folder whose grant has gone
  /// is reported as such and the feature is paused, rather than the list
  /// silently coming back empty.
  Future<void> scan() async {
    final folder = state.settings.folder;
    if (folder == null) {
      state = state.copyWith(
        scanStatus: CallRecordingCode.noFolder,
        scanMessage: 'No folder has been chosen, so there is nothing to read.',
      );
      return;
    }
    state = state.copyWith(
      busy: true,
      clearError: true,
      clearScanMessage: true,
    );
    final listing = await ref
        .read(callRecordingPlatformProvider)
        .listFiles(folder.treeUri);
    if (_disposed) return;

    if (!listing.isOk) {
      // A revoked grant is the one failure that changes what the feature can do,
      // so it also pauses reading. The folder stays named so the user can see
      // which one to re-grant.
      await ref.read(callRecordingSettingsStoreProvider).setEnabled(false);
      if (_disposed) return;
      state = state.copyWith(
        settings: ref.read(callRecordingSettingsStoreProvider).read(),
        busy: false,
        discovered: const <CallRecordingAsset>[],
        selected: const <String>{},
        scanStatus: listing.code,
        scanMessage: listing.message ??
            'That folder could not be read. Nothing was uploaded.',
      );
      return;
    }

    final known = state.settings.importedFileIds;
    state = state.copyWith(
      settings: ref.read(callRecordingSettingsStoreProvider).read(),
      busy: false,
      discovered: listing.files,
      selected: state.selected
          .where((uri) => listing.files.any((a) => a.uri == uri))
          .toSet(),
      scanStatus: listing.code,
      scanMessage: listing.files.isEmpty
          ? 'That folder holds no audio files NOVA can read. Nothing was '
              'uploaded.'
          : '${listing.files.length} audio file'
              '${listing.files.length == 1 ? '' : 's'} found; '
              '${listing.files.where((a) => !known.contains(a.uri)).length} not '
              'imported yet.',
    );
  }

  void toggleSelected(String uri) {
    final next = <String>{...state.selected};
    if (!next.remove(uri)) next.add(uri);
    state = state.copyWith(selected: next);
  }

  /// Ticks exactly the files this device has not imported before.
  ///
  /// Only files currently discovered can be selected, so this cannot reach
  /// anything outside the granted folder.
  void selectAllNew() => state = state.copyWith(
    selected: state.newAssets.map((a) => a.uri).toSet(),
  );

  void clearSelection() => state = state.copyWith(selected: const <String>{});

  // ─── Import ───────────────────────────────────────────────────────────────

  /// Sends every ticked file through the existing recording pipeline.
  ///
  /// Returns the id of the last recording that succeeded, which is what the
  /// screen opens the summary with; null when nothing succeeded.
  Future<String?> importSelected() async {
    final assets = state.selectedAssets;
    if (assets.isEmpty) {
      state = state.copyWith(
        error: 'Tick at least one recording first. Nothing is ever uploaded '
            'without you choosing it.',
      );
      return null;
    }
    state = state.copyWith(
      importing: true,
      clearError: true,
      outcomes: const <CallRecordingImportOutcome>[],
    );

    String? lastId;
    for (final asset in assets) {
      final outcome = await _importOne(asset);
      if (_disposed) return lastId;
      state = state.copyWith(
        outcomes: <CallRecordingImportOutcome>[outcome, ...state.outcomes],
      );
      if (outcome.ok) {
        lastId = outcome.recordingId;
        await ref
            .read(callRecordingSettingsStoreProvider)
            .markImported(<String>[asset.uri]);
        if (_disposed) return lastId;
        state = state.copyWith(
          settings: ref.read(callRecordingSettingsStoreProvider).read(),
        );
      }
    }

    if (_disposed) return lastId;
    ref.invalidate(recordingsProvider);
    state = state.copyWith(
      importing: false,
      selected: const <String>{},
      error: lastId == null ? _firstFailureMessage() : null,
      clearError: lastId != null,
    );
    return lastId;
  }

  /// One file: create the row, read the file, upload the bytes, ask the server
  /// to transcribe.
  ///
  /// Exactly the meeting recorder's three calls. Nothing is marked imported
  /// unless all three succeeded, so a failure can be retried by ticking the file
  /// again rather than being silently skipped.
  Future<CallRecordingImportOutcome> _importOne(CallRecordingAsset asset) async {
    final api = ref.read(novaApiProvider);

    final tooLargeMessage = _sizeRefusal(asset);
    if (tooLargeMessage != null) {
      return CallRecordingImportOutcome(
        asset: asset,
        ok: false,
        message: tooLargeMessage,
      );
    }

    final NovaRecording row;
    try {
      row = await api.createRecording(
        title: asset.title,
        // `POST /recordings` takes no duration; the file's own length is saved
        // with the row below, before the bytes are uploaded.
        //
        // The recording is the dialer's, but the user has stated they have the
        // right to process it. That statement is what this records.
        consentRecorded: true,
      );
    } on NovaApiException catch (e) {
      return CallRecordingImportOutcome(
        asset: asset,
        ok: false,
        message: 'The recording could not be created: ${e.message}',
      );
    }

    if (asset.durationSeconds != null) {
      // Saved before the upload so the row keeps an honest duration even if the
      // upload never completes. A file whose container reported no duration is
      // left without one rather than being given a guess.
      try {
        await api.updateRecording(
          row.id,
          durationSeconds: asset.durationSeconds,
        );
      } on NovaApiException catch (e) {
        debugPrint(
          '[CallRecording] duration not saved for ${row.id}: ${e.message}',
        );
      }
    }

    final bytes = await ref
        .read(callRecordingPlatformProvider)
        .readAudio(asset.uri, maxBytes: asset.sizeBytes);
    if (_disposed) {
      return CallRecordingImportOutcome(
        asset: asset,
        ok: false,
        message: 'The import was cancelled before the file was read.',
      );
    }
    if (!bytes.isOk) {
      await _markRowFailed(api, row.id);
      return CallRecordingImportOutcome(
        asset: asset,
        ok: false,
        message: bytes.message ??
            'That file was not read, so nothing was uploaded.',
      );
    }

    final NovaRecordingUpload upload;
    try {
      upload = await api.uploadRecordingAudio(
        row.id,
        bytes.bytes!,
        asset.mimeType,
        durationSeconds: asset.durationSeconds,
      );
    } on NovaApiException catch (e) {
      return CallRecordingImportOutcome(
        asset: asset,
        ok: false,
        message: _uploadFailureMessage(e, bytes.byteLength),
      );
    }

    try {
      await api.processRecording(row.id);
    } on NovaApiException catch (e) {
      // The audio is on the server; only the kick-off failed. Say exactly that
      // rather than reporting the whole import as lost.
      return CallRecordingImportOutcome(
        asset: asset,
        ok: false,
        recordingId: row.id,
        message:
            'The audio was saved, but the server could not start transcription: '
            '${e.message}',
      );
    }

    ref.invalidate(recordingDetailProvider(row.id));
    return CallRecordingImportOutcome(
      asset: asset,
      ok: true,
      recordingId: row.id,
      message: upload.storage.objectStorage
          ? 'Uploaded and sent for transcription.'
          : 'Saved by the server and sent for transcription.',
    );
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /// Refuses a file above the server's ceiling before it is read into memory.
  ///
  /// Null means "no reason to refuse". When the server has not told us a ceiling
  /// the platform's own hard limit still applies inside `readAudio`, so an
  /// oversized file is refused either way — never truncated.
  String? _sizeRefusal(CallRecordingAsset asset) {
    if (!asset.hasSize) return null;
    final size = asset.sizeBytes!;
    final serverCeiling = state.capabilities?.maxUploadBytes ?? 0;
    if (serverCeiling > 0 && size > serverCeiling) {
      return 'That file is ${asset.sizeLabel}, above the server\'s '
          '$serverCeiling-byte limit for one upload. It was not read and was '
          'not sent.';
    }
    if (size > MethodChannelCallRecordingPlatform.maxReadableBytes) {
      return 'That file is ${asset.sizeLabel}, above the size NOVA will read in '
          'one go. It was not read and was not sent.';
    }
    return null;
  }

  String _firstFailureMessage() {
    for (final outcome in state.outcomes) {
      final message = outcome.message;
      if (!outcome.ok && message != null) return message;
    }
    return 'Nothing was imported. Nothing you did not select was read.';
  }

  String _uploadFailureMessage(NovaApiException e, int byteLength) {
    if (e.statusCode == 413) {
      return 'This recording is too large for the server ($byteLength bytes). '
          'It was not uploaded.';
    }
    if (e.statusCode == 503) {
      return 'The server could not store the audio (503): ${e.message}. The '
          'recording row is saved, but the audio is not on the server yet.';
    }
    final status = e.statusCode == null ? '' : ' (${e.statusCode})';
    return 'The audio was not uploaded$status: ${e.message}.';
  }

  Future<void> _markRowFailed(NovaApi api, String id) async {
    try {
      await api.updateRecording(id, status: 'failed');
    } catch (error) {
      debugPrint('[CallRecording] could not mark $id failed: $error');
    }
  }
}

final callRecordingControllerProvider =
    NotifierProvider<CallRecordingController, CallRecordingState>(
      CallRecordingController.new,
    );
