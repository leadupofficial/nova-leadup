import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/providers.dart';
import 'package:nova_mobile/core/design/widgets/index.dart';
import 'package:nova_mobile/services/network_service.dart';
import 'package:nova_mobile/features/settings/delete_account_page.dart';
import 'package:nova_mobile/features/settings/privacy_policy_page.dart';

import '../helpers/test_harness.dart';

/// Widget tests for the two surfaces both app stores make mandatory.
///
/// These are not feature tests. A reviewer opens these screens and either finds a
/// working deletion path and a readable policy, or rejects the build:
///
///  * **App Review 5.1.1(v)** and Play's account-deletion requirement need an in-app
///    deletion path — and "deactivating the account is not sufficient".
///  * **App Review 5.1.1(i)** and Play's User Data policy need the privacy policy
///    readable inside the app, not merely linked from the store listing.
///
/// So what is asserted is that both render without depending on a provider the app
/// could fail to supply, that the destructive action is gated behind an explicit typed
/// confirmation, and that the policy text itself is present rather than a link.
void main() {
  Widget appWith(Widget child, {NetworkService? network}) => ProviderScope(
    overrides: [
      if (network != null) networkServiceProvider.overrideWithValue(network),
    ],
    child: MaterialApp(
      theme: NovaTheme.darkTheme,
      home: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: child,
      ),
    ),
  );

  // ─── Privacy policy ────────────────────────────────────────────────────────

  group('privacy policy page', () {
    testWidgets('renders the policy itself, offline, with every required section',
        (WidgetTester tester) async {
      useTallSurface(tester);
      // Deliberately no overrides: the page must not need the network. A policy that
      // fails to load is not "available on an active, publicly accessible URL" in the
      // sense Play means.
      await tester.pumpWidget(appWith(const PrivacyPolicyPage()));
      await tester.pumpAndSettle();

      expect(find.text('Privacy Policy'), findsOneWidget);

      for (final section in <String>[
        'What we collect',
        'What we do not collect',
        'Who processes it',
        'How long we keep it',
        'Deleting your data',
        'Security',
        'Children',
        'Changes',
        'Contact',
      ]) {
        expect(find.text(section), findsOneWidget, reason: 'missing section: $section');
      }

      // Third-party AI subprocessors must be named, not gestured at (5.1.2(i)).
      for (final provider in <String>['Anthropic', 'Deepgram', 'Sarvam', 'ElevenLabs']) {
        expect(find.textContaining(provider), findsOneWidget, reason: 'missing $provider');
      }

      // A privacy contact and the public URL are both required by Play.
      expect(find.textContaining('privacy@leadup.tech'), findsWidgets);
      expect(
        find.textContaining(PrivacyPolicyPage.publicUrl),
        findsOneWidget,
        reason: 'the canonical public URL must be shown so the two copies stay in step',
      );

      // Claims that would contradict the Data safety form if they were untrue.
      expect(find.textContaining('No advertising identifier'), findsOneWidget);
      expect(find.textContaining('No health, fitness or step data'), findsOneWidget);
      expect(find.textContaining('No contacts, calendar, camera'), findsOneWidget);
    });

    testWidgets('states that audio leaves the device', (WidgetTester tester) async {
      useTallSurface(tester);
      await tester.pumpWidget(appWith(const PrivacyPolicyPage()));
      await tester.pumpAndSettle();

      // The single most important disclosure in a voice app.
      expect(
        find.textContaining('audio is streamed to our server to be transcribed'),
        findsOneWidget,
      );
    });
  });

  // ─── Delete account ────────────────────────────────────────────────────────

  group('delete account page', () {
    /// A network service that answers the preview and records every request.
    NetworkService previewNetwork(List<RequestOptions> captured, {bool previewFails = false}) {
      final adapter = FakeHttpAdapter((options) async {
        captured.add(options);
        if (options.path.endsWith('/deletion-preview')) {
          if (previewFails) {
            return jsonResponse(
              <String, dynamic>{'success': false, 'message': 'boom'},
              statusCode: 500,
            );
          }
          return jsonResponse(<String, dynamic>{
            'success': true,
            'data': <String, dynamic>{
              'email': 'alex@example.com',
              'recordings': 2,
              'consentRecords': 3,
              'requiresPassword': true,
              'retentionPeriod': 'Immediate. Backups roll off within 30 days.',
            },
          });
        }
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'deleted': true},
        });
      });
      return fakeNetworkService(adapter);
    }

    Future<void> pump(WidgetTester tester, NetworkService network) async {
      useTallSurface(tester);
      await tester.pumpWidget(appWith(const DeleteAccountPage(), network: network));
      await tester.pumpAndSettle();
    }

    NovaPrimaryButton destructiveButton(WidgetTester tester) => tester.widget<NovaPrimaryButton>(
      find.ancestor(
        of: find.text('Delete my account'),
        matching: find.byType(NovaPrimaryButton),
      ),
    );

    testWidgets('lists what will be deleted, read from the server', (WidgetTester tester) async {
      final captured = <RequestOptions>[];
      await pump(tester, previewNetwork(captured));

      expect(find.textContaining('alex@example.com'), findsOneWidget);
      expect(find.textContaining('2 recordings'), findsOneWidget);
      expect(find.textContaining('3 consent records'), findsOneWidget);
      expect(find.textContaining('Retention: Immediate. Backups roll off within 30 days.'),
          findsOneWidget);
      expect(find.text('Delete my account'), findsOneWidget);
      // The email fallback is the second deletion route Play expects to exist.
      expect(find.textContaining('privacy@leadup.tech'), findsOneWidget);

      expect(captured.single.method, 'GET');
      expect(captured.single.path, endsWith('/api/v1/account/deletion-preview'));
    });

    testWidgets('stays disabled until DELETE and a password are entered',
        (WidgetTester tester) async {
      final captured = <RequestOptions>[];
      await pump(tester, previewNetwork(captured));

      expect(destructiveButton(tester).onPressed, isNull,
          reason: 'enabled before any confirmation was typed');

      await tester.enterText(find.byType(TextField).first, 'DELETE');
      await tester.pumpAndSettle();
      expect(destructiveButton(tester).onPressed, isNull, reason: 'enabled without a password');

      await tester.enterText(find.byType(TextField).last, 'correct horse');
      await tester.pumpAndSettle();
      expect(destructiveButton(tester).onPressed, isNotNull);

      // A typo must re-disable it — the literal is the whole point of the field.
      await tester.enterText(find.byType(TextField).first, 'DELET');
      await tester.pumpAndSettle();
      expect(destructiveButton(tester).onPressed, isNull);
    });

    testWidgets('a failed preview still permits deletion, and says why', (WidgetTester tester) async {
      final captured = <RequestOptions>[];
      await pump(tester, previewNetwork(captured, previewFails: true));

      // Refusing to delete because a *count* could not be read would be a worse bug
      // than deleting without the count.
      expect(find.textContaining('Could not read the exact counts'), findsOneWidget);
      expect(find.textContaining('removes everything listed above'), findsOneWidget);

      await tester.enterText(find.byType(TextField).first, 'DELETE');
      await tester.enterText(find.byType(TextField).last, 'pw');
      await tester.pumpAndSettle();
      expect(destructiveButton(tester).onPressed, isNotNull);
    });
  });

  // ─── AI report affordance ──────────────────────────────────────────────────

  group('AI report affordance', () {
    Widget bubble({
      required NovaMessageRole role,
      VoidCallback? onReport,
      bool provisional = false,
      bool failed = false,
    }) => MaterialApp(
      theme: NovaTheme.darkTheme,
      home: Scaffold(
        body: NovaMessageBubble(
          text: 'a reply',
          role: role,
          provisional: provisional,
          failed: failed,
          onReport: onReport,
        ),
      ),
    );

    testWidgets('offers Report on a committed assistant reply', (WidgetTester tester) async {
      var taps = 0;
      await tester.pumpWidget(bubble(role: NovaMessageRole.nova, onReport: () => taps++));
      await tester.pumpAndSettle();

      // Play's AI-Generated Content policy: reporting must be reachable in-app.
      expect(find.text('Report'), findsOneWidget);
      await tester.tap(find.text('Report'));
      expect(taps, 1);
    });

    testWidgets('offers nothing to report on a user message', (WidgetTester tester) async {
      await tester.pumpWidget(
        bubble(role: NovaMessageRole.user, onReport: () => fail('user messages are not reportable')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Report'), findsNothing);
    });

    testWidgets('hides Report on a provisional reply', (WidgetTester tester) async {
      await tester.pumpWidget(
        bubble(
          role: NovaMessageRole.nova,
          provisional: true,
          onReport: () => fail('there is no finished reply to report yet'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Report'), findsNothing);
    });

    testWidgets('hides Report on a failed bubble', (WidgetTester tester) async {
      await tester.pumpWidget(
        bubble(
          role: NovaMessageRole.nova,
          failed: true,
          onReport: () => fail('a reply that was never delivered is not reportable'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Report'), findsNothing);
    });

    testWidgets('renders no Report control when no handler is supplied',
        (WidgetTester tester) async {
      await tester.pumpWidget(bubble(role: NovaMessageRole.nova));
      await tester.pumpAndSettle();
      expect(find.text('Report'), findsNothing);
    });
  });
}
