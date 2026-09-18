import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';

/// `.recording-indicator` — five bars waving out of phase.
///
/// Port of the export: 3px bars, 1s loop, delays 0/.15/.3/.45/.6, height
/// swinging 6px <-> 20px. brand-spec rule 6 makes this the red treatment.
class NovaWaveform extends StatefulWidget {
  const NovaWaveform({
    super.key,
    this.bars = 5,
    this.height = 20,
    this.color,
    this.animate = true,
  });

  final int bars;
  final double height;
  final Color? color;
  final bool animate;

  @override
  State<NovaWaveform> createState() => _NovaWaveformState();
}

class _NovaWaveformState extends State<NovaWaveform>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: NovaMotion.waveform,
  );

  @override
  void initState() {
    super.initState();
  }

  void _sync() {
    final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (widget.animate && !reduce) {
      _c.repeat();
    } else {
      _c.stop();
      _c.value = 0.25;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final color = widget.color ?? c.danger;

    return SizedBox(
      height: widget.height,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: List.generate(widget.bars, (i) {
              // Phase-shift each bar by 0.15 of the cycle, as the CSS delays do.
              final t = (_c.value + i * 0.15) % 1.0;
              final wave = (math.sin(t * 2 * math.pi) + 1) / 2;
              final h = 6 + wave * (widget.height - 6);
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1.5),
                child: Container(
                  width: 3,
                  height: h,
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              );
            }),
          );
        },
      ),
    );
  }
}
