import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/design/widgets/index.dart';
import '../features/overlay/floating_overlay.dart';
import '../features/overlay/summon_hint.dart';
import '../features/tasks/reminder_composer.dart';

/// Bottom-navigation shell for the authenticated app.
///
/// The export designs five destinations — Home, Converse, Tasks, Memory and Me —
/// as `.bottom-nav` items. A [StatefulShellRoute] is used so each tab keeps its
/// own navigation stack, which is what the design's per-screen back buttons
/// (`.back-btn`) expect.
class NovaShell extends StatelessWidget {
  const NovaShell({
    super.key,
    required this.navigationShell,
    this.location = '/',
  });

  final StatefulNavigationShell navigationShell;

  /// The current go_router path, used to decide where the floating assistant
  /// orb is appropriate.
  final String location;

  /// The Converse thread is already a voice surface — it has its own avatar,
  /// quick actions and composer — and the overlay's expanded panel sits at
  /// `bottom: gutter`, which lands directly on top of that composer and makes
  /// it unusable. Suppress the orb there rather than stacking two voice UIs.
  bool get _showOverlay => !location.startsWith('/converse');

  static const destinations = <NovaNavDestination>[
    NovaNavDestination(
      label: 'Home',
      icon: Icons.home_outlined,
      activeIcon: Icons.home_rounded,
    ),
    NovaNavDestination(
      label: 'Converse',
      icon: Icons.graphic_eq_outlined,
      activeIcon: Icons.graphic_eq_rounded,
    ),
    NovaNavDestination(
      label: 'Tasks',
      icon: Icons.check_circle_outline_rounded,
      activeIcon: Icons.check_circle_rounded,
    ),
    NovaNavDestination(
      label: 'Memory',
      icon: Icons.auto_awesome_outlined,
      activeIcon: Icons.auto_awesome_rounded,
    ),
    NovaNavDestination(
      label: 'Me',
      icon: Icons.person_outline_rounded,
      activeIcon: Icons.person_rounded,
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // The designed floating assistant orb rides above the whole authenticated
      // app, not one tab, so it is mounted here rather than per screen. Its
      // primary action keeps the overlay's own voice behaviour (onAskNova is
      // left null on purpose); the action chips route to real destinations.
      //
      // The assistant's sentence is chrome *around* the screen, not a coat of
      // paint *over* it. It used to be a `Positioned(bottom: 8)` inside
      // [FloatingOverlay], which is a `Positioned.fill` mounted ABOVE
      // `navigationShell` in the stack below. So the sentence painted last, on
      // top of whatever the current screen's body ended with — and a body is the
      // screen's whole scroll viewport.
      //
      // Measured on the OnePlus 9R: the sentence sat at y≈2080 of 2400 while the
      // Home scroll viewport still extended ~30 logical pixels past it, so the
      // sentence ran across the *Today's Overview* cards, which were in turn
      // clipped by the viewport's bottom edge.
      //
      // A `Column` is what makes that impossible rather than merely invisible:
      // the sentence is a sibling of the screen now, laid out underneath it. The
      // screen's `Expanded` slot — and therefore its scroll viewport — ends where
      // the sentence begins, at every viewport height and on every device, and
      // no amount of content can push the cards under it.
      body: Column(
        children: [
          Expanded(
            child: Stack(
              children: [
                navigationShell,
                // FloatingOverlay already fills and positions itself, and only
                // its orb captures taps, so it can sit directly in this stack. Do
                // not wrap it in another Positioned.fill.
                if (_showOverlay)
                  FloatingOverlay(
                    onTranslate: () => context.push('/translate'),
                    onReminder: () => ReminderComposer.show(context),
                    onTask: () => navigationShell.goBranch(2),
                  ),
              ],
            ),
          ),
          if (_showOverlay)
            Semantics(
              button: true,
              label: 'Summon NOVA',
              child: SummonHint(
                // Same destination as the orb and Home's "Tap to talk", so the
                // promise the sentence makes ("tap avatar to summon") is
                // reachable by tapping the sentence too.
                onTap: () => context.go('/converse'),
              ),
            ),
        ],
      ),
      bottomNavigationBar: NovaBottomNav(
        destinations: destinations,
        index: navigationShell.currentIndex,
        onSelect: (i) => navigationShell.goBranch(
          i,
          // Tapping the active tab returns it to its root, matching the
          // platform convention go_router defaults away from.
          initialLocation: i == navigationShell.currentIndex,
        ),
      ),
    );
  }
}
