import 'package:flutter/material.dart';

import '../../theme/nova_theme.dart';

/// `.cta-primary` — the gradient call to action.
///
/// Port of the export: full-width, 16px padding, 18px radius,
/// `linear-gradient(135deg, accent, accent-secondary)`, a 50px accent glow, and
/// a 120ms `scale(0.97)` press. brand-spec rule 4 requires every primary CTA to
/// use this gradient.
class NovaPrimaryButton extends StatefulWidget {
  const NovaPrimaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.gradient,
    this.busy = false,
    this.expand = true,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  /// Defaults to the accent gradient. Pass [NovaColors.recordingGradient] for
  /// recording actions — brand-spec rule 6 forbids indigo there.
  final Gradient? gradient;
  final bool busy;
  final bool expand;

  @override
  State<NovaPrimaryButton> createState() => _NovaPrimaryButtonState();
}

class _NovaPrimaryButtonState extends State<NovaPrimaryButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final enabled = widget.onPressed != null && !widget.busy;

    final button = AnimatedScale(
      scale: _pressed ? 0.97 : 1,
      duration: NovaMotion.fast,
      curve: Curves.easeOut,
      child: AnimatedOpacity(
        opacity: enabled ? 1 : 0.55,
        duration: NovaMotion.uiMin,
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            gradient: widget.gradient ?? c.accentGradient,
            borderRadius: BorderRadius.circular(NovaRadius.bubble),
            boxShadow: NovaShadows.cta(c),
          ),
          child: Row(
            mainAxisSize: widget.expand ? MainAxisSize.max : MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (widget.busy)
                SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.onAccent,
                  ),
                )
              else if (widget.icon != null)
                Icon(widget.icon, size: 19, color: c.onAccent),
              if (widget.busy || widget.icon != null)
                const SizedBox(width: 10),
              Text(
                widget.label,
                style: NovaTheme.cta(c).copyWith(color: c.onAccent),
              ),
            ],
          ),
        ),
      ),
    );

    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.label,
      child: GestureDetector(
        onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
        onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
        onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
        onTap: enabled ? widget.onPressed : null,
        behavior: HitTestBehavior.opaque,
        child: button,
      ),
    );
  }
}

/// Outlined/secondary action used for empty-state actions and destructive
/// confirmations.
class NovaSecondaryButton extends StatelessWidget {
  const NovaSecondaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.tone,
    this.expand = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final Color? tone;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final color = tone ?? c.fg;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onPressed,
        borderRadius: NovaRadius.rPill,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          decoration: BoxDecoration(
            color: c.surfaceRaised,
            borderRadius: NovaRadius.rPill,
            border: Border.all(color: c.border),
          ),
          child: Row(
            mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 16, color: color),
                const SizedBox(width: NovaSpace.xs),
              ],
              Text(
                label,
                style: NovaTheme.chip(c).copyWith(color: color),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// `.status-pill` — uppercase label with a coloured dot.
///
/// The export animates the dot (`.status-pill .dot { animation: pulse }`); set
/// [animate] false for static pills. Reduce Motion is honoured automatically.
class NovaStatusPill extends StatefulWidget {
  const NovaStatusPill({
    super.key,
    required this.label,
    this.tone,
    this.animate = true,
    this.icon,
  });

  final String label;
  final Color? tone;
  final bool animate;
  final IconData? icon;

  @override
  State<NovaStatusPill> createState() => _NovaStatusPillState();
}

class _NovaStatusPillState extends State<NovaStatusPill>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: NovaMotion.pulse,
  );

  @override
  void initState() {
    super.initState();
  }

  void _sync() {
    final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (widget.animate && !reduce) {
      _c.repeat(reverse: true);
    } else {
      _c.stop();
      _c.value = 1;
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
    final tone = widget.tone ?? c.danger;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.15),
        borderRadius: NovaRadius.rPill,
        border: Border.all(color: tone.withValues(alpha: 0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.icon != null)
            Icon(widget.icon, size: 12, color: tone)
          else
            FadeTransition(
              opacity: Tween<double>(begin: 0.5, end: 1).animate(_c),
              child: ScaleTransition(
                scale: Tween<double>(begin: 0.85, end: 1.1).animate(_c),
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: tone,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
          const SizedBox(width: 6),
          Text(
            widget.label.toUpperCase(),
            style: NovaTheme.statusPill(c).copyWith(color: tone),
          ),
        ],
      ),
    );
  }
}

