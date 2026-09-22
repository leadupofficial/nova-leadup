import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/theme/nova_theme.dart';
import 'package:nova_mobile/core/voice/wake_word_controller.dart';
import 'package:nova_mobile/core/voice/wake_word_service.dart';
import 'package:nova_mobile/features/home/home_page.dart';
import 'package:nova_mobile/features/reminders/notifications_blocked_notice.dart';
import 'package:nova_mobile/features/reminders/reminder_reconciler.dart';
import 'package:nova_mobile/features/reminders/reminder_sync.dart';

import '../helpers/test_harness.dart';

/// The home dashboard's "Wake word" row in the Status card.
///
/// The defect this pins (D1): the row rendered `WakeWordAvailability.userMessage`,
/// which answers *"Listening for `<model>`."* whenever `reason == 'ok'` — that is,
/// whenever a wake word is merely **installed**. A device with the wake word switched
/// off was therefore told it was listening, and the row showed the raw asset key
/// (`hey_nova`) while the line under "Tap to talk" showed the humanised phrase
/// (`Hey Nova`), so the screen contradicted itself.
///
/// The row must now state what the wake word is actually doing, using the same
/// humanised phrase as every other surface, and must keep the native reason message
/// when detection genuinely failed (covered in `wake_word_controller_test.dart`,
/// which pins `WakeWordState.statusMessage` for every state).
void main() {
  /// The shipped build: one installed wake word, `hey_nova`.
  const shipped = WakeWordAvailability(
    available: true,
    reason: 'ok',
    models: <String>['hey_nova'],
    selected: 'hey_nova',
  );

  Future<void> pumpHome(WidgetTester tester, {bool enabled = false}) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(
      preferences: enabled
          ? <String, Object>{WakeWordController.enabledPreferenceKey: true}
          : const <String, Object>{},
      wakeWordAvailability: shipped,
    );
    addTearDown(deps.dispose);

    await tester.pumpWidget(
      testScope(
        deps,
        MaterialApp(theme: NovaTheme.darkTheme, home: const HomePage()),
        networkService: emptyApiNetworkService(),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('does not say "listening" while the wake word is switched off', (
    tester,
  ) async {
    await pumpHome(tester);

    // The switch is off, so the row says so...
    expect(_status(tester), 'Wake word is off');
    // ...and nothing anywhere on the screen claims to be listening.
    expect(find.textContaining('Listening for'), findsNothing);

    // The installed phrase is still named, humanised, by the line under "Tap to talk".
    expect(find.text('or say "Hey Nova"'), findsOneWidget);

    // The raw asset key must not leak into the UI.
    expect(find.textContaining('hey_nova'), findsNothing);
  });

  testWidgets('says it is listening, by phrase, only when it really is', (
    tester,
  ) async {
    await pumpHome(tester, enabled: true);

    expect(_status(tester), 'Listening for "Hey Nova"');
    // The row and the line under "Tap to talk" now agree instead of contradicting
    // each other, which is what the raw identifier produced.
    expect(find.text('Listening for "Hey Nova"'), findsNWidgets(2));
    expect(find.textContaining('hey_nova'), findsNothing);
  });

  /// Pump Home with the reconcile pass already reporting a blocked OS
  /// notification permission, and nothing reaching a platform channel.
  Future<void> pumpHomeWithBlockedNotifications(
    WidgetTester tester, {
    required bool blocked,
  }) async {
    useTallSurface(tester);
    final deps = await createTestDependencies(wakeWordAvailability: shipped);
    addTearDown(deps.dispose);

    await tester.pumpWidget(
      testScope(
        deps,
        MaterialApp(
          theme: NovaTheme.darkTheme,
          home: ProviderScope(
            overrides: [
              // The result the reconciler produces, handed over directly: the
              // Status card's contract is to render it, not to produce it.
              reminderSyncProvider.overrideWithBuild(
                (ref, notifier) => ReminderSyncState(
                  lastResult: ReminderReconciliation(
                    scheduled: blocked ? 1 : 1,
                    cancelled: 0,
                    exact: true,
                    notificationsBlocked: blocked,
                  ),
                ),
              ),
            ],
            child: const HomePage(),
          ),
        ),
        networkService: emptyApiNetworkService(),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('the Status card says so when the OS blocks notifications', (
    tester,
  ) async {
    // Home is where the user looks when a reminder did not arrive. The defect had
    // *no copy anywhere* in the app that named a denied POST_NOTIFICATIONS, so
    // this pins the consequence being stated where the reminder was expected.
    await pumpHomeWithBlockedNotifications(tester, blocked: true);

    expect(
      find.byKey(NotificationsBlockedNotice.cardKey),
      findsOneWidget,
      reason: 'the Status card must carry the warning',
    );
    expect(find.text('Reminders cannot reach you'), findsOneWidget);
    expect(find.text('Open notification settings'), findsOneWidget);
  });

  testWidgets('the Status card stays quiet when notifications are allowed', (
    tester,
  ) async {
    await pumpHomeWithBlockedNotifications(tester, blocked: false);

    expect(find.byKey(NotificationsBlockedNotice.cardKey), findsNothing);
  });
}

/// The Status card's wake-word row, read by key.
String? _status(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('wake-word-status'))).data;
