import 'package:flutter/foundation.dart';

import 'device_control_models.dart';

/// Maps a spoken request onto a device action.
///
/// ## Why this is a pure function
///
/// The mapping from words to an action is the part that gets things *wrong* — a
/// "turn on Wi-Fi" that quietly becomes a toggle, or a "call Priya" that dials a
/// stranger. Keeping it a pure function over the transcript means every phrase
/// is pinned by `device_control_voice_commands_test.dart`, away from the socket
/// and the UI.
///
/// ## What it deliberately refuses
///
///  * **Wi-Fi / Bluetooth toggles** map to the settings deep link, with
///    [DeviceVoiceCommand.honestNote] set, because Android does not let a
///    third-party app flip those switches. The caller shows the note; it never
///    reports a toggle that did not happen.
///  * **"Call Priya"** does not match at all. Resolving a contact name needs
///    `READ_CONTACTS`, which NOVA does not request; only a number the transcript
///    already contains is dialled.
///  * **SMS** and **screen reading** have no mapping — they are not features.
@immutable
class DeviceVoiceCommand {
  const DeviceVoiceCommand({
    required this.action,
    required this.summary,
    this.app,
    this.uri,
    this.number,
    this.panel,
    this.brightness,
    this.brightnessDelta,
    this.dndEnabled,
    this.toggleDnd = false,
    this.honestNote,
  });

  final DeviceAction action;

  /// What NOVA will say it is about to do, in words.
  final String summary;

  final String? app;
  final String? uri;
  final String? number;
  final DeviceSettingsPanel? panel;

  /// Absolute 0.0–1.0 request, when the transcript named a level.
  final double? brightness;

  /// Relative change, when the transcript said "brighter"/"dimmer".
  final double? brightnessDelta;

  final bool? dndEnabled;

  /// "toggle do not disturb" — resolved against the current state.
  final bool toggleDnd;

  /// Set when Android cannot do what was asked and the best NOVA can do is open
  /// the screen where the user does it. The caller must show this instead of
  /// claiming success.
  final String? honestNote;

  bool get deepLinkOnly => honestNote != null;

  /// True when the command cannot be turned into a request without reading the
  /// current device state (a relative brightness or a DND toggle).
  bool get needsCurrentState =>
      toggleDnd || (brightnessDelta != null && brightness == null);

  /// Builds the concrete request, or null when the state it needs is unknown.
  DeviceActionRequest? resolve(DeviceControlStatus? status) {
    if (action == DeviceAction.setDnd) {
      if (toggleDnd) {
        final current = status?.dndEnabled;
        if (current == null) return null;
        return DeviceActionRequest.dnd(!current);
      }
      return DeviceActionRequest.dnd(dndEnabled ?? false);
    }
    if (action == DeviceAction.setBrightness && brightness == null) {
      final delta = brightnessDelta;
      final current = status?.brightness;
      if (delta == null || current == null) return null;
      final next = (current / 255.0 + delta).clamp(0.0, 1.0);
      return DeviceActionRequest.brightness(next);
    }
    return switch (action) {
      DeviceAction.openApp => DeviceActionRequest.openApp(app ?? ''),
      DeviceAction.openDeepLink => DeviceActionRequest.openDeepLink(uri ?? ''),
      DeviceAction.openSettings => DeviceActionRequest.openPanel(
        panel ?? DeviceSettingsPanel.sound,
      ),
      DeviceAction.dialNumber => DeviceActionRequest.dial(number ?? ''),
      DeviceAction.setBrightness => DeviceActionRequest.brightness(
        brightness ?? 0,
      ),
      DeviceAction.setDnd => DeviceActionRequest.dnd(dndEnabled ?? false),
      DeviceAction.mediaPlay ||
      DeviceAction.mediaPause ||
      DeviceAction.mediaNext ||
      DeviceAction.mediaPrevious => DeviceActionRequest(action),
      // Executed in Dart by the recorder; the request only carries the action so
      // the level gate and the confirmation sheet have something to show.
      DeviceAction.startRecording ||
      DeviceAction.stopRecording => DeviceActionRequest(action),
    };
  }
}

/// The phrases the control screen shows as examples, and the tests pin.
const List<String> kDeviceVoiceExamples = <String>[
  'open WhatsApp',
  'open https://nova.leadup.tech',
  'call 9876543210',
  'turn on do not disturb',
  'set brightness to 40%',
  'brighter',
  'pause the music',
  'next track',
  'open Wi-Fi settings',
];

