import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';

/// One destination in [NovaBottomNav].
class NovaNavDestination {
  const NovaNavDestination({
    required this.label,
    required this.icon,
    required this.activeIcon,
  });

  final String label;
  final IconData icon;
  final IconData activeIcon;
}

/// `.bottom-nav` — translucent blurred bar with accent-highlighted active item.
///
/// Port of the export: `justify-content: space-around`, 12/20 padding,
/// `oklch(0.10 0.02 260 / 0.6)` fill with a 20px backdrop blur, a glass top
/// border, 10px labels, and the active item in `--accent`.
class NovaBottomNav extends StatelessWidget {
  const NovaBottomNav({
    super.key,
    required this.destinations,
    required this.index,
    required this.onSelect,
  });

  final List<NovaNavDestination> destinations;
  final int index;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return ClipRect(
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
        child: Container(
          decoration: BoxDecoration(
            color: c.navBar,
            border: Border(top: BorderSide(color: c.glassBorder)),
          ),
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: 20,
                vertical: 12,
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: List.generate(destinations.length, (i) {
                  final d = destinations[i];
                  final active = i == index;
                  return _NavItem(
                    destination: d,
                    active: active,
                    onTap: () => onSelect(i),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.destination,
    required this.active,
    required this.onTap,
  });

  final NovaNavDestination destination;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final color = active ? c.accent : c.muted;

    return Semantics(
      button: true,
      selected: active,
      label: destination.label,
      child: InkWell(
        onTap: onTap,
        borderRadius: NovaRadius.rControl,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                active ? destination.activeIcon : destination.icon,
                size: 24,
                color: color,
              ),
              const SizedBox(height: 4),
              Text(
                destination.label,
                style: NovaTheme.navLabel(c).copyWith(color: color),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
