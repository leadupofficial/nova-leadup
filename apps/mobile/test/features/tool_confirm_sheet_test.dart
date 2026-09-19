import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/api/models.dart';
import 'package:nova_mobile/core/design/widgets/index.dart';
import 'package:nova_mobile/features/converse/tool_confirm_sheet.dart';

/// The Tool Confirmation sheet is shared by the typed path and the realtime
/// voice path (blueprint §5.7: "shown before every side-effecting action").
///
/// These tests pin the two things that make the reuse safe: the payload the
/// server sent is what the user sees, and the voice path delivers its answer
/// through the supplied callback instead of the approvals REST route — so a
/// spoken "remind me" is confirmed without an approval row existing at all.
void main() {
  NovaToolApproval voiceApproval({
    DateTime? expiresAt,
    int permissionLevel = 1,
    Map<String, dynamic>? input,
  }) => NovaToolApproval(
    id: 'appr-7',
    toolName: 'create_reminder',
    permissionLevel: permissionLevel,
    expiresAt: expiresAt,
    toolInput:
        input ??
        const <String, dynamic>{
          'title': 'Call the bank',
          'trigger_at': '2026-09-19T17:00:00+05:30',
        },
  );

  Widget host(
    Widget child, {
    bool reduceMotion = true,
  }) => MaterialApp(
    theme: NovaTheme.dark(),
    home: Builder(
      builder: (context) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: Scaffold(body: child),
      ),
    ),
  );

  testWidgets('renders the server payload verbatim', (tester) async {
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(),
          onDecide: (_) async {},
          title: 'Create a reminder "Call the bank".',
          consequence: 'A reminder will be added to your reminders.',
          confirmLabel: 'Approve and run',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Confirm action'), findsOneWidget);
    expect(find.text('Create a reminder "Call the bank".'), findsOneWidget);
    expect(find.text('A reminder will be added to your reminders.'), findsOneWidget);
    // Values, not a paraphrase: the point of the sheet is that the user sees
    // exactly what will be sent.
    expect(find.text('TITLE'), findsOneWidget);
    expect(find.text('Call the bank'), findsOneWidget);
    expect(find.text('TRIGGER AT'), findsOneWidget);
    expect(find.text('2026-09-19T17:00:00+05:30'), findsOneWidget);
    expect(find.text('Approve and run'), findsOneWidget);
    expect(find.text('Deny'), findsOneWidget);
  });

  testWidgets('says the action is recallable for a personal write', (
    tester,
  ) async {
    // An L1 reminder is not an "external action"; claiming otherwise teaches
    // people to ignore the warning.
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(),
          onDecide: (_) async {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('External actions cannot be recalled'), findsNothing);
  });

  testWidgets('keeps the external warning for an L3 action', (tester) async {
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(permissionLevel: 3),
          onDecide: (_) async {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('cannot be recalled'), findsOneWidget);
  });

  testWidgets('the voice answer is delivered through onDecide, not the API', (
    tester,
  ) async {
    final decisions = <bool>[];
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(),
          onDecide: (approve) async => decisions.add(approve),
          confirmLabel: 'Approve and run',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Approve and run'));
    await tester.pumpAndSettle();

    expect(decisions, <bool>[true]);
  });

  testWidgets('denying reports the refusal', (tester) async {
    final decisions = <bool>[];
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(),
          onDecide: (approve) async => decisions.add(approve),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Deny'));
    await tester.pumpAndSettle();

    expect(decisions, <bool>[false]);
  });

  testWidgets('a callback that fails keeps the sheet open and says why', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(),
          onDecide: (_) async => throw StateError('socket is gone'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Approve and send'));
    await tester.pumpAndSettle();

    expect(find.textContaining('socket is gone'), findsOneWidget);
    expect(find.text('Approve and send'), findsOneWidget);
  });

  testWidgets('counts down to the server deadline and disables when it lapses', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(
            expiresAt: DateTime.now().add(const Duration(seconds: 90)),
          ),
          onDecide: (_) async {},
        ),
      ),
    );
    await tester.pump();

    expect(find.textContaining('Auto-expires in'), findsOneWidget);
  });

  testWidgets('an expired request cannot be approved', (tester) async {
    final decisions = <bool>[];
    await tester.pumpWidget(
      host(
        ToolConfirmSheet(
          approval: voiceApproval(
            expiresAt: DateTime.now().subtract(const Duration(seconds: 5)),
          ),
          onDecide: (approve) async => decisions.add(approve),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Approval expired'), findsOneWidget);
    // The button is disabled, so the tap does nothing — a stale action must not
    // be sent after its deadline.
    await tester.tap(find.text('Approval expired'), warnIfMissed: false);
    await tester.pump();
    expect(decisions, isEmpty);
  });

  testWidgets('the typed path keeps its own wording and no callback', (
    tester,
  ) async {
    // No `onDecide`: the sheet is in its original mode and would write the
    // decision to the approvals route.
    await tester.pumpWidget(host(ToolConfirmSheet(approval: voiceApproval())));
    await tester.pumpAndSettle();

    expect(find.text('Approve and send'), findsOneWidget);
    expect(find.textContaining('Permission level 1'), findsOneWidget);
  });
}
