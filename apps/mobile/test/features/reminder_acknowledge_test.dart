import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/features/reminders/reminder_reconciler.dart';
import 'package:nova_mobile/features/reminders/reminder_sync.dart';

import '../helpers/test_harness.dart';

/// Reporting that a reminder notification was opened.
///
/// `reminders.triggered_at` sat unwritten from the day the column was created, so the
/// Admin Control Center's "reminders executed" figure could not be computed at all and
/// the reminder revision history had no "fired" step. The server half is
/// `POST /api/v1/reminders/:id/acknowledge`; these tests pin the client half:
///
///  * a notification carries the reminder's *server* id, because the notification id is
///    a 30-bit hash and cannot be turned back into a UUID;
///  * a tap reports it, through the same `ReminderSyncController` that owns every other
///    reminder interaction;
///  * a failed report is swallowed, because the tap can cold-start the process with no
///    session yet and the callback it runs from is a platform-channel handler whose
///    exceptions are discarded with no record.
void main() {
  const signedIn = <String, String>{
    'auth_token':
        '{"access_token":"a","refresh_token":"r","expires_at":"2099-01-01T00:00:00.000"}',
    'auth_user': '{"id":"user-1","email":"alex@example.com","name":"Alex"}',
  };

  Map<String, dynamic> reminderJson(String id, DateTime at) => <String, dynamic>{
    'id': id,
    'title': 'Call $id',
    'triggerAt': at.toUtc().toIso8601String(),
  };

  /// Records every request and answers the reminder routes the way the real ones do.
  ///
  /// `acknowledgeStatus` lets a test make the report fail without changing anything
  /// else, which is the case that must not surface to the user.
  FakeHttpAdapter adapter({
    required List<RequestOptions> seen,
    required List<Map<String, dynamic>> reminders,
    int acknowledgeStatus = 200,
  }) {
    return FakeHttpAdapter((options) async {
      seen.add(options);
      if (options.path.endsWith('/acknowledge')) {
        if (acknowledgeStatus != 200) {
          throw DioException(
            requestOptions: options,
            response: Response<dynamic>(
              requestOptions: options,
              statusCode: acknowledgeStatus,
              data: <String, dynamic>{'error': 'nope'},
            ),
          );
        }
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'id': 'rem-1',
            'triggeredAt': '2026-09-21T18:39:30.653Z',
            'firstAcknowledgement': true,
          },
        });
      }
      if (options.path.contains('/reminders')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'reminders': reminders,
            'pagination': <String, dynamic>{
              'nextCursor': null,
              'prevCursor': null,
              'hasMore': false,
              'limit': 50,
            },
          },
        });
      }
      return jsonResponse(<String, dynamic>{'success': true, 'data': null});
    });
  }

  Future<ProviderContainer> containerWith(
    TestDependencies deps,
    FakeHttpAdapter http,
  ) async {
    final container = ProviderContainer(
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
        networkServiceProvider.overrideWithValue(fakeNetworkService(http)),
        authNetworkServiceProvider.overrideWithValue(fakeNetworkService(http)),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  group('the notification payload identifies the reminder', () {
    test('a one-shot alarm carries the server id', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);
      final notifications = deps.reminderNotifications;
      final reconciler = ReminderReconciler(notifications: notifications);

      await reconciler.reconcile(<NovaReminder>[
        NovaReminder(
          id: 'rem-abc',
          title: 'Call bank',
          remindAt: DateTime(2026, 9, 22, 9),
        ),
      ], complete: true);

      // The notification id is a hash; the payload is the only way back to the row.
      expect(notifications.scheduledCalls.single.reminderId, 'rem-abc');
      expect(
        notifications.scheduledCalls.single.id,
        reminderNotificationId('rem-abc'),
      );
    });

    test('a repeating alarm carries it too, so later occurrences are attributed', () async {
      final deps = await createTestDependencies();
      addTearDown(deps.dispose);
      final notifications = deps.reminderNotifications;
      final reconciler = ReminderReconciler(notifications: notifications);

      await reconciler.reconcile(<NovaReminder>[
        NovaReminder(
          id: 'rem-daily',
          title: 'Take pills',
          remindAt: DateTime(2026, 9, 22, 9),
          repeatRule: NovaRepeatRule.tryParse('FREQ=DAILY'),
        ),
      ], complete: true);

      expect(notifications.repeatingCalls.single.reminderId, 'rem-daily');
    });
  });

  group('opening a notification reports it to the server', () {
    test('a tap posts the acknowledgement and refreshes the list', () async {
      final seen = <RequestOptions>[];
      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);
      final container = await containerWith(
        deps,
        adapter(
          seen: seen,
          reminders: <Map<String, dynamic>>[
            reminderJson('rem-1', DateTime.now().add(const Duration(hours: 4))),
          ],
        ),
      );

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);
      seen.clear();

      await container.read(reminderSyncProvider.notifier).reportOpened('rem-1');
      await pumpEventQueue(times: 40);

      final acknowledge = seen.firstWhere(
        (request) => request.path.endsWith('/acknowledge'),
      );
      expect(acknowledge.method, 'POST');
      expect(acknowledge.path, contains('/api/v1/reminders/rem-1/acknowledge'));
      // The local list disagrees with the server about `triggeredAt` until it is
      // refetched, so the report must be followed by a sync.
      expect(
        seen.where((request) => request.method == 'GET' && request.path.contains('/reminders')),
        isNotEmpty,
      );
    });

    test('an empty id is ignored rather than posted', () async {
      final seen = <RequestOptions>[];
      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);
      final container = await containerWith(
        deps,
        adapter(seen: seen, reminders: <Map<String, dynamic>>[]),
      );

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);
      seen.clear();

      await container.read(reminderSyncProvider.notifier).reportOpened('');
      await pumpEventQueue(times: 40);

      expect(seen, isEmpty);
    });

    test('a failed report is swallowed and does not crash the tap', () async {
      final seen = <RequestOptions>[];
      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);
      final container = await containerWith(
        deps,
        adapter(
          seen: seen,
          reminders: <Map<String, dynamic>>[],
          acknowledgeStatus: 503,
        ),
      );

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);

      // Must not throw: the real callback runs inside a platform channel handler,
      // where an exception is dropped without a record.
      await expectLater(
        container.read(reminderSyncProvider.notifier).reportOpened('rem-1'),
        completes,
      );
      await pumpEventQueue(times: 40);
    });
  });

  group('the tap handler is registered with the platform', () {
    test('the sync controller installs exactly one handler', () async {
      final seen = <RequestOptions>[];
      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);
      containerWith(
        deps,
        adapter(seen: seen, reminders: <Map<String, dynamic>>[]),
      ).then((container) => container.read(reminderSyncProvider));

      await pumpEventQueue(times: 40);

      // Registered before authentication is resolved, because Android can cold-start
      // the process from the notification: dropping that first tap would lose the one
      // delivery signal the platform gives us.
      expect(deps.reminderNotifications.openedHandler, isNotNull);
      expect(deps.reminderNotifications.openedHandlerRegistrations, 1);
    });
  });
}
