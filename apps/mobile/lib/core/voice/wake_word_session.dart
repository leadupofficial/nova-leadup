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
}) {
  if (!appInForeground) return false;
  if (turnActive) return false;
  return detectionAt != lastHandledAt;
}

/// The route a detection opens. Must match the converse entry in `app/router.dart`;
/// the unit test asserts the literal so the two cannot drift silently.
const String wakeWordConverseRoute = '/converse';
