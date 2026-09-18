import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/core/api/nova_api.dart';

import '../../helpers/test_harness.dart';

/// Regression tests for request payloads that the server rejects outright.
///
/// `createTask`, `createMemory` and memory search were all answered with 400
/// because the bodies did not match the zod schemas — and because zod strips
/// unknown keys, one of them (memory search) failed *silently* instead, return
/// every record as though each one matched. These tests pin the wire format so
/// that cannot regress unnoticed again.
void main() {
  late List<RequestOptions> captured;

  NovaApi buildApi({Map<String, dynamic> data = const {'id': 'x'}}) {
    return NovaApi(
      fakeNetworkService(
        FakeHttpAdapter((options) async {
          captured.add(options);
          return jsonResponse(<String, dynamic>{
            'success': true,
            'data': data,
          });
        }),
      ),
    );
  }

  setUp(() => captured = <RequestOptions>[]);

  group('createTask', () {
    test('always sends the priority and status the schema requires', () async {
      await buildApi(
        data: <String, dynamic>{'id': 't1', 'title': 'x'},
      ).createTask(title: 'x');

      expect(captured, hasLength(1));
      final body = captured.single.data as Map<String, dynamic>;
      // CreateTaskSchema declares both as required with no default; omitting
      // either produced 400 "Multiple validation errors".
      expect(body['status'], 'pending');
      expect(body['priority'], 'medium');
      expect(body['title'], 'x');
    });

    test('honours an explicit priority and status', () async {
      await buildApi(
        data: <String, dynamic>{'id': 't1', 'title': 'x'},
      ).createTask(title: 'x', priority: 'urgent', status: 'in_progress');

      final body = captured.single.data as Map<String, dynamic>;
      expect(body['priority'], 'urgent');
      expect(body['status'], 'in_progress');
    });
  });

  group('createMemory', () {
    test('sends category and sourceType, never a bare type', () async {
      await buildApi(
        data: <String, dynamic>{'id': 'm1', 'content': 'hello'},
      ).createMemory(content: 'hello');

      final body = captured.single.data as Map<String, dynamic>;
      expect(body['category'], 'fact');
      expect(body['sourceType'], 'manual');
      // The schema has no `type` field at all, so sending it was pointless.
      expect(body.containsKey('type'), isFalse);
    });

    test('carries an explicit category through', () async {
      await buildApi(
        data: <String, dynamic>{'id': 'm1', 'content': 'hello'},
      ).createMemory(content: 'hello', category: 'preference');

      expect((captured.single.data as Map)['category'], 'preference');
    });
  });

  group('searchMemories', () {
    test('hits the search route with the query parameter the schema wants',
        () async {
      await buildApi(
        data: <String, dynamic>{'memories': <dynamic>[]},
      ).searchMemories(query: 'teal');

      final options = captured.single;
      expect(options.path, endsWith('/memories/search'));
      // MemorySearchSchema reads `query`. Sending `search` here 400s.
      expect(options.queryParameters['query'], 'teal');
      expect(options.queryParameters.containsKey('search'), isFalse);
    });
  });

  group('listMemories', () {
    test('does not pretend the list route can filter by text', () async {
      await buildApi(
        data: <String, dynamic>{'memories': <dynamic>[]},
      ).listMemories();

      final options = captured.single;
      expect(options.path, endsWith('/memories'));
      expect(options.queryParameters.containsKey('search'), isFalse);
    });
  });

  group('NovaPrivacyPrefs auto-delete', () {
    test('serialises an unset retention as an explicit null', () {
      // The server treats null as "Never" and clears the column. Omitting the
      // key instead meant a saved retention period could never be removed.
      final json = const NovaPrivacyPrefs().toJson();
      expect(json.containsKey('autoDeleteRecordingsDays'), isTrue);
      expect(json['autoDeleteRecordingsDays'], isNull);
      expect(json.containsKey('autoDeleteTranscriptsDays'), isTrue);
      expect(json['autoDeleteTranscriptsDays'], isNull);
    });

    test('copyWith can actively clear a retention period', () {
      const prefs = NovaPrivacyPrefs(
        autoDeleteRecordingsDays: 30,
        autoDeleteTranscriptsDays: 7,
      );

      // A plain null argument means "unchanged", per the usual Dart convention.
      expect(prefs.copyWith().autoDeleteRecordingsDays, 30);

      final cleared = prefs.copyWith(clearAutoDeleteRecordingsDays: true);
      expect(cleared.autoDeleteRecordingsDays, isNull);
      // Clearing one must not disturb the other.
      expect(cleared.autoDeleteTranscriptsDays, 7);
    });

    test('round-trips a numeric retention', () {
      final prefs = const NovaPrivacyPrefs().copyWith(
        autoDeleteRecordingsDays: 90,
      );
      expect(prefs.toJson()['autoDeleteRecordingsDays'], 90);
    });
  });
}