/// Matches [transcript] against the device-control vocabulary.
///
/// Returns null when nothing matches, so an ordinary conversational sentence is
/// never silently turned into a device action.
DeviceVoiceCommand? matchDeviceVoiceCommand(String transcript) {
  final original = transcript.trim();
  // Phrase matching runs on a normalised copy; URL, number and app-name
  // extraction runs on the original, because lower-casing or stripping
  // punctuation would corrupt the payload the action needs.
  final normalized = _normalize(original);
  if (normalized.isEmpty) return null;

  return _matchDnd(normalized) ??
      _matchBrightness(normalized) ??
      _matchMedia(normalized) ??
      // Must run before _matchOpenApp: "start recording" otherwise looks like a
      // request to launch an app called "recording".
      _matchRecording(normalized) ??
      _matchCall(original) ??
      _matchDeepLink(original) ??
      _matchWifiBluetooth(normalized) ??
      _matchOpenApp(original);
}

// ─── Phrase groups, checked in order ──────────────────────────────────────
//
// Order is the safety property: "open Wi-Fi settings" must reach the settings
// deep link before the generic "open <app>" rule sees an app called
// "wi-fi settings", and "open https://…" must reach the link rule before it.

DeviceVoiceCommand? _matchDnd(String text) {
  if (!_mentionsDnd(text)) return null;

  if (text.contains('toggle')) {
    return const DeviceVoiceCommand(
      action: DeviceAction.setDnd,
      toggleDnd: true,
      summary: 'Toggle Do Not Disturb.',
    );
  }

  final wantsOff = _hasAny(text, const <String>[
    'turn off',
    'switch off',
    'disable',
    'stop',
    'off',
  ]);
  final wantsOn = _hasAny(text, const <String>[
    'turn on',
    'switch on',
    'enable',
    'on',
  ]);

  // "off" and "on" both appear in "turn off"/"turn on"; the longer phrase is
  // tested first so the intent is never inverted.
  if (wantsOff && !text.contains('turn on') && !text.contains('switch on')) {
    return const DeviceVoiceCommand(
      action: DeviceAction.setDnd,
      dndEnabled: false,
      summary: 'Turn Do Not Disturb off.',
    );
  }
  if (wantsOn || text.contains('turn on') || text.contains('switch on')) {
    return const DeviceVoiceCommand(
      action: DeviceAction.setDnd,
      dndEnabled: true,
      summary: 'Turn Do Not Disturb on.',
    );
  }
  return null;
}

bool _mentionsDnd(String text) =>
    text.contains('do not disturb') ||
    text.contains('dnd') ||
    text.contains('silent mode');

DeviceVoiceCommand? _matchBrightness(String text) {
  // "brightness"/"bright" names the control outright; "dim" only does when a
  // screen is named, so "dim sum recipe" is not a brightness command.
  final mentionsBrightness = text.contains('bright');
  final dimsScreen =
      text.contains('dim') &&
      (text.contains('screen') || text.contains('display'));
  if (!mentionsBrightness && !dimsScreen) return null;

  if (_hasAny(text, const <String>['max', 'maximum', 'full', 'brightest'])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.setBrightness,
      brightness: 1.0,
      summary: 'Set the screen brightness to maximum.',
    );
  }
  if (_hasAny(text, const <String>['min', 'minimum', 'lowest', 'dimmest'])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.setBrightness,
      brightness: 0.0,
      summary: 'Set the screen brightness to minimum.',
    );
  }

  final match = RegExp(r'(\d{1,3})\s*%?').firstMatch(text);
  if (match != null) {
    final percent = int.tryParse(match.group(1) ?? '');
    if (percent != null && percent <= 100) {
      final value = percent / 100.0;
      return DeviceVoiceCommand(
        action: DeviceAction.setBrightness,
        brightness: value,
        summary: 'Set the screen brightness to $percent%.',
      );
    }
  }

  if (_hasAny(text, const <String>['increase', 'raise', 'up', 'brighter'])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.setBrightness,
      brightnessDelta: 0.15,
      summary: 'Raise the screen brightness.',
    );
  }
  if (_hasAny(text, const <String>[
    'decrease',
    'lower',
    'down',
    'dim',
    'dimmer',
  ])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.setBrightness,
      brightnessDelta: -0.15,
      summary: 'Lower the screen brightness.',
    );
  }
  return null;
}

DeviceVoiceCommand? _matchMedia(String text) {
  if (_hasAny(text, const <String>[
    'next track',
    'next song',
    'skip track',
    'skip song',
    'skip this',
  ])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.mediaNext,
      summary: 'Skip to the next track.',
    );
  }
  if (_hasAny(text, const <String>[
    'previous track',
    'previous song',
    'go back a track',
    'last track',
    'back a song',
  ])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.mediaPrevious,
      summary: 'Go back to the previous track.',
    );
  }
  if (_hasAny(text, const <String>['pause', 'stop the music', 'stop music'])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.mediaPause,
      summary: 'Pause the music.',
    );
  }
  if (_hasAny(text, const <String>[
    'resume',
    'play music',
    'play the music',
    'play a song',
  ])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.mediaPlay,
      summary: 'Resume playback.',
    );
  }
  return null;
}

