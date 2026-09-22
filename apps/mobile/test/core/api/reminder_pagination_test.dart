import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/nova_api.dart';

import '../../helpers/test_harness.dart';

/// Cursor pagination for `GET /api/v1/reminders`.
///
/// The route answers `{reminders, pagination: {nextCursor, prevCursor, hasMore,
/// total}}`, and the client used to ask for exactly one page of 50 and ignore the
/// cursor entirely. For a user with 51 reminders that produced a "list" that was
/// missing one — and the reminder reconciler cancels everything it does not
/// recognise, so the missing reminder's alarm was deleted on every sync.
///
/// `listAllReminders` now walks the cursor, and the flag it returns alongside the
/// reminders is the part that keeps a *wrong* list from being acted on: an
/// incomplete list may be scheduled from and must never be cancelled against.
void main() {
  Map<String, dynamic> reminderJson(String id) => <String, dynamic>{
    'id': id,
    'title': 'Call $id',
  };

  Map<String, dynamic> page(
    List<String> ids, {
    required String? nextCursor,
  }) => <String, dynamic>{
    'success': true,
    'data': <String, dynamic>{
      'reminders': ids.map(reminderJson).toList(),
      'pagination': <String, dynamic>{
        'nextCursor': nextCursor,
        'prevCursor': null,
        'hasMore': nextCursor != null,
        'limit': 50,
        'total': ids.length,
      },
    },
  };

  NovaApi apiFor(FakeHttpAdapter adapter) =>
      NovaApi(fakeNetworkService(adapter));

  /// Answers each `cursor` query parameter from [pages], keyed by cursor. A null
  /// key is the first page. A value of `null` means "no such page" → 400.
  FakeHttpAdapter scripted(Map<String?, Map<String, dynamic>> pages) {
    return FakeHttpAdapter((options) async {
      final cursor = options.queryParameters['cursor'] as String?;
      final body = pages[cursor];
      if (body == null) {
        return jsonResponse(<String, dynamic>{
          'success': false,
          'error': 'Invalid cursor',
        }, statusCode: 400);
      }
      return jsonResponse(body);
    });
  }

  test('follows the cursor until the server says there is no more', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{
      null: page(<String>['rem-1', 'rem-2'], nextCursor: 'cursor-1'),
      'cursor-1': page(<String>['rem-3'], nextCursor: null),
    });

    final result = await apiFor(adapter).listAllReminders();

    expect(
      result.reminders.map((r) => r.id),
      <String>['rem-1', 'rem-2', 'rem-3'],
    );
    expect(result.complete, isTrue);
    expect(adapter.requests, hasLength(2));
    // The second request must carry the cursor the server handed back, or the walk
    // fetches the first page over and over.
    expect(adapter.requests[1].queryParameters['cursor'], 'cursor-1');
    expect(adapter.requests[1].queryParameters['limit'], 50);
  });

  test('a single page without a cursor is complete', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{
      null: page(<String>['rem-1'], nextCursor: null),
    });

    final result = await apiFor(adapter).listAllReminders();

    expect(result.reminders, hasLength(1));
    expect(result.complete, isTrue);
    expect(adapter.requests, hasLength(1));
  });

  test('a bare array payload is a complete single page', () async {
    // `data` has been an array on some revisions, and the client accepts both.
    final adapter = FakeHttpAdapter(
      (_) async => jsonResponse(<String, dynamic>{
        'success': true,
        'data': <dynamic>[reminderJson('rem-1')],
      }),
    );

    final result = await apiFor(adapter).listAllReminders();

    expect(result.reminders.map((r) => r.id), <String>['rem-1']);
    expect(result.complete, isTrue);
  });

  test('a failed later page yields an incomplete list, not an exception', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{
      null: page(<String>['rem-1', 'rem-2'], nextCursor: 'cursor-1'),
      // 'cursor-1' is absent, so the page answers 400.
    });

    final result = await apiFor(adapter).listAllReminders();

    expect(result.reminders.map((r) => r.id), <String>['rem-1', 'rem-2']);
    expect(
      result.complete,
      isFalse,
      reason:
          'the caller has to know this is not the whole list, because the whole '
          'list is the only thing safe to cancel alarms against',
    );
  });

  test('a failed first page is reported, not turned into an empty list', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{});

    await expectLater(
      apiFor(adapter).listAllReminders(),
      throwsA(isA<NovaApiException>()),
      reason:
          'an empty list would be read as "this account has no reminders", which '
          'is exactly the inference that deletes alarms',
    );
  });

  test('the page bound stops the walk with an incomplete list', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{
      null: page(<String>['rem-1'], nextCursor: 'cursor-1'),
      'cursor-1': page(<String>['rem-2'], nextCursor: 'cursor-2'),
      'cursor-2': page(<String>['rem-3'], nextCursor: 'cursor-3'),
    });

    final result = await apiFor(adapter).listAllReminders(maxPages: 2);

    expect(result.reminders, hasLength(2));
    expect(result.complete, isFalse);
    expect(
      adapter.requests,
      hasLength(2),
      reason: 'a server that never runs out of pages must not hang a sync',
    );
  });

  test('a cursor that does not advance stops the walk', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{
      null: page(<String>['rem-1'], nextCursor: 'cursor-1'),
      // The server hands back the cursor it was given: walking on would loop until
      // the page bound for no new data.
      'cursor-1': page(<String>['rem-1'], nextCursor: 'cursor-1'),
    });

    final result = await apiFor(adapter).listAllReminders();

    expect(result.reminders, hasLength(1));
    expect(result.complete, isFalse);
    expect(adapter.requests, hasLength(2));
  });

  test('a reminder repeated across pages is not duplicated', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{
      null: page(<String>['rem-1'], nextCursor: 'cursor-1'),
      'cursor-1': page(<String>['rem-1', 'rem-2'], nextCursor: null),
    });

    final result = await apiFor(adapter).listAllReminders();

    expect(result.reminders.map((r) => r.id), <String>['rem-1', 'rem-2']);
    expect(result.complete, isTrue);
  });

  test('listReminderPage asks for one page and reports its cursor', () async {
    final adapter = scripted(<String?, Map<String, dynamic>>{
      null: page(<String>['rem-1'], nextCursor: 'cursor-1'),
    });

    final result = await apiFor(adapter).listReminderPage(limit: 10);

    expect(result.reminders, hasLength(1));
    expect(result.hasMore, isTrue);
    expect(result.nextCursor, 'cursor-1');
    expect(adapter.requests.single.queryParameters['limit'], 10);
  });
}
