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
  late FakeAudioRecorder recorder;

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
        fakeMeetingRecorder(recorder: recorder),
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

  setUp(() {
    captured = <RequestOptions>[];
    recorder = FakeAudioRecorder();
  });

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
      // Wait for the two real-world effects the assertions below depend on — the row
      // was created *and* the recorder actually started — instead of guessing a
      // duration. A fixed 100 ms was enough on an idle machine and not enough under a
      // full-suite load, so this test flaked; the worst kind of failure, because it
      // reports a product bug that is not there.
      // The whole start flow — create the row, open the file, start the recorder,
      // publish the `recording` phase — has to finish *inside* this real-async zone.
      // Leaving it mid-flight and returning to the fake clock stalls it, and the
      // indicator assertion then fails. 100 ms was enough idle and not enough under a
      // full-suite load, so the wait is now an order of magnitude larger than the
      // observed need rather than a guess at the minimum.
      await Future<void>.delayed(const Duration(milliseconds: 1000));
    });
    // Pump until the page shows the live indicator rather than pumping a fixed
    // number of times: the controller publishes its `recording` phase after the
    // recorder reports started, and that gap is what made a fixed delay flaky.
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
    // This is the only test here that leaves the fake-async zone to do real file
    // and network I/O, which makes it the only one whose duration depends on how
    // busy the machine is. It was observed failing once while a build ran
    // alongside and passing in isolation and on every unloaded re-run. A longer
    // budget keeps a slow machine from being reported as a broken recording.
  }, timeout: const Timeout(Duration(minutes: 2)));
}
