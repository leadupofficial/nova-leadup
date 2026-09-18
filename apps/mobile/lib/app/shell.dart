import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/design/widgets/index.dart';

/// Bottom-navigation shell for the authenticated app.
///
/// The export designs five destinations — Home, Converse, Tasks, Memory and Me —
/// as `.bottom-nav` items. A [StatefulShellRoute] is used so each tab keeps its
/// own navigation stack, which is what the design's per-screen back buttons
/// (`.back-btn`) expect.
class NovaShell extends StatelessWidget {
  const NovaShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

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
      body: navigationShell,
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
