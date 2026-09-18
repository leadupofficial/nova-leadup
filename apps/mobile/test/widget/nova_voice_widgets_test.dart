import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/design/widgets/index.dart';
import 'package:nova_mobile/core/voice/voice_realtime_state.dart';
import 'package:nova_mobile/core/voice/voice_realtime_view.dart';

/// Reduced motion is the default here on purpose: the status pill pulses when it
/// animates, and a `pumpAndSettle` over a live repeating animation never
/// returns. One test below deliberately checks that the reduced-motion path
/// settles.
Widget _host(Widget child, {bool reduceMotion = true}) {
  return MaterialApp(
    theme: NovaTheme.dark(),
    home: Builder(
      builder: (context) => MediaQuery(
        data: MediaQuery.of(
          context,
        ).copyWith(disableAnimations: reduceMotion),
        child: Scaffold(body: Center(child: child)),
      ),
    ),
  );
}

void main() {
  group('NovaMessageBubble provisional state', () {
    testWidgets('a live transcript is labelled and shown as provisional', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const NovaMessageBubble(
            text: 'vanakkam',
            role: NovaMessageRole.user,
            provisional: true,
            label: 'You · listening',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('vanakkam'), findsOneWidget);
      // The provisional marker is what distinguishes it from a final turn.
      expect(find.text('YOU · LISTENING'), findsOneWidget);
    });

    testWidgets('provisional text defaults to a live label', (tester) async {
      await tester.pumpWidget(
        _host(
          const NovaMessageBubble(
            text: 'partial words',
            role: NovaMessageRole.nova,
            provisional: true,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('NOVA · LIVE'), findsOneWidget);
    });

    testWidgets('a committed turn has no live marker', (tester) async {
      await tester.pumpWidget(
        _host(
          const NovaMessageBubble(
            text: 'vanakkam',
            role: NovaMessageRole.user,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('YOU'), findsOneWidget);
      expect(find.textContaining('LIVE'), findsNothing);
    });
  });

  group('NovaVoiceStatusPill', () {
    const expected = <VoiceRealtimePhase, String>{
      VoiceRealtimePhase.idle: 'READY',
      VoiceRealtimePhase.connecting: 'CONNECTING',
      VoiceRealtimePhase.listening: 'LISTENING',
      VoiceRealtimePhase.thinking: 'THINKING',
      VoiceRealtimePhase.speaking: 'SPEAKING',
      VoiceRealtimePhase.error: 'ERROR',
    };

    testWidgets('reports every honest phase', (tester) async {
      for (final entry in expected.entries) {
        await tester.pumpWidget(_host(NovaVoiceStatusPill(phase: entry.key)));
        await tester.pumpAndSettle();
        expect(
          find.text(entry.value),
          findsOneWidget,
          reason: 'phase ${entry.key.name} should read "${entry.value}"',
        );
      }
    });

    testWidgets('reduced motion stops the listening pulse', (tester) async {
      await tester.pumpWidget(
        _host(
          const NovaVoiceStatusPill(phase: VoiceRealtimePhase.listening),
          reduceMotion: true,
        ),
      );
      // This would time out if the pill kept animating.
      await tester.pumpAndSettle();
      expect(find.text('LISTENING'), findsOneWidget);
    });
  });
}
