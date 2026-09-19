import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/core/api/providers.dart';
import 'package:nova_mobile/core/design/widgets/index.dart';
import 'package:nova_mobile/features/recording/summary_page.dart';

import '../helpers/test_harness.dart';

/// §5.12's summary screen.
///
/// What matters here is that the structured summary is rendered in full — owner
/// and due date included, and explicitly "Unassigned"/"No due date" when the
/// pipeline did not extract them — and that the waiting/failed/empty states tell
/// the truth instead of drawing empty sections. The route is stubbed, so no
/// network is involved except in the polling test, where the stub counts calls.
void main() {
  NovaRecordingDetail detail({
    String status = 'completed',
    String? transcript = 'We agreed to ship on Friday.',
    NovaRecordingSummary? summary,
    List<NovaTranscriptSegment> segments = const [],
  }) {
    return NovaRecordingDetail(
      recording: NovaRecording(
        id: 'rec-1',
        title: 'Standup',
        status: status,
        durationSeconds: 95,
        language: 'en',
        createdAt: DateTime(2026, 1, 2, 10, 30),
      ),
      transcript: transcript,
      summary: summary,
      segments: segments,
    );
  }

  Widget app(NovaRecordingDetail value) => ProviderScope(
    overrides: [
      recordingDetailProvider.overrideWith((ref, id) async => value),
    ],
    child: MaterialApp(
      theme: NovaTheme.darkTheme,
      home: const MediaQuery(
        data: MediaQueryData(disableAnimations: true),
        child: SummaryPage(recordingId: 'rec-1'),
      ),
    ),
  );

  testWidgets('renders the summary, decisions, action items and contacts',
      (WidgetTester tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(
      app(
        detail(
          summary: const NovaRecordingSummary(
            id: 'sum-1',
            summary: 'The team agreed to ship the release on Friday.',
            decisions: <String>['Ship on Friday'],
            actionItems: <NovaActionItem>[
              NovaActionItem(
                text: 'Send the release deck',
                owner: 'Priya',
                dueDate: 'Friday',
              ),
              NovaActionItem(text: 'Book the room'),
            ],
            extractedContacts: <NovaExtractedContact>[
              NovaExtractedContact(
                name: 'Kumar',
                detail: '+91 98765 43210',
                source: 'transcript',
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Send the release deck'), findsOneWidget);
    // Present owner and due date.
    expect(find.text('Priya'), findsOneWidget);
    expect(find.text('Friday'), findsOneWidget);

    // Absent ones are stated, never left blank.
    expect(find.text('Book the room'), findsOneWidget);
    expect(find.text('Unassigned'), findsOneWidget);
    expect(find.text('No due date'), findsOneWidget);

    expect(find.text('Ship on Friday'), findsOneWidget);
    expect(find.text('Kumar'), findsOneWidget);
    expect(find.text('+91 98765 43210'), findsOneWidget);
    expect(find.textContaining('We agreed to ship on Friday.'), findsWidgets);
  });

  testWidgets('never invents a speaker breakdown', (WidgetTester tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(
      app(
        detail(
          summary: const NovaRecordingSummary(id: 'sum-1', summary: 'Short.'),
          segments: const <NovaTranscriptSegment>[
            NovaTranscriptSegment(id: 'seg-1', text: 'Hello there', speakerIndex: 0),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('N speakers'), findsNothing);
    expect(find.textContaining('Speaker 1'), findsNothing);
    expect(
      find.textContaining('Speaker labels are not available'),
      findsOneWidget,
    );
  });

  testWidgets('shows an honest waiting state while the server is processing',
      (WidgetTester tester) async {
    useTallSurface(tester);
    var builds = 0;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          recordingDetailProvider.overrideWith((ref, id) async {
            builds++;
            return detail(status: 'processing', transcript: null);
          }),
        ],
        child: MaterialApp(
          theme: NovaTheme.darkTheme,
          home: const MediaQuery(
            data: MediaQueryData(disableAnimations: true),
            child: SummaryPage(recordingId: 'rec-1'),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(find.text('Transcribing and summarising…'), findsOneWidget);

    final before = builds;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(builds, greaterThan(before), reason: 'processing must poll');

    // The poll is bounded: after ~2 minutes it stops asking.
    for (var i = 0; i < 45; i++) {
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
    }
    final settled = builds;
    await tester.pump(const Duration(seconds: 12));
    await tester.pump();
    expect(builds, settled, reason: 'polling must stop after the cap');
    expect(find.textContaining('still'), findsWidgets);
  });

  testWidgets('says transcription failed when the server says so',
      (WidgetTester tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(
      app(detail(status: 'failed', transcript: null, summary: null)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Transcription failed'), findsOneWidget);
  });

  testWidgets('says nothing was detected rather than rendering empty sections',
      (WidgetTester tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(
      app(detail(transcript: null, summary: null)),
    );
    await tester.pumpAndSettle();

    expect(find.text('No speech was detected'), findsOneWidget);
  });

  group('parsing tolerance', () {
    test('accepts structured action items', () {
      final summary = NovaRecordingSummary.fromJson(<String, dynamic>{
        'id': 's1',
        'actionItems': <dynamic>[
          <String, dynamic>{
            'text': 'Send the deck',
            'owner': 'Priya',
            'dueDate': 'Friday',
            'dueDateIso': '2026-01-09',
          },
        ],
        'extractedContacts': <dynamic>[
          <String, dynamic>{
            'name': 'Kumar',
            'detail': '+91',
            'source': 'model',
          },
        ],
      });

      expect(summary.actionItems.single.text, 'Send the deck');
      expect(summary.actionItems.single.owner, 'Priya');
      expect(summary.actionItems.single.dueDateIso, '2026-01-09');
      expect(summary.extractedContacts.single.source, 'model');
    });

    test('still accepts the old plain-string form', () {
      final summary = NovaRecordingSummary.fromJson(<String, dynamic>{
        'id': 's1',
        'actionItems': <dynamic>['Send the deck', 'Book the room'],
        'extractedContacts': <dynamic>['+91 98765 43210'],
      });

      expect(
        summary.actionItems.map((a) => a.text).toList(),
        <String>['Send the deck', 'Book the room'],
      );
      expect(summary.actionItems.first.owner, isNull);
      expect(summary.extractedContacts.single.detail, '+91 98765 43210');
    });

    test('treats a blank summary row as empty, not as content', () {
      final summary = NovaRecordingSummary.fromJson(<String, dynamic>{
        'id': 's1',
        'summary': '   ',
        'decisions': <dynamic>[],
        'actionItems': <dynamic>[],
      });
      expect(summary.isEmpty, isTrue);
    });
  });
}
