import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/api/providers.dart';
import 'package:nova_mobile/features/reminders/reminder_notifications.dart';
import 'package:nova_mobile/features/reminders/reminder_sync.dart';

import '../helpers/test_harness.dart';

/// The reminder *sync*, not just the reconciler it delegates to.
///
/// The reconciler can only be as truthful as the list it is handed, and
/// `GET /api/v1/reminders` is cursor-paginated. Two defects lived in the seam
/// between them:
///
///  * `listReminders()` asked for a single page of 50 and ignored
///    `pagination.nextCursor`, so reminder 51 and beyond were simply absent from
///    the list the reconciler compared against — and the reconciler cancels
///    everything it does not recognise. Those users lost the alarms for
///    reminders 51+ on every single sync, silently.
///  * a page that failed to load produced exactly the same "not in the list"
///    answer, so a transient server error deleted alarms too.
///
/// These tests drive the real `ReminderSyncController` against a scripted
/// two-page server so both halves are pinned: fetch every page, and never treat
/// an incomplete list as evidence that a reminder is gone.
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

  /// Serves `GET /reminders` the way the real route does: a page plus a cursor.
  FakeHttpAdapter pagedAdapter({
    required List<Map<String, dynamic>> pageOne,
    required List<Map<String, dynamic>> pageTwo,
    required bool secondPageFails,
    required List<RequestOptions> seen,
  }) {
    return FakeHttpAdapter((options) async {
      seen.add(options);
      if (!options.path.contains('/reminders')) {
        return jsonResponse(<String, dynamic>{'success': true, 'data': null});
      }
      if (options.method != 'GET') {
        // A create returns the reminder the caller just made.
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'id': 'created', 'title': 'x'},
        });
      }
      final cursor = options.queryParameters['cursor'];
      if (cursor == null) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'reminders': pageOne,
            'pagination': <String, dynamic>{
              'nextCursor': 'page-2',
              'prevCursor': null,
              'hasMore': true,
              'limit': 50,
              'total': pageOne.length + pageTwo.length,
            },
          },
        });
      }
      if (secondPageFails) {
        // A stale cursor is rejected with 400, and a 4xx is not retried.
        return jsonResponse(<String, dynamic>{
          'success': false,
          'error': 'Invalid cursor',
        }, statusCode: 400);
      }
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{
          'reminders': pageTwo,
          'pagination': <String, dynamic>{
            'nextCursor': null,
            'prevCursor': 'page-1',
            'hasMore': false,
            'limit': 50,
            'total': pageOne.length + pageTwo.length,
          },
        },
      });
    });
  }

  Future<ProviderContainer> containerWith(
    TestDependencies deps,
    FakeHttpAdapter adapter,
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
        networkServiceProvider.overrideWithValue(fakeNetworkService(adapter)),
        authNetworkServiceProvider.overrideWithValue(
          fakeNetworkService(adapter),
        ),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  group('N-02 — a truncated list must never delete an alarm', () {
    test('arms a reminder that lives on the second page', () async {
      final now = DateTime.now();
      final pageOne = <Map<String, dynamic>>[
        for (var i = 1; i <= 50; i++)
          reminderJson('rem-$i', now.add(Duration(hours: i))),
      ];
      final pageTwo = <Map<String, dynamic>>[
        reminderJson('rem-51', now.add(const Duration(hours: 51))),
      ];

      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);
      // The OS already holds the 51st reminder's alarm. A one-page sync does not
      // know about it, so it cancels it — the reported N-02 defect.
      deps.reminderNotifications.scheduled.add(
        reminderNotificationId('rem-51'),
      );

      final container = await containerWith(
        deps,
        pagedAdapter(
          pageOne: pageOne,
          pageTwo: pageTwo,
          secondPageFails: false,
          seen: <RequestOptions>[],
        ),
      );

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);

      expect(
        deps.reminderNotifications.cancelled,
        isEmpty,
        reason: 'the 51st reminder exists; only a single-page fetch says otherwise',
      );
      expect(
        deps.reminderNotifications.scheduled,
        contains(reminderNotificationId('rem-51')),
      );
      expect(
        deps.reminderNotifications.scheduledCalls,
        hasLength(51),
        reason: 'every page is fetched, so all 51 reminders are armed',
      );
    });

    test('a failed second page never cancels an alarm', () async {
      final now = DateTime.now();
      final pageOne = <Map<String, dynamic>>[
        for (var i = 1; i <= 50; i++)
          reminderJson('rem-$i', now.add(Duration(hours: i))),
      ];
      final pageTwo = <Map<String, dynamic>>[
        reminderJson('rem-51', now.add(const Duration(hours: 51))),
      ];

      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);
      deps.reminderNotifications.scheduled.add(
        reminderNotificationId('rem-51'),
      );

      final container = await containerWith(
        deps,
        pagedAdapter(
          pageOne: pageOne,
          pageTwo: pageTwo,
          secondPageFails: true,
          seen: <RequestOptions>[],
        ),
      );

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);

      expect(
        deps.reminderNotifications.cancelled,
        isEmpty,
        reason:
            'a pagination failure says nothing about whether a reminder still '
            'exists, so it must never delete an alarm',
      );
      // The page that did load is still armed: a partial list is useful for
      // scheduling, it is only unsafe for cancelling.
      expect(deps.reminderNotifications.scheduledCalls, hasLength(50));
    });
  });

  group('N-09 — a new reminder is armed immediately', () {
    test('creating a reminder re-runs the sync', () async {
      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);

      final seen = <RequestOptions>[];
      final container = await containerWith(
        deps,
        pagedAdapter(
          pageOne: <Map<String, dynamic>>[],
          pageTwo: <Map<String, dynamic>>[],
          secondPageFails: false,
          seen: seen,
        ),
      );

      int listCalls() => seen
          .where((r) => r.method == 'GET' && r.path.contains('/reminders'))
          .length;

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);
      final afterFirstBuild = listCalls();
      expect(afterFirstBuild, greaterThan(0));

      await container.read(novaMutationsProvider).addReminder(
        title: 'Take the pills',
        remindAt: DateTime.now().add(const Duration(hours: 2)),
      );

      // Reading again is what a listener (or the app's own `listenManual`) does;
      // if the create invalidated the provider this rebuilds and syncs, and the
      // fresh reminder is scheduled without waiting for the next resume.
      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);

      expect(
        listCalls(),
        greaterThan(afterFirstBuild),
        reason:
            'creating a reminder must invalidate reminderSyncProvider, or the '
            'new reminder is not armed until the app is resumed',
      );
    });

    test('deleting a reminder re-runs the sync', () async {
      final deps = await createTestDependencies(secureStorage: signedIn);
      addTearDown(deps.dispose);

      final seen = <RequestOptions>[];
      final container = await containerWith(
        deps,
        pagedAdapter(
          pageOne: <Map<String, dynamic>>[],
          pageTwo: <Map<String, dynamic>>[],
          secondPageFails: false,
          seen: seen,
        ),
      );

      int listCalls() => seen
          .where((r) => r.method == 'GET' && r.path.contains('/reminders'))
          .length;

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);
      final afterFirstBuild = listCalls();

      await container.read(novaMutationsProvider).deleteReminder('rem-1');

      container.read(reminderSyncProvider);
      await pumpEventQueue(times: 40);

      expect(
        listCalls(),
        greaterThan(afterFirstBuild),
        reason:
            'a deleted reminder keeps its alarm until something reconciles the '
            'list against the OS',
      );
    });
  });
}
