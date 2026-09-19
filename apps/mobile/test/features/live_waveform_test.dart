import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nova_mobile/core/design/widgets/index.dart';
import 'package:nova_mobile/features/recording/live_waveform.dart';

/// The waveform is driven by real amplitude samples, so this pins that the drawn
/// bar heights actually follow the injected levels — and that nothing is drawn
/// when there is no data.
void main() {
  Widget host(Widget child) => MaterialApp(
    theme: NovaTheme.darkTheme,
    home: Scaffold(
      body: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: SizedBox(width: 320, child: child),
      ),
    ),
  );

  double barHeight(WidgetTester tester, int index) =>
      tester.getSize(find.byKey(ValueKey<String>('live-waveform-bar-$index')))
          .height;

  testWidgets('bar heights follow the injected levels', (tester) async {
    await tester.pumpWidget(
      host(const LiveWaveform(levels: <double>[0.0, 0.5, 1.0], height: 40)),
    );
    await tester.pump();

    expect(barHeight(tester, 0), closeTo(3, 0.01));
    expect(barHeight(tester, 1), closeTo(21.5, 0.01));
    expect(barHeight(tester, 2), closeTo(40, 0.01));

    // A quieter sample set draws different bars: this is data, not decoration.
    await tester.pumpWidget(
      host(const LiveWaveform(levels: <double>[0.1, 0.1, 0.1], height: 40)),
    );
    await tester.pump();

    expect(barHeight(tester, 0), lessThan(21.5));
  });

  testWidgets('draws nothing when there is no audio yet', (tester) async {
    await tester.pumpWidget(host(const LiveWaveform(levels: <double>[])));
    await tester.pump();

    expect(find.byKey(const ValueKey<String>('live-waveform-bar-0')), findsNothing);
  });

  test('the level→height mapping clamps and survives NaN', () {
    expect(LiveWaveform.barHeightFor(0, 40), 3);
    expect(LiveWaveform.barHeightFor(1, 40), 40);
    expect(LiveWaveform.barHeightFor(-3, 40), 3);
    expect(LiveWaveform.barHeightFor(9, 40), 40);
    expect(LiveWaveform.barHeightFor(double.nan, 40), 3);
  });

  testWidgets('the recording indicator says whether capture is running',
      (tester) async {
    await tester.pumpWidget(
      host(const RecordingIndicatorBar(paused: false, elapsed: '01:02')),
    );
    await tester.pump();
    expect(find.text('Recording'), findsOneWidget);
    expect(find.text('01:02'), findsOneWidget);

    await tester.pumpWidget(
      host(const RecordingIndicatorBar(paused: true, elapsed: '01:02')),
    );
    await tester.pump();
    expect(find.textContaining('Paused'), findsOneWidget);
  });
}
