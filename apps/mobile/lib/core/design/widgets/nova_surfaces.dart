import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';
import 'nova_controls.dart';

/// Ambient background aura every exported screen paints behind its content.
///
/// Port of `.bg-aura::before`: two blurred radial gradients — accent at 18%
/// opacity top-left, accent-secondary at 12% top-right.
class NovaAura extends StatelessWidget {
  const NovaAura({super.key, this.heightFactor = 0.6});

  final double heightFactor;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Positioned.fill(
      child: IgnorePointer(
        child: ClipRect(
          child: Stack(
            children: [
              Positioned(
                top: -80,
                left: -120,
                child: _Blob(
                  color: c.accent.withValues(alpha: 0.18),
                  size: 420,
                ),
              ),
              Positioned(
                top: -40,
                right: -140,
                child: _Blob(
                  color: c.accentSecondary.withValues(alpha: 0.12),
                  size: 360,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Blob extends StatelessWidget {
  const _Blob({required this.color, required this.size});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return ImageFiltered(
      imageFilter: ImageFilter.blur(sigmaX: 40, sigmaY: 40),
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [color, color.withValues(alpha: 0)],
          ),
        ),
      ),
    );
  }
}

/// Standard screen scaffold: aura background, 24px gutter, optional bottom nav.
///
/// Every exported screen uses `padding: 0 24px` and a 44px top inset for the
/// status bar, so those are the defaults here.
class NovaScaffold extends StatelessWidget {
  const NovaScaffold({
    super.key,
    required this.child,
    this.topBar,
    this.bottomNav,
    this.gutter = NovaSpace.gutter,
    this.padding,
    this.topInset = 44,
    this.scrollable = true,
    this.refresh,
  });

  final Widget child;
  final Widget? topBar;
  final Widget? bottomNav;
  final double gutter;
  final EdgeInsets? padding;
  final double topInset;
  final bool scrollable;
  final Future<void> Function()? refresh;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final content = Padding(
      padding: padding ?? EdgeInsets.symmetric(horizontal: gutter),
      child: child,
    );

    return Scaffold(
      backgroundColor: c.bg,
      body: Stack(
        children: [
          const NovaAura(),
          SafeArea(
            top: false,
            child: Column(
              children: [
                if (topBar != null)
                  Padding(
                    padding: EdgeInsets.only(top: topInset, bottom: 16),
                    child: Padding(
                      padding: EdgeInsets.symmetric(horizontal: gutter),
                      child: topBar,
                    ),
                  ),
                Expanded(
                  child: scrollable
                      ? (refresh != null
                            ? RefreshIndicator(
                                onRefresh: refresh!,
                                color: c.accent,
                                backgroundColor: c.surface,
                                child: SingleChildScrollView(
                                  physics: const AlwaysScrollableScrollPhysics(),
                                  padding: const EdgeInsets.only(bottom: 32),
                                  child: content,
                                ),
                              )
                            : SingleChildScrollView(
                                padding: const EdgeInsets.only(bottom: 32),
                                child: content,
                              ))
                      : content,
                ),
                ?bottomNav,
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// `.card` / `.stat-card` — surface fill, 1px border, 16px radius.
class NovaCard extends StatelessWidget {
  const NovaCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(NovaSpace.md),
    this.radius = NovaRadius.card,
    this.onTap,
    this.raised = false,
    this.color,
  });

  final Widget child;
  final EdgeInsets padding;
  final double radius;
  final VoidCallback? onTap;
  final bool raised;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final body = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? (raised ? c.surfaceRaised : c.surface),
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: c.border),
      ),
      child: child,
    );

    if (onTap == null) return body;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(radius),
        child: body,
      ),
    );
  }
}

/// `.icon-btn` / `.menu-btn` — 40x40, 12px radius, glass fill, glass border.
class NovaIconButton extends StatelessWidget {
  const NovaIconButton({
    super.key,
    required this.icon,
    this.onTap,
    this.badge,
    this.size = 40,
    this.radius = NovaRadius.control,
    this.tooltip,
    this.color,
  });

  final IconData icon;
  final VoidCallback? onTap;
  final String? badge;
  final double size;
  final double radius;
  final String? tooltip;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    Widget button = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(radius),
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: c.glass,
            borderRadius: BorderRadius.circular(radius),
            border: Border.all(color: c.glassBorder),
          ),
          child: Icon(icon, size: size * 0.5, color: color ?? c.fg),
        ),
      ),
    );

    if (badge != null) {
      button = Stack(
        clipBehavior: Clip.none,
        children: [
          button,
          Positioned(
            top: -3,
            right: -3,
            child: NovaBadge(text: badge!),
          ),
        ],
      );
    }

    // brand-spec rule 5: touch targets >= 44px.
    final wrapped = SizedBox(
      width: size < NovaMotion.minTouchTarget ? NovaMotion.minTouchTarget : size,
      height: size < NovaMotion.minTouchTarget
          ? NovaMotion.minTouchTarget
          : size,
      child: Center(child: button),
    );

    return tooltip == null ? wrapped : Tooltip(message: tooltip!, child: wrapped);
  }
}

