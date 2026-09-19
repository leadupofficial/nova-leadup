import 'package:shared_preferences/shared_preferences.dart';

import 'call_recording_models.dart';

/// Everything call-recording import persists.
///
/// Deliberately small and deliberately dull: a switch, the folder the user
/// chose, and which files have already been imported. Nothing about a call is
/// stored here — no phone number, no contact, no transcript.
class CallRecordingSettings {
  const CallRecordingSettings({
    this.enabled = false,
    this.folder,
    this.importedFileIds = const <String>{},
  });

  /// Off until the user has read the disclosure, granted a folder and turned it
  /// on. A fresh install has no folder and monitors nothing.
  final bool enabled;

  /// The folder the user granted, or null. This is the only location NOVA will
  /// ever read from, and only these files are ever listed.
  final CallRecordingFolderRef? folder;

  /// Document URIs of files already imported, so "new since last scan" is a
  /// real answer rather than a re-upload. Bounded; see [importedLimit].
  final Set<String> importedFileIds;

  bool get hasFolder => folder != null;

  /// True only when the feature is on *and* a folder is still granted: an
  /// enabled flag with no folder reads nothing, and the screen says so.
  bool get canRead => enabled && hasFolder;

  CallRecordingSettings copyWith({
    bool? enabled,
    CallRecordingFolderRef? folder,
    Set<String>? importedFileIds,
    bool clearFolder = false,
  }) {
    return CallRecordingSettings(
      enabled: enabled ?? this.enabled,
      folder: clearFolder ? null : (folder ?? this.folder),
      importedFileIds: importedFileIds ?? this.importedFileIds,
    );
  }
}

/// The only place call-recording import reads or writes persistent state.
///
/// ## What is stored, and what is never stored
///
/// Four values, and none of them is a transcript, a summary or a phone number:
///
///  * [enabledKey] — the master switch (absent, which reads as false, on a fresh
///    install);
///  * [folderUriKey] — the SAF tree URI the user granted;
///  * [folderNameKey] — that folder's display name, so the screen can name it
///    without querying Android first;
///  * [importedKey] — the document URIs already imported.
///
/// ## What is *not* stored, on purpose
///
/// The consent acknowledgement is **not** persisted. Like the meeting recorder's
/// §9.5 reminder, it is re-read and re-ticked in front of the user each session,
/// so a restored backup or an old preferences file can never turn this on
/// silently. The audio bytes are never stored either — a file is read, uploaded
/// through the existing pipeline and dropped.
class CallRecordingSettingsStore {
  CallRecordingSettingsStore(this._prefs);

  /// Master switch. Off unless the user turned it on in front of the disclosure.
  static const String enabledKey = 'nova_call_recording_import_enabled';

  /// The persisted SAF tree URI.
  static const String folderUriKey = 'nova_call_recording_folder_uri';

  /// The chosen folder's display name.
  static const String folderNameKey = 'nova_call_recording_folder_name';

  /// Document URIs already imported, newest last.
  static const String importedKey = 'nova_call_recording_imported';

  /// Every key this feature owns. Used by tests to assert nothing else was
  /// written.
  static const List<String> allKeys = <String>[
    enabledKey,
    folderUriKey,
    folderNameKey,
    importedKey,
  ];

  /// How many imported document URIs are remembered. Beyond this the oldest are
  /// dropped, so the list cannot grow without bound in long-lived installs.
  static const int importedLimit = 300;

  final SharedPreferences _prefs;

  /// Reads the stored settings, sanitised.
  ///
  /// An `enabled` flag with no folder reads as enabled-but-unreadable rather
  /// than being silently rewritten, so the screen can explain the state instead
  /// of the controller quietly forgetting it.
  CallRecordingSettings read() {
    final uri = (_prefs.getString(folderUriKey) ?? '').trim();
    final name = (_prefs.getString(folderNameKey) ?? '').trim();
    return CallRecordingSettings(
      enabled: _prefs.getBool(enabledKey) ?? false,
      folder: uri.isEmpty
          ? null
          : CallRecordingFolderRef(treeUri: uri, displayName: name),
      importedFileIds:
          (_prefs.getStringList(importedKey) ?? const <String>[]).toSet(),
    );
  }

  /// Turns the feature on or off. Turning it off keeps the folder grant, so the
  /// user does not have to find it again to switch back on.
  Future<void> setEnabled(bool enabled) =>
      _prefs.setBool(enabledKey, enabled);

  /// Remembers the folder the user chose, replacing any previous one.
  ///
  /// A different folder clears [importedKey]: "already imported" is only
  /// meaningful within one folder, and carrying ids across would silently mark a
  /// different folder's files as done.
  Future<void> setFolder(CallRecordingFolderRef folder) async {
    final previous = (_prefs.getString(folderUriKey) ?? '').trim();
    await _prefs.setString(folderUriKey, folder.treeUri);
    await _prefs.setString(folderNameKey, folder.displayName);
    if (previous != folder.treeUri) {
      await _prefs.setStringList(importedKey, const <String>[]);
    }
  }

  /// Forgets the folder and turns the feature off.
  Future<void> clearFolder() async {
    await _prefs.setBool(enabledKey, false);
    await _prefs.remove(folderUriKey);
    await _prefs.remove(folderNameKey);
    await _prefs.setStringList(importedKey, const <String>[]);
  }

  /// Records that [fileIds] were imported, bounding the stored list.
  Future<void> markImported(Iterable<String> fileIds) async {
    final existing = _prefs.getStringList(importedKey) ?? const <String>[];
    final merged = <String>[...existing];
    for (final id in fileIds) {
      if (id.isEmpty || merged.contains(id)) continue;
      merged.add(id);
    }
    final bounded = merged.length <= importedLimit
        ? merged
        : merged.sublist(merged.length - importedLimit);
    await _prefs.setStringList(importedKey, bounded);
  }
}
