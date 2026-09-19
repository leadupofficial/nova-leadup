import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nova_mobile/core/api/nova_api.dart';
import 'package:nova_mobile/core/design/widgets/index.dart';
import 'package:nova_mobile/features/recording/live_waveform.dart';
import 'package:nova_mobile/features/recording/meeting_recorder.dart';
import 'package:nova_mobile/features/recording/recording_page.dart';

import '../helpers/fake_meeting_recorder.dart';
import '../helpers/test_harness.dart';

/// The recorder screen's consent gate.
///
/// §9.5: recording is off when the screen opens, the reminder is shown verbatim,
/// and Start does nothing at all until it is acknowledged. The assertion that
/// matters most is the one on the network log — a disabled button that still
/// created a row would be the bug this guards.
void main() {
  late List<RequestOptions> captured;

  NovaApi createOnlyApi() {
    final adapter = FakeHttpAdapter((RequestOptions options) async {
      captured.add(options);
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{
          'id': 'rec-1',
          'title': 'Meeting',
          'status': 'recording',
        },
      }, statusCode: 201);
    });
    return NovaApi(fakeNetworkService(adapter));
  }

  Widget page() => ProviderScope(
    overrides: [
      novaApiProvider.overrideWithValue(createOnlyApi()),
      meetingRecorderProvider.overrideWithValue(
        fakeMeetingRecorder(recorder: FakeAudioRecorder()),
      ),
    ],
    child: MaterialApp(
      theme: NovaTheme.darkTheme,
      home: const MediaQuery(
        data: MediaQueryData(disableAnimations: true),
        child: RecordingPage(),
      ),
    ),
  );

  setUp(() => captured = <RequestOptions>[]);

  testWidgets('opens on the consent reminder with recording off',
      (tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(page());
    await tester.pump();
    await tester.pump();

    expect(
      find.textContaining(
        'Ensure everyone knows this conversation is being recorded',
      ),
      findsOneWidget,
    );
    // Nothing has been created and no microphone opened.
    expect(captured, isEmpty);
    expect(
      find.byKey(const ValueKey<String>('recording-indicator')),
      findsNothing,
    );
  });

  testWidgets('Start is disabled until the reminder is acknowledged',
      (tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(page());
    await tester.pump();
    await tester.pump();

    NovaPrimaryButton startButton() =>
        tester.widget<NovaPrimaryButton>(find.byType(NovaPrimaryButton));

    expect(startButton().onPressed, isNull);

    await tester.tap(find.text('Everyone has been told'));
    await tester.pump();

    expect(startButton().onPressed, isNotNull);
  });

  testWidgets('starting records the consent and shows the live indicator',
      (tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(page());
    await tester.pump();
    await tester.pump();

    await tester.tap(find.text('Everyone has been told'));
    await tester.pump();

    // Starting writes a file and does a real request, so it has to run outside
    // the fake-async zone the widget tester installs.
    await tester.runAsync(() async {
      await tester.tap(
        find.widgetWithText(NovaPrimaryButton, 'Start recording'),
      );
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pump();
    await tester.pump();

    expect(captured, hasLength(1));
    expect(captured.single.path, endsWith('/recordings'));
    final body = captured.single.data as Map<String, dynamic>;
    expect(body['consentRecorded'], isTrue);

    // §9.5: the indicator is on screen for the whole active session.
    expect(
      find.byKey(const ValueKey<String>('recording-indicator')),
      findsOneWidget,
    );
    expect(find.byType(LiveWaveform), findsOneWidget);
    expect(find.widgetWithText(NovaSecondaryButton, 'Pause'), findsOneWidget);
    expect(find.widgetWithText(NovaPrimaryButton, 'Stop recording'), findsOneWidget);
  });
}
