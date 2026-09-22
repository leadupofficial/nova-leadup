/// Whether a wake-word detection should open a conversation.
///
/// The wake word used to be a dead end: `WakeWordService.kt` emitted the detection
/// over the `nova/wake_word` channel, `WakeWordController` set the avatar to
/// "listening" and left a comment saying *"the conversation flow is started by
/// whatever listens to `lastDetection`"* — and nothing anywhere listened. A user could
/// say the wake word and get an animation, never a session.
///
/// Three conditions decide whether a detection opens one:
///
/// * [appInForeground] — the microphone is opened from the Flutter engine. Starting a
///   turn while the app is backgrounded is not something this app does; on that path the
///   native service posts its own high-priority notification
///   (`WakeWordService.onWakeWordDetected`), which is the honest signal.
/// * [turnActive] — a detection that arrives mid-conversation must not restart it.
/// * [detectionAt] vs [lastHandledAt] — one detection is handled once, even though the
///   controller republishes its state (and therefore re-notifies listeners) for other
///   reasons.
///
/// Kept as a pure function so the rule is unit-tested without a socket, a platform
/// channel or a device.
bool shouldOpenSessionFromWakeWord({
  required bool appInForeground,
  required bool turnActive,
  required DateTime detectionAt,
  required DateTime? lastHandledAt,
  /// When set, a detection older than this no longer opens anything.
  ///
  /// Needed for the background case: hearing "Hey Nova" while the app is closed
  /// posts a "tap to talk" notification, and the tap is honoured when the app comes
  /// forward. Without a bound, a detection from an hour ago would ambush the user
  /// with a listening session the next time they opened NOVA for something else.
  Duration? maxAge,
  /// Injected so the window can be tested without waiting.
  DateTime? now,
}) {
  if (!appInForeground) return false;
  if (turnActive) return false;
  if (detectionAt == lastHandledAt) return false;
  if (maxAge != null) {
    final age = (now ?? DateTime.now()).difference(detectionAt);
    if (age > maxAge) return false;
  }
  return true;
}

/// The route a detection opens. Must match the converse entry in `app/router.dart`;
/// the unit test asserts the literal so the two cannot drift silently.
const String wakeWordConverseRoute = '/converse';

/// How long a background detection stays worth acting on.
///
/// A notification the user taps promptly opens a session; one they come back to
/// much later does not, because starting to listen without being asked is worse
/// than ignoring a stale nudge.
const Duration wakeWordSessionFreshness = Duration(seconds: 90);

/// What Home should say under "Tap to talk", and whether it should be tappable.
///
/// Home used to print `or say "Hey Nova"` whenever a wake-word model was
/// *installed*, regardless of the user's choice. Measured on a fresh install: the
/// wake word screen read **"WAKE WORD IS OFF"** while Home advertised the phrase
/// directly above the button, so every new user was told to say something the app
/// was not listening for.
///
/// The phrase is only advertised while the service is actually listening, and
/// every other state offers the way to turn it on.
({String text, bool actionable}) wakeWordHomeLine({
  required String? phrase,
  required bool enabled,
  required bool listening,
}) {
  if (phrase == null || !enabled) {
    // The status row already states that it is off, so this line is the action
    // rather than a second announcement of the same fact.
    return (text: 'Tap to turn on the wake word', actionable: true);
  }
  // Kept as "Listening for …" so the hint and the status row agree rather than
  // saying two different things about the same state.
  if (listening) return (text: 'Listening for "$phrase"', actionable: false);
  // Enabled but not yet running: say that rather than promise something the
  // service has not started doing.
  return (text: 'Starting wake word…', actionable: false);
}
