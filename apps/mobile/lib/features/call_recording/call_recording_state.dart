import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/models.dart';
import 'call_recording_models.dart';
import 'call_recording_platform.dart';
import 'call_recording_settings_store.dart';

export 'call_recording_models.dart';

/// Native transport for the call-recording folder.
///
/// Only Android has an implementation (`NovaCallRecordingFolder.kt`). Elsewhere
/// the app gets [UnsupportedCallRecordingPlatform], which reports
/// `unsupported` so the screen explains the situation instead of offering a
/// picker that could never open. Override in tests with a fake.
final callRecordingPlatformProvider = Provider<CallRecordingPlatform>((ref) {
  final platform = defaultTargetPlatform == TargetPlatform.android
      ? MethodChannelCallRecordingPlatform()
      : const UnsupportedCallRecordingPlatform();
  ref.onDispose(platform.dispose);
  return platform;
});

/// Reads and writes the four persisted keys.
final callRecordingSettingsStoreProvider = Provider<CallRecordingSettingsStore>(
  (ref) => CallRecordingSettingsStore(ref.watch(sharedPreferencesProvider)),
);

/// What one file's trip through the pipeline produced.
@immutable
class CallRecordingImportOutcome {
  const CallRecordingImportOutcome({
    required this.asset,
    required this.ok,
    this.recordingId,
    this.message,
  });

  final CallRecordingAsset asset;
  final bool ok;

  /// Present only when the whole sequence succeeded, so the screen can open the
  /// summary the pipeline wrote.
  final String? recordingId;

  /// Why it failed, in the server's or Android's own words.
  final String? message;
}

/// Everything the call-recording screen renders.
@immutable
class CallRecordingState {
  const CallRecordingState({
    this.settings = const CallRecordingSettings(),
    this.status = CallRecordingCode.supported,
    this.discovered = const <CallRecordingAsset>[],
    this.selected = const <String>{},
    this.outcomes = const <CallRecordingImportOutcome>[],
    this.capabilities,
    this.scanStatus,
    this.scanMessage,
    this.consentAcknowledged = false,
    this.busy = false,
    this.importing = false,
    this.error,
  });

  final CallRecordingSettings settings;

  /// What this platform can do. `unsupported` outside Android.
  final CallRecordingCode status;

  /// Audio files in the chosen folder. Empty until the user scans.
  final List<CallRecordingAsset> discovered;

  /// The document URIs the user ticked. Nothing is uploaded that is not here.
  final Set<String> selected;

  /// Results of the current session's imports, newest first.
  final List<CallRecordingImportOutcome> outcomes;

  /// What the server says it can do, used to refuse an oversized file before it
  /// is read rather than after a wasted upload.
  final NovaRecordingCapabilities? capabilities;

  /// The outcome of the last scan, so "empty folder" and "could not read" are
  /// distinguishable.
  final CallRecordingCode? scanStatus;
  final String? scanMessage;

  /// Whether the user ticked the consent acknowledgement **this session**. Never
  /// persisted: the disclosure is re-read every time the screen opens.
  final bool consentAcknowledged;

  final bool busy;
  final bool importing;
  final String? error;

  bool get isSupported => status != CallRecordingCode.unsupported;
  bool get hasFolder => settings.hasFolder;
  bool get isEnabled => settings.enabled;
  bool get folderRevokedWithoutFolder => settings.enabled && !settings.hasFolder;

  /// Files in the folder that this device has not imported before.
  List<CallRecordingAsset> get newAssets => discovered
      .where((a) => !settings.importedFileIds.contains(a.uri))
      .toList();

  /// The files the user ticked, in the order they were discovered.
  List<CallRecordingAsset> get selectedAssets => discovered
      .where((a) => selected.contains(a.uri))
      .toList();

  bool get canScan =>
      isSupported && hasFolder && !busy && !importing && consentAcknowledged;

  bool get canImport => selectedAssets.isNotEmpty && !busy && !importing;

  /// The shortest honest summary of what this screen does, for the top of the
  /// page and for the settings row that links here.
  String get statusLabel {
    if (!isSupported) return 'Not available on this device';
    if (!hasFolder) return 'No folder chosen';
    if (!isEnabled) return 'Paused';
    return 'On — reading ${settings.folder!.displayName}';
  }

  CallRecordingState copyWith({
    CallRecordingSettings? settings,
    CallRecordingCode? status,
    List<CallRecordingAsset>? discovered,
    Set<String>? selected,
    List<CallRecordingImportOutcome>? outcomes,
    NovaRecordingCapabilities? capabilities,
    CallRecordingCode? scanStatus,
    String? scanMessage,
    bool? consentAcknowledged,
    bool? busy,
    bool? importing,
    String? error,
    bool clearError = false,
    bool clearScanMessage = false,
  }) {
    return CallRecordingState(
      settings: settings ?? this.settings,
      status: status ?? this.status,
      discovered: discovered ?? this.discovered,
      selected: selected ?? this.selected,
      outcomes: outcomes ?? this.outcomes,
      capabilities: capabilities ?? this.capabilities,
      scanStatus: scanStatus ?? this.scanStatus,
      scanMessage: clearScanMessage ? null : (scanMessage ?? this.scanMessage),
      consentAcknowledged: consentAcknowledged ?? this.consentAcknowledged,
      busy: busy ?? this.busy,
      importing: importing ?? this.importing,
      error: clearError ? null : (error ?? this.error),
    );
  }
}
