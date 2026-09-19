import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';

/// The live recording waveform (blueprint §5.11).
///
/// Drawn from the real amplitude samples the recorder emits — one bar per
/// sample, newest on the right. When nothing has been recorded the list is
/// empty and the widget is genuinely blank rather than animating a decorative
/// fake waveform (the export's animation is a placeholder, not data).
class LiveWaveform extends StatelessWidget {
  const LiveWaveform({
    super.key,
    required this.levels,
    this.height = 48,
    this.color,
    this.active = true,
    this.maxBars = 48,
  });

  /// Amplitude samples in `0..1`, oldest first.
  final List<double> levels;
  final double height;
  final Color? color;

  /// False while paused or stopped, which dims the bars.
  final bool active;

  /// How many of the most recent samples are drawn.
  final int maxBars;

  /// The height of one bar for a `0..1` level. Exposed so the mapping is
  /// asserted directly instead of through a pixel diff.
  static double barHeightFor(double level, double height) {
    final clamped = level.isNaN ? 0.0 : level.clamp(0.0, 1.0);
    return 3 + clamped * (height - 3);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final tone = color ?? (active ? c.danger : c.muted);
    final recent = levels.length > maxBars
        ? levels.sublist(levels.length - maxBars)
        : levels;

    return SizedBox(
      height: height,
      child: Row(
        children: [
          for (var i = 0; i < recent.length; i++)
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1),
                child: Align(
                  alignment: Alignment.center,
                  child: Container(
                    key: ValueKey<String>('live-waveform-bar-$i'),
                    height: barHeightFor(recent[i], height),
                    decoration: BoxDecoration(
                      color: tone,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// §9.5's persistent recording indicator.
///
/// Shown for the whole time a capture session is active — recording or paused —
/// so the screen never leaves the microphone open without saying so. The wording
/// changes with the state: a paused session says it is not capturing.
class RecordingIndicatorBar extends StatelessWidget {
  const RecordingIndicatorBar({
    super.key,
    required this.paused,
    this.elapsed,
  });

  final bool paused;

  /// The formatted elapsed time, when the screen has one.
  final String? elapsed;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final label = paused ? 'Paused — not capturing' : 'Recording';

    return Container(
      key: const ValueKey<String>('recording-indicator'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: NovaSpace.sm,
        vertical: NovaSpace.xs,
      ),
      decoration: BoxDecoration(
        color: c.danger.withValues(alpha: paused ? 0.10 : 0.18),
        borderRadius: NovaRadius.rControl,
        border: Border.all(
          color: c.danger.withValues(alpha: paused ? 0.35 : 0.6),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: paused ? c.muted : c.danger,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Text(
              label,
              style: Theme.of(context).textTheme.bodySmall!.copyWith(
                color: paused ? c.muted : c.danger,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          if (elapsed != null)
            Text(
              elapsed!,
              style: Theme.of(context).textTheme.bodySmall!.copyWith(
                color: paused ? c.muted : c.danger,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
        ],
      ),
    );
  }
}
