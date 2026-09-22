import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/theme/nova_theme.dart';
import 'package:nova_mobile/features/reminders/notifications_blocked_notice.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/features/reminders/reminder_reconciler.dart';
import 'package:nova_mobile/features/reminders/reminder_sync.dart';
import 'package:nova_mobile/features/reminders/reminders_page.dart';

import '../helpers/test_harness.dart';

/// N-06 — an inexact schedule has to be discoverable, and reachable to fix.
///
/// The scheduling result already says whether the OS accepted an exact alarm
/// (`ReminderReconciliation.exact`), and on real hardware it answers `false` even
/// with `SCHEDULE_EXACT_ALARM` granted: Android 13+ consults the
/// `canScheduleExactAlarms()` app-op instead, which only the user can enable. Every
/// reminder was therefore delivered 3.5–7 minutes late and nothing in the app ever
/// said so.
///
/// The disclosure must be driven by what actually happened — the reconcile
/// result — not only by a permission probe that reads "granted" on exactly the
/// devices this defect was measured on.
void main() {
  /// Runs [body] as if on Android, which is the only platform with the
  /// "Alarms & reminders" special access, and restores the flag *inside* the test
  /// body — the binding verifies foundation debug variables after the body ends,
  /// so a `tearDown` reset is too late.
  Future<void> onAndroid(Future<void> Function() body) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      await body();
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  }

  Future<void> pumpRemindersPage(
    WidgetTester tester,
    TestDependencies deps, {
    required ReminderReconciliation? lastResult,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(deps.preferences),
          authRepositoryProvider.overrideWithValue(deps.authRepository),
          onboardingServiceProvider.overrideWithValue(deps.onboardingService),
          wakeWordPlatformProvider.overrideWithValue(deps.wakeWordPlatform),
          crashReportingServiceProvider.overrideWithValue(deps.crashReporting),
          analyticsServiceProvider.overrideWithValue(deps.analytics),
          networkInfoServiceProvider.overrideWithValue(deps.networkInfo),
          healthServiceProvider.overrideWithValue(deps.healthService),
          reminderNotificationsProvider.overrideWithValue(
            deps.reminderNotifications,
          ),
          networkServiceProvider.overrideWithValue(emptyApiNetworkService()),
          // The reconcile pass is the thing under test; nothing here may reach a
          // platform channel just to set up the screen.
          reminderSyncProvider.overrideWithBuild(
            (ref, notifier) => ReminderSyncState(lastResult: lastResult),
          ),
        ],
        child: MediaQuery(
          data: const MediaQueryData(disableAnimations: true),
          child: MaterialApp(
            theme: NovaTheme.darkTheme,
            home: const RemindersPage(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('discloses an inexact schedule even when the permission reads granted', (
    tester,
  ) async {
    useTallSurface(tester);
    // The fake "OS" insists the access is granted — which is precisely the state
    // the device measurement found: permission granted, `exact=false` anyway.
    final deps = await createTestDependencies();
    deps.reminderNotifications.exactAllowed = true;
    addTearDown(deps.dispose);

    await onAndroid(() async {
      await pumpRemindersPage(
        tester,
        deps,
        lastResult: const ReminderReconciliation(
          scheduled: 1,
          cancelled: 0,
          exact: false,
        ),
      );

      expect(
        find.textContaining('Alarms & reminders'),
        findsOneWidget,
        reason:
            'the user must be able to discover that their reminders will arrive '
            'late, and reach the system screen that fixes it',
      );
    });
  });

  testWidgets('says nothing when the last schedule was exact', (tester) async {
    useTallSurface(tester);
    final deps = await createTestDependencies();
    deps.reminderNotifications.exactAllowed = true;
    addTearDown(deps.dispose);

    await onAndroid(() async {
      await pumpRemindersPage(
        tester,
        deps,
        lastResult: const ReminderReconciliation(
          scheduled: 1,
          cancelled: 0,
          exact: true,
        ),
      );

      expect(find.textContaining('Alarms & reminders'), findsNothing);
    });
  });

  testWidgets('a pass that armed nothing is not evidence of a problem', (
    tester,
  ) async {
    useTallSurface(tester);
    // `exact` is deliberately `false` here — the reconciler does not consult the
    // permission when there is nothing to arm, and a user with no due reminders
    // must never be sent to the "Alarms & reminders" screen.
    final deps = await createTestDependencies();
    deps.reminderNotifications.exactAllowed = true;
    addTearDown(deps.dispose);

    await onAndroid(() async {
      await pumpRemindersPage(
        tester,
        deps,
        lastResult: const ReminderReconciliation(
          scheduled: 0,
          cancelled: 0,
          exact: false,
        ),
      );

      expect(find.textContaining('Alarms & reminders'), findsNothing);
    });
  });

  group('a denied POST_NOTIFICATIONS is disclosed, in plain language', () {
    /// The other half of "the reminder never arrived". The reconciler still
    /// reports `scheduled: N`, `AlarmManager` still holds the alarm, and Android
    /// discards the notification at post time — measured on the OnePlus 9R with
    /// `dumpsys notification | grep pkg=com.leadup.nova` empty while polling every
    /// 20s. Nothing in the app said so, because the reminder path never checked
    /// the permission at all.
    testWidgets('the warning is shown when the OS is blocking notifications', (
      tester,
    ) async {
      useTallSurface(tester);
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      await onAndroid(() async {
        await pumpRemindersPage(
          tester,
          deps,
          lastResult: const ReminderReconciliation(
            // Armed, and it will still not arrive: the alarm is not the broken half.
            scheduled: 2,
            cancelled: 0,
            exact: true,
            notificationsBlocked: true,
          ),
        );

        expect(
          find.byKey(NotificationsBlockedNotice.cardKey),
          findsOneWidget,
          reason:
              'the user has to be told their reminders cannot reach them, in '
              'copy that names the consequence rather than the permission',
        );
        expect(
          find.textContaining('blocking'),
          findsWidgets,
          reason: 'the copy says what is happening in plain words',
        );
        expect(
          find.text('Open notification settings'),
          findsOneWidget,
          reason:
              'a permanently denied permission can only be re-granted in '
              'Android settings, so the warning must route there',
        );
      });
    });

    testWidgets('the settings button opens the system notification screen', (
      tester,
    ) async {
      useTallSurface(tester);
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      await onAndroid(() async {
        await pumpRemindersPage(
          tester,
          deps,
          lastResult: const ReminderReconciliation(
            scheduled: 1,
            cancelled: 0,
            exact: true,
            notificationsBlocked: true,
          ),
        );

        await tester.tap(find.text('Open notification settings'));
        await tester.pumpAndSettle();

        expect(
          deps.reminderNotifications.settingsOpened,
          1,
          reason: 'the warning must lead somewhere the user can act',
        );
      });
    });

    testWidgets('nothing is shown when the OS is posting notifications', (
      tester,
    ) async {
      useTallSurface(tester);
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      await onAndroid(() async {
        await pumpRemindersPage(
          tester,
          deps,
          lastResult: const ReminderReconciliation(
            scheduled: 3,
            cancelled: 0,
            exact: true,
            notificationsBlocked: false,
          ),
        );

        expect(find.byKey(NotificationsBlockedNotice.cardKey), findsNothing);
        expect(find.text('Open notification settings'), findsNothing);
      });
    });

    testWidgets('nothing is shown before a pass has run', (tester) async {
      // A card that may be wrong is worse than no card: with no result there is
      // nothing to have read from the OS.
      useTallSurface(tester);
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);

      await onAndroid(() async {
        await pumpRemindersPage(tester, deps, lastResult: null);

        expect(find.byKey(NotificationsBlockedNotice.cardKey), findsNothing);
      });
    });
  });
}