/// `.chip` — horizontal quick-action pill.
class NovaChip extends StatelessWidget {
  const NovaChip({
    super.key,
    required this.label,
    this.onTap,
    this.icon,
    this.selected = false,
  });

  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: NovaRadius.rPill,
        child: AnimatedContainer(
          duration: NovaMotion.uiMin,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            color: selected
                ? c.accent.withValues(alpha: 0.16)
                : c.surfaceRaised,
            borderRadius: NovaRadius.rPill,
            border: Border.all(color: selected ? c.accent : c.border),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(
                  icon,
                  size: 14,
                  color: selected ? c.accent : c.muted,
                ),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: NovaTheme.chip(c).copyWith(
                  color: selected ? c.accent : c.fg,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Section header with an optional trailing action.
class NovaSectionHeader extends StatelessWidget {
  const NovaSectionHeader({
    super.key,
    required this.title,
    this.action,
    this.onAction,
    this.padded = false,
  });

  final String title;
  final String? action;
  final VoidCallback? onAction;
  final bool padded;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final row = Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          title.toUpperCase(),
          style: NovaTheme.overline(c),
        ),
        if (action != null)
          GestureDetector(
            onTap: onAction,
            child: Text(
              action!,
              style: NovaTheme.chip(c).copyWith(color: c.accent),
            ),
          ),
      ],
    );
    return padded
        ? Padding(
            padding: const EdgeInsets.symmetric(horizontal: NovaSpace.gutter),
            child: row,
          )
        : row;
  }
}

/// Outlined text field matching `.input-field`.
class NovaTextField extends StatelessWidget {
  const NovaTextField({
    super.key,
    this.controller,
    this.hint,
    this.label,
    this.obscure = false,
    this.keyboardType,
    this.onSubmitted,
    this.prefixIcon,
    this.suffix,
    this.autofocus = false,
    this.maxLines = 1,
    this.errorText,
    this.helperText,
    this.enabled = true,
    this.textInputAction,
    this.focusNode,
    this.onChanged,
    this.textCapitalization = TextCapitalization.none,
  });

  final TextEditingController? controller;
  final String? hint;
  final String? label;
  final bool obscure;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onSubmitted;
  final IconData? prefixIcon;
  final Widget? suffix;
  final bool autofocus;
  final int maxLines;
  final String? errorText;
  final String? helperText;
  final bool enabled;
  final TextInputAction? textInputAction;
  final FocusNode? focusNode;
  final ValueChanged<String>? onChanged;
  final TextCapitalization textCapitalization;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null) ...[
          Text(label!.toUpperCase(), style: NovaTheme.overline(c)),
          const SizedBox(height: 6),
        ],
        TextField(
          controller: controller,
          focusNode: focusNode,
          obscureText: obscure,
          keyboardType: keyboardType,
          onSubmitted: onSubmitted,
          onChanged: onChanged,
          textCapitalization: textCapitalization,
          autofocus: autofocus,
          maxLines: obscure ? 1 : maxLines,
          enabled: enabled,
          textInputAction: textInputAction,
          style: NovaTheme.input(c),
          cursorColor: c.accent,
          decoration: InputDecoration(
            hintText: hint,
            errorText: errorText,
            helperText: helperText,
            prefixIcon: prefixIcon == null
                ? null
                : Icon(prefixIcon, size: 18, color: c.muted),
            suffixIcon: suffix,
          ),
        ),
      ],
    );
  }
}
