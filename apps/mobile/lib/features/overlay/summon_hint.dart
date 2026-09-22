import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';

/// The line the floating assistant shows under the screen it is riding on:
/// *"NOVA never sees other apps' content. Tap avatar to summon."*
///
/// It used to be a `Positioned(bottom: 8)` inside [FloatingOverlay]'s own
/// `Positioned.fill` stack, which is mounted **above** the whole navigation
/// shell (`lib/app/shell.dart`). Overlaying the bottom of the viewport is fine
/// for the orb — the orb sits in dead space beside the top bar — but the bottom
/// of the viewport is where a scrolling screen's content ends, so the hint was
/// painted straight on top of the Home screen's *Today's Overview* cards. On the
/// device the three cards were clipped by the bottom edge and the sentence ran
/// across all three of them.
///
/// It is now a **layout** element instead of a paint-time overlay: `NovaShell`
/// mounts it as the last child of its body `Column`, below the `Expanded` slot
/// that holds the screen. That slot — and therefore the screen's scroll viewport
/// — ends where the sentence begins, so the cards cannot share a pixel with it no
/// matter what the screen contains or how tall the device is.
///
/// [hintKey] is the handle the overlap test uses; it is declared here so the
/// test and the widget cannot drift apart.
class SummonHint extends StatelessWidget {
  const SummonHint({super.key, this.onTap});

  /// Identifies the painted sentence. The Home overlap test reads this rect and
  /// compares it with the overview row's.
  static const Key hintKey = Key('summon-hint');

  /// What tapping the sentence does. Null renders the sentence as plain text,
  /// which is what the shell passes when there is nowhere useful to send the
  /// user.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final text = Text(
      "NOVA never sees other apps' content. Tap avatar to summon.",
      key: hintKey,
      textAlign: TextAlign.center,
      style: TextStyle(
        fontFamily: NovaFonts.body,
        fontSize: NovaType.micro,
        color: c.muted,
        height: 1.5,
        fontVariations: [
          FontVariation('wght', NovaTheme.wght(NovaType.wRegular)),
        ],
      ),
    );

    // The hint is informational and must never eat a tap aimed at the content
    // behind it, so the tappable variant is bounded by the sentence itself.
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NovaSpace.gutter,
        NovaSpace.xxs,
        NovaSpace.gutter,
        NovaSpace.xxs,
      ),
      child: onTap == null
          ? text
          : GestureDetector(
              onTap: onTap,
              behavior: HitTestBehavior.opaque,
              child: text,
            ),
    );
  }
}
