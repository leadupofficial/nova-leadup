import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/config/api_config.dart';
import 'package:nova_mobile/core/api/nova_api.dart';

import '../helpers/test_harness.dart';

/// Client-side contract for the two store-required flows.
///
/// Both are hard submission gates rather than features, so the *wire format* is what
/// matters and what is asserted here: an in-app account deletion that sends the exact
/// body `services/api` validates (App Review 5.1.1(v), Play's account-deletion
/// requirement), and an AI-content report the server can act on (Play's AI-Generated
/// Content policy, App Review 1.2).
///
/// The sibling server-side checks live in `services/api` — this file only proves the
/// Dart client sends what that route expects.
void main() {
  late List<RequestOptions> captured;

  NovaApi apiWith(FakeHttpAdapter adapter) => NovaApi(fakeNetworkService(adapter));

  setUp(() => captured = <RequestOptions>[]);

  group('account deletion', () {
    test('DELETEs /api/v1/account with the literal confirmation and the password',
        () async {
      final api = apiWith(
        FakeHttpAdapter((options) async {
          captured.add(options);
          return jsonResponse(<String, dynamic>{
            'success': true,
            'data': <String, dynamic>{'deleted': true},
          });
        }),
      );

      await api.deleteAccount(password: 'correct horse battery staple');

      expect(captured, hasLength(1));
      final request = captured.single;
      expect(request.method, 'DELETE');
      expect(request.path, ApiConfig.account);
      expect(request.path, endsWith('/api/v1/account'));

      // `confirm` is a zod literal on the server. Sending a boolean, or omitting it,
      // makes the route answer 400 and the user's account survives a tap they
      // believed deleted it — the worst possible failure mode for this screen.
      expect(request.data, containsPair('confirm', 'DELETE'));
      expect(request.data, containsPair('password', 'correct horse battery staple'));
      // The reason is optional and must not be sent as null.
      expect((request.data as Map<String, dynamic>).containsKey('reason'), isFalse);
    });

    test('sends the password field only when one is supplied', () async {
      final api = apiWith(
        FakeHttpAdapter((options) async {
          captured.add(options);
          return jsonResponse(<String, dynamic>{
            'success': true,
            'data': <String, dynamic>{'deleted': true},
          });
        }),
      );

      await api.deleteAccount(reason: 'Leaving');

      final body = captured.single.data as Map<String, dynamic>;
      expect(body['confirm'], 'DELETE');
      expect(body['reason'], 'Leaving');
      // Omitted, not `null` — the schema types it as `string | undefined` and a
      // null would be rejected by `z.string().min(1)`.
      expect(body.containsKey('password'), isFalse);
    });

    test('surfaces the server status so the screen can explain a refusal', () async {
      final api = apiWith(
        FakeHttpAdapter((options) async {
          return jsonResponse(
            <String, dynamic>{
              'success': false,
              'error': <String, dynamic>{
                'code': 'PASSWORD_REQUIRED',
                'message': 'Password confirmation is required',
              },
            },
            statusCode: 400,
          );
        }),
      );

      await expectLater(
        api.deleteAccount(),
        throwsA(
          isA<NovaApiException>()
              .having((e) => e.statusCode, 'statusCode', 400),
        ),
      );
    });

    test('reads the deletion preview from the documented path', () async {
      final api = apiWith(
        FakeHttpAdapter((options) async {
          captured.add(options);
          return jsonResponse(<String, dynamic>{
            'success': true,
            'data': <String, dynamic>{
              'email': 'alex@example.com',
              'recordings': 3,
              'consentRecords': 5,
              'retentionPeriod': 'Immediate. Backups roll off within 30 days.',
            },
          });
        }),
      );

      final preview = await api.deletionPreview();

      expect(captured.single.method, 'GET');
      expect(captured.single.path, ApiConfig.accountDeletionPreview);
      expect(preview.email, 'alex@example.com');
      expect(preview.recordings, 3);
      expect(preview.consentRecords, 5);
      expect(preview.retentionPeriod, contains('30 days'));
    });
  });

  group('AI content reporting', () {
    test('POSTs /api/v1/ai/reports with the message, reason and a bounded excerpt',
        () async {
      final api = apiWith(
        FakeHttpAdapter((options) async {
          captured.add(options);
          return jsonResponse(<String, dynamic>{
            'success': true,
            'data': <String, dynamic>{'recorded': true},
          }, statusCode: 201);
        }),
      );

      await api.reportAiResponse(
        messageId: 'msg-42',
        reason: 'harmful',
        excerpt: 'a reply worth reviewing',
      );

      final request = captured.single;
      expect(request.method, 'POST');
      expect(request.path, ApiConfig.aiReports);
      expect(request.path, endsWith('/api/v1/ai/reports'));

      final body = request.data as Map<String, dynamic>;
      expect(body['messageId'], 'msg-42');
      // Must be one of the enum values the server accepts; a free-text reason would
      // be rejected by `z.enum`.
      expect(body['reason'], 'harmful');
      expect(body['excerpt'], 'a reply worth reviewing');
    });

    test('omits the excerpt rather than sending null', () async {
      final api = apiWith(
        FakeHttpAdapter((options) async {
          captured.add(options);
          return jsonResponse(
            <String, dynamic>{'success': true},
            statusCode: 201,
          );
        }),
      );

      await api.reportAiResponse(messageId: 'msg-7', reason: 'unsafe');

      expect(
        (captured.single.data as Map<String, dynamic>).containsKey('excerpt'),
        isFalse,
      );
    });
  });
}
