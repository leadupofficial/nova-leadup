import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/voice/wake_word_session.dart';

/// The wake word is only worth calling a wake word if it opens a conversation.
/// `WakeWordController` set the orb to "listening" and left the session start to
/// "whatever listens to lastDetection" — nothing did. These tests pin the rule that
/// decides when a detection opens one.
void main() {
  final t0 = DateTime(2026, 9, 20, 10, 0, 0);
  final t1 = t0.add(const Duration(seconds: 5));

  group('shouldOpenSessionFromWakeWord', () {
    test('opens a session for a fresh detection in the foreground', () {
      expect(
        shouldOpenSessionFromWakeWord(
          appInForeground: true,
          turnActive: false,
          detectionAt: t0,
          lastHandledAt: null,
        ),
        isTrue,
      );
    });

    test('ignores a detection while the app is backgrounded', () {
      expect(
        shouldOpenSessionFromWakeWord(
          appInForeground: false,
          turnActive: false,
          detectionAt: t0,
          lastHandledAt: null,
        ),
        isFalse,
      );
    });

    test('ignores a detection while a turn is already active', () {
      expect(
        shouldOpenSessionFromWakeWord(
          appInForeground: true,
          turnActive: true,
          detectionAt: t0,
          lastHandledAt: null,
        ),
        isFalse,
      );
    });

    test('handles one detection once, even if the state is republished', () {
      expect(
        shouldOpenSessionFromWakeWord(
          appInForeground: true,
          turnActive: false,
          detectionAt: t0,
          lastHandledAt: t0,
        ),
        isFalse,
      );
    });

    test('opens again for a later detection', () {
      expect(
        shouldOpenSessionFromWakeWord(
          appInForeground: true,
          turnActive: false,
          detectionAt: t1,
          lastHandledAt: t0,
        ),
        isTrue,
      );
    });
  });

  test('the wake word route matches the converse entry in the router', () {
    expect(wakeWordConverseRoute, '/converse');
  });
}
