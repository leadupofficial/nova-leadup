import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/design/widgets/nova_markdown.dart';

/// The assistant replies in markdown. Before [NovaMarkdown] the transcript
/// printed it raw, so every reply showed literal `**` markers. These tests pin
/// the subset we claim to support, and pin that unsupported input is shown
/// verbatim rather than swallowed.
Future<void> _pump(WidgetTester tester, String source) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: NovaMarkdown(text: source, style: const TextStyle(fontSize: 14)),
      ),
    ),
  );
}

void main() {
  group('NovaMarkdown', () {
    testWidgets('applies bold instead of printing the markers', (tester) async {
      await _pump(tester, 'Hello **NOVA** there');
      expect(find.textContaining('**'), findsNothing);
      expect(find.textContaining('Hello NOVA there'), findsOneWidget);
    });

    testWidgets('applies italics', (tester) async {
      await _pump(tester, 'This is *emphasised* text');
      expect(find.textContaining('*emphasised*'), findsNothing);
      expect(find.textContaining('This is emphasised text'), findsOneWidget);
    });

    testWidgets('strips inline code backticks', (tester) async {
      await _pump(tester, 'Run `npm test` first');
      expect(find.textContaining('`'), findsNothing);
      expect(find.textContaining('Run npm test first'), findsOneWidget);
    });

    testWidgets('renders dash bullets as list items', (tester) async {
      await _pump(tester, '- Answer questions\n- Writing help\n- Brainstorming');
      expect(find.text('•'), findsNWidgets(3));
      expect(find.textContaining('Answer questions'), findsOneWidget);
      expect(find.textContaining('Brainstorming'), findsOneWidget);
    });

    testWidgets('renders numbered lists', (tester) async {
      await _pump(tester, '1. First\n2. Second');
      expect(find.text('1.'), findsOneWidget);
      expect(find.text('2.'), findsOneWidget);
    });

    testWidgets('turns a horizontal rule into a divider', (tester) async {
      await _pump(tester, 'Above\n---\nBelow');
      expect(find.byType(Divider), findsOneWidget);
      expect(find.textContaining('---'), findsNothing);
    });

    testWidgets('collapses multi-line paragraphs onto one line', (tester) async {
      await _pump(tester, 'one\ntwo\nthree');
      expect(find.textContaining('one two three'), findsOneWidget);
    });

    testWidgets('flattens headings to bold body text', (tester) async {
      await _pump(tester, '### Summary');
      expect(find.textContaining('#'), findsNothing);
      expect(find.textContaining('Summary'), findsOneWidget);
    });

    testWidgets('leaves unformatted text untouched', (tester) async {
      await _pump(tester, 'Just a plain sentence.');
      expect(find.textContaining('Just a plain sentence.'), findsOneWidget);
    });

    testWidgets('empty input does not throw', (tester) async {
      await _pump(tester, '');
      expect(tester.takeException(), isNull);
    });

    testWidgets('unmatched markers do not throw', (tester) async {
      await _pump(tester, 'a ** b ` c');
      expect(tester.takeException(), isNull);
    });
  });
}