/// `.badge` — 18x18 accent circle with a count.
class NovaBadge extends StatelessWidget {
  const NovaBadge({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Container(
      width: 18,
      height: 18,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
      child: Text(
        text,
        style: TextStyle(
          fontFamily: NovaFonts.body,
          fontSize: NovaType.micro,
          fontWeight: NovaType.wBold,
          color: c.onAccent,
          height: 1,
        ),
      ),
    );
  }
}

/// Translucent "glass" panel — `--glass` fill with a `--glass-border` edge.
///
/// brand-spec rule 3: "Glass surfaces use low-opacity white/black with subtle
/// borders — never as the primary background."
class GlassPanel extends StatelessWidget {
  const GlassPanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(NovaSpace.md),
    this.radius = NovaRadius.card,
    this.borderRadius,
    this.blur = 12,
    this.onTap,
  });

  final Widget child;
  final EdgeInsets padding;
  final double radius;
  final BorderRadius? borderRadius;
  final double blur;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final r = borderRadius ?? BorderRadius.circular(radius);
    return ClipRRect(
      borderRadius: r,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onTap,
            child: Container(
              padding: padding,
              decoration: BoxDecoration(
                color: c.glass,
                borderRadius: r,
                border: Border.all(color: c.glassBorder),
              ),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

/// Empty / loading / error state used by every list screen.
///
/// The admin console learned this the hard way: pages that swallowed errors
/// rendered "No X found" for a 401, making an auth failure indistinguishable
/// from an empty database. This widget forces the distinction.
class NovaStateView extends StatelessWidget {
  const NovaStateView({
    super.key,
    this.icon,
    required this.title,
    this.message,
    this.actionLabel,
    this.onAction,
    this.loading = false,
    this.tone = NovaStateTone.neutral,
  });

  final IconData? icon;
  final String title;
  final String? message;
  final String? actionLabel;
  final VoidCallback? onAction;
  final bool loading;
  final NovaStateTone tone;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final toneColor = switch (tone) {
      NovaStateTone.neutral => c.muted,
      NovaStateTone.accent => c.accent,
      NovaStateTone.error => c.danger,
      NovaStateTone.success => c.success,
    };

    return Padding(
      padding: const EdgeInsets.symmetric(
        vertical: NovaSpace.xxl,
        horizontal: NovaSpace.lg,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (loading)
            SizedBox(
              width: 28,
              height: 28,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: c.accent,
              ),
            )
          else if (icon != null)
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: toneColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(NovaRadius.card),
                border: Border.all(color: toneColor.withValues(alpha: 0.25)),
              ),
              child: Icon(icon, color: toneColor, size: 26),
            ),
          const SizedBox(height: NovaSpace.md),
          Text(
            title,
            textAlign: TextAlign.center,
            style: NovaTheme.sectionHeading(c),
          ),
          if (message != null) ...[
            const SizedBox(height: NovaSpace.xs),
            Text(
              message!,
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: c.muted),
            ),
          ],
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(height: NovaSpace.md),
            NovaSecondaryButton(label: actionLabel!, onPressed: onAction),
          ],
        ],
      ),
    );
  }
}

enum NovaStateTone { neutral, accent, error, success }

/// `.stat-card` — icon, big value, uppercase label; optional delta line.
class NovaStatCard extends StatelessWidget {
  const NovaStatCard({
    super.key,
    required this.value,
    required this.label,
    this.icon,
    this.delta,
    this.deltaTone = NovaStateTone.success,
    this.onTap,
  });

  final String value;
  final String label;
  final String? icon;
  final String? delta;
  final NovaStateTone deltaTone;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final deltaColor = switch (deltaTone) {
      NovaStateTone.neutral => c.muted,
      NovaStateTone.accent => c.accent,
      NovaStateTone.error => c.danger,
      NovaStateTone.success => c.success,
    };

    return NovaCard(
      onTap: onTap,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Text(icon!, style: const TextStyle(fontSize: 18)),
            const SizedBox(height: NovaSpace.xs),
          ],
          Text(value, style: NovaTheme.statValue(c)),
          const SizedBox(height: 2),
          Text(
            label.toUpperCase(),
            style: NovaTheme.overline(c),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          if (delta != null) ...[
            const SizedBox(height: NovaSpace.xxs),
            Text(
              delta!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall!.copyWith(color: deltaColor, fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }
}

/// A settings/workspace row: leading icon chip, title, subtitle, chevron.
class NovaListRow extends StatelessWidget {
  const NovaListRow({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.emoji,
    this.trailing,
    this.onTap,
    this.iconTone,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final String? emoji;
  final Widget? trailing;
  final VoidCallback? onTap;
  final Color? iconTone;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final tone = iconTone ?? c.accent;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: NovaSpace.md,
            vertical: 14,
          ),
          child: Row(
            children: [
              if (emoji != null)
                Container(
                  width: 38,
                  height: 38,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: c.surfaceRaised,
                    borderRadius: BorderRadius.circular(NovaRadius.control),
                    border: Border.all(color: c.border),
                  ),
                  child: Text(emoji!, style: const TextStyle(fontSize: 18)),
                )
              else if (icon != null)
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: tone.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(NovaRadius.control),
                    border: Border.all(color: tone.withValues(alpha: 0.25)),
                  ),
                  child: Icon(icon, size: 18, color: tone),
                ),
              if (icon != null || emoji != null)
                const SizedBox(width: NovaSpace.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    if (subtitle != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitle!,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
              trailing ??
                  Icon(Icons.chevron_right, size: 18, color: c.muted),
            ],
          ),
        ),
      ),
    );
  }
}