DeviceVoiceCommand? _matchRecording(String text) {
  if (_hasAny(text, const <String>[
    'start recording',
    'start a recording',
    'start recording this meeting',
    'record this meeting',
    'record the meeting',
    'begin recording',
  ])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.startRecording,
      summary: 'Start recording this meeting.',
    );
  }
  if (_hasAny(text, const <String>[
    'stop recording',
    'stop the recording',
    'end recording',
    'end the recording',
    'finish recording',
    'finish the recording',
  ])) {
    return const DeviceVoiceCommand(
      action: DeviceAction.stopRecording,
      summary: 'Stop the current recording.',
    );
  }
  return null;
}

DeviceVoiceCommand? _matchCall(String original) {
  final match = RegExp(
    r'^(?:call|dial|phone)\s+(.+)$',
    caseSensitive: false,
  ).firstMatch(original);
  if (match == null) return null;

  final raw = match.group(1)?.trim() ?? '';
  if (!_looksDialable(raw)) {
    // "call Priya" — NOVA has no contacts permission and must not guess a
    // number. Not a device command at all.
    return null;
  }
  return DeviceVoiceCommand(
    action: DeviceAction.dialNumber,
    number: raw,
    summary: 'Open the dialer with $raw.',
  );
}

bool _looksDialable(String value) {
  final digits = value.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.length < 3) return false;
  return RegExp(r'^[+0-9][0-9\s\-()*#,;.]*$').hasMatch(value);
}

DeviceVoiceCommand? _matchWifiBluetooth(String text) {
  final wifi =
      text.contains('wifi') || text.contains('wi-fi') || text.contains('wi fi');
  final bluetooth = text.contains('bluetooth');

  if (wifi) {
    return DeviceVoiceCommand(
      action: DeviceAction.openSettings,
      panel: DeviceSettingsPanel.wifi,
      summary: 'Open the Wi-Fi screen.',
      honestNote: text.contains('settings') || text.contains('open')
          ? null
          : 'Android 10 removed programmatic Wi-Fi toggling for third-party apps, '
                'so NOVA cannot switch Wi-Fi on or off. Opening the Wi-Fi screen instead.',
    );
  }
  if (bluetooth) {
    return DeviceVoiceCommand(
      action: DeviceAction.openSettings,
      panel: DeviceSettingsPanel.bluetooth,
      summary: 'Open the Bluetooth screen.',
      honestNote: text.contains('settings') || text.contains('open')
          ? null
          : 'Android 12 made Bluetooth enable() and disable() no-ops for '
                'third-party apps, so NOVA cannot switch Bluetooth on or off. '
                'Opening the Bluetooth screen instead.',
    );
  }
  return null;
}

DeviceVoiceCommand? _matchDeepLink(String original) {
  // Run against the original text: normalising would strip the `.` and `:` a URL
  // is made of.
  final match = RegExp(
    r'(https?://\S+|[a-z][a-z0-9+.\-]*://\S+)',
    caseSensitive: false,
  ).firstMatch(original);
  if (match == null) return null;
  final uri = match.group(1)!;
  return DeviceVoiceCommand(
    action: DeviceAction.openDeepLink,
    uri: uri,
    summary: 'Open $uri.',
  );
}

DeviceVoiceCommand? _matchOpenApp(String original) {
  final match = RegExp(
    r'^(?:open|launch|start|go to)\s+(.+)$',
    caseSensitive: false,
  ).firstMatch(original);
  if (match == null) return null;
  final app = (match.group(1) ?? '').trim();
  if (app.isEmpty) return null;

  // A sentence that merely begins with "open" is not a request to open an app.
  // The cap on length and the leading-word blocklist are what stop "open up
  // about your day" from launching something called "up about your day".
  final words = app.split(RegExp(r'\s+'));
  if (words.length > _maxAppNameWords) return null;
  if (_nonAppLeadingWords.contains(words.first.toLowerCase())) return null;

  return DeviceVoiceCommand(
    action: DeviceAction.openApp,
    app: app,
    summary: 'Open $app.',
  );
}

/// Longest app name the mapper will accept from speech ("whatsapp business").
const int _maxAppNameWords = 3;

/// Words that begin a sentence, not an app name.
const Set<String> _nonAppLeadingWords = <String>{
  'up',
  'it',
  'them',
  'me',
  'the',
  'a',
  'an',
  'that',
  'this',
  'your',
  'my',
  'about',
  'and',
  'to',
};

// ─── Text helpers ─────────────────────────────────────────────────────────

String _normalize(String transcript) {
  return transcript
      .toLowerCase()
      .replaceAll(RegExp(r'[!?.,;:"]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
}

bool _hasAny(String text, List<String> needles) =>
    needles.any((String needle) => text.contains(needle));
