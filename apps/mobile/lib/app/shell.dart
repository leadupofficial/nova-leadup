import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/design/widgets/index.dart';
import '../features/overlay/floating_overlay.dart';
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
      body: Stack(
        children: [
          navigationShell,
          // FloatingOverlay already fills and positions itself, and only its
          // orb captures taps, so it can sit directly in this stack. Do not wrap
          // it in another Positioned.fill.
          if (_showOverlay)
            FloatingOverlay(
              onTranslate: () => context.push('/translate'),
              onReminder: () => ReminderComposer.show(context),
              onTask: () => navigationShell.goBranch(2),
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
