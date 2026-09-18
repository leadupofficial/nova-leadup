import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

import 'nova_tokens.dart';

export 'nova_tokens.dart';

/// NOVA theme, generated from the OpenDesign tokens.
///
/// Replaces the earlier 32-line stub, which declared eleven colours and a
/// `ThemeData.dark()` and nothing else — no typography, no component themes, no
/// light theme — and whose accent (`#06B6D4`) did not match the design
/// (`#5778DF`).
///
/// The blueprint (§6.1) requires a dark-first theme *and* a light theme "for
/// accessibility/office use"; the light palette comes from the brand spec's
/// `[data-theme="light"]` block.
class NovaTheme {
  const NovaTheme._();

  /// Numeric `wght` axis value for a [FontWeight]. Used with `fontVariations`
  /// so the bundled variable fonts render at the exact weight the design asks
  /// for rather than the nearest static instance.
  static double wght(FontWeight w) => switch (w) {
    FontWeight.w100 => 100,
    FontWeight.w200 => 200,
    FontWeight.w300 => 300,
    FontWeight.w400 => 400,
    FontWeight.w500 => 500,
    FontWeight.w600 => 600,
    FontWeight.w700 => 700,
    FontWeight.w800 => 800,
    FontWeight.w900 => 900,
    _ => 400,
  };

  /// blueprint §6.5: "always respect the OS 'Reduce Motion' setting".
  /// Screens use this to suppress the breathing/pulse loops the export
  /// specifies, rather than animating regardless.
  static bool reduceMotion(BuildContext context) =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  static ThemeData dark({bool reduceMotion = false}) =>
      _build(NovaColors.dark, Brightness.dark);

  static ThemeData light({bool reduceMotion = false}) =>
      _build(NovaColors.light, Brightness.light);

  /// Back-compat alias — the app previously had only a dark theme.
  static ThemeData get darkTheme => dark();

  // ── Transitional colour aliases ───────────────────────────────────────────
  //
  // The pre-redesign screens referenced named constants on this class, in
  // `const` expressions. Those constants used to hold the old, off-brand palette
  // (accent `#06B6D4`, bg `#0F172A`, primary `#6366F1`) which does not match the
  // OpenDesign export. They now carry the design's dark tokens, so the existing
  // screens render in the correct brand colours without a half-finished
  // migration.
  //
  // Dart cannot read a const object's field in a const expression, so these
  // repeat the literals from [NovaColors.dark] — the ONLY sanctioned
  // duplication of the palette in this app. New code uses `context.nova`.
  // This block is deleted screen by screen as each is rebuilt from the export.
  //
  //                     value       == NovaColors.dark
  static const primary = Color(0xFF5778DF); // accent
  static const primaryDark = Color(0xFF5778DF); // accent (no darker token exists)
  static const accent = Color(0xFF3BCFCF); // cyan
  static const surface = Color(0xFF050F21); // surface
  static const surfaceVariant = Color(0xFF0F1B2D); // surfaceRaised
  static const background = Color(0xFF020511); // bg
  static const border = Color(0xFF1B2433); // border
  static const success = Color(0xFF35C177); // success
  static const error = Color(0xFFED5350); // danger
  static const warning = Color(0xFFF0BB3B); // warning
  static const onSurfaceVariant = Color(0xFF6B727E); // muted

  static ThemeData _build(NovaColors c, Brightness brightness) {
    final text = _textTheme(c);

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      scaffoldBackgroundColor: c.bg,
      canvasColor: c.bg,
      colorScheme: ColorScheme(
        brightness: brightness,
        primary: c.accent,
        onPrimary: c.onAccent,
        secondary: c.accentSecondary,
        onSecondary: c.onAccent,
        error: c.danger,
        onError: c.onAccent,
        surface: c.surface,
        onSurface: c.fg,
        surfaceContainerHighest: c.surfaceRaised,
        outline: c.border,
      ),
      fontFamily: NovaFonts.body,
      textTheme: text,
      primaryTextTheme: text,
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: _display(c, NovaType.h2, NovaType.wBold),
        iconTheme: IconThemeData(color: c.fg),
      ),
      iconTheme: IconThemeData(color: c.fg, size: 22),
      dividerTheme: DividerThemeData(color: c.border, thickness: 1, space: 1),
      progressIndicatorTheme: ProgressIndicatorThemeData(color: c.accent),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: c.surface,
        hintStyle: _body(c, NovaType.bodySmall, color: c.muted),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: NovaSpace.md,
          vertical: NovaSpace.sm,
        ),
        border: OutlineInputBorder(
          borderRadius: NovaRadius.rPill,
          borderSide: BorderSide(color: c.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: NovaRadius.rPill,
          borderSide: BorderSide(color: c.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: NovaRadius.rPill,
          borderSide: BorderSide(color: c.accent),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: NovaRadius.rPill,
          borderSide: BorderSide(color: c.danger),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: c.surfaceRaised,
        contentTextStyle: _body(c, NovaType.bodySmall),
        behavior: SnackBarBehavior.floating,
        shape: const RoundedRectangleBorder(borderRadius: NovaRadius.rControl),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: c.surface,
        modalBackgroundColor: c.surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(NovaRadius.lg),
          ),
        ),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? c.onAccent : c.muted,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? c.accent : c.surfaceRaised,
        ),
        trackOutlineColor: WidgetStateProperty.all(c.border),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: FadeUpwardsPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Typography — brand-spec.md rule 7 and the export's font stacks.
  // ---------------------------------------------------------------------------

  static TextStyle _display(
    NovaColors c,
    double size, [
    FontWeight w = NovaType.wBold,
  ]) => TextStyle(
    fontFamily: NovaFonts.display,
    fontSize: size,
    fontWeight: w,
    color: c.fg,
    height: 1.2,
    letterSpacing: size >= 28 ? -0.02 : -0.01,
    fontVariations: [FontVariation('wght', wght(w))],
  );

  static TextStyle _body(
    NovaColors c,
    double size, {
    Color? color,
    FontWeight w = NovaType.wRegular,
    double height = 1.5,
  }) => TextStyle(
    fontFamily: NovaFonts.body,
    fontSize: size,
    fontWeight: w,
    color: color ?? c.fg,
    height: height,
    fontVariations: [FontVariation('wght', wght(w))],
  );

  static TextStyle _mono(
    NovaColors c,
    double size, [
    FontWeight w = NovaType.wRegular,
  ]) => TextStyle(
    fontFamily: NovaFonts.mono,
    fontSize: size,
    fontWeight: w,
    color: c.muted,
    letterSpacing: 0.06,
    fontVariations: [FontVariation('wght', wght(w))],
  );

  static TextTheme _textTheme(NovaColors c) => TextTheme(
    displayLarge: _display(c, NovaType.display, NovaType.wExtraBold),
    displayMedium: _display(c, NovaType.hero, NovaType.wExtraBold),
    displaySmall: _display(c, NovaType.display),
    headlineLarge: _display(c, NovaType.h1),
    headlineMedium: _display(c, NovaType.h2),
    headlineSmall: _display(c, NovaType.h3, NovaType.wSemiBold),
    titleLarge: _display(c, NovaType.h3, NovaType.wSemiBold),
    titleMedium: _body(c, NovaType.body, w: NovaType.wSemiBold),
    bodyLarge: _body(c, NovaType.body),
    bodyMedium: _body(c, NovaType.bodySmall),
    bodySmall: _body(c, NovaType.caption, color: c.muted),
    labelLarge: _body(c, NovaType.bodySmall, w: NovaType.wSemiBold),
    labelMedium: _body(c, NovaType.label, color: c.muted, w: NovaType.wMedium),
    labelSmall: _mono(c, NovaType.micro),
  );

  // ---------------------------------------------------------------------------
  // Named styles the exported screens use directly (class names in comments).
  // ---------------------------------------------------------------------------

  /// `.greeting` — 13px, muted, uppercase, letter-spacing .04em.
  static TextStyle greeting(NovaColors c) =>
      _body(c, NovaType.caption + 1, color: c.muted, w: NovaType.wMedium)
          .copyWith(letterSpacing: 0.52, height: 1.3);

  /// `.name` — display 800, 28px, letter-spacing -0.02em.
  static TextStyle heroName(NovaColors c) =>
      _display(c, NovaType.hero, NovaType.wExtraBold);

  /// `.date`
  static TextStyle dateLine(NovaColors c) =>
      _body(c, NovaType.caption + 1, color: c.muted, height: 1.3);

  /// `.section-title` / `.stat-label` — 11px uppercase muted, tracking .08em.
  static TextStyle overline(NovaColors c) =>
      _body(c, NovaType.label, color: c.muted, w: NovaType.wMedium)
          .copyWith(letterSpacing: 0.88, height: 1.3);

  /// `.stat-value` — display 700, 22px.
  static TextStyle statValue(NovaColors c) =>
      _display(c, NovaType.stat, NovaType.wBold);

  /// `.msg-label` — 10px uppercase, tracking .08em.
  static TextStyle msgLabel(NovaColors c) =>
      _body(c, NovaType.micro, color: c.muted, w: NovaType.wSemiBold)
          .copyWith(letterSpacing: 0.8, height: 1.3);

  /// `.overview` — display 700, 17px.
  static TextStyle sectionHeading(NovaColors c) =>
      _display(c, NovaType.h3, NovaType.wBold);

  /// `.input-field` text.
  static TextStyle input(NovaColors c) => _body(c, NovaType.bodySmall);

  /// `.msg-bubble`.
  static TextStyle bubble(NovaColors c) => _body(c, NovaType.bodySmall);

  /// `.chip`.
  static TextStyle chip(NovaColors c) =>
      _body(c, NovaType.caption, w: NovaType.wMedium);

  /// `.status-pill` — 11px, 600, uppercase, tracking .06em.
  static TextStyle statusPill(NovaColors c) =>
      _body(c, NovaType.label, w: NovaType.wSemiBold)
          .copyWith(letterSpacing: 0.66, height: 1.2);

  /// `.nav-item` label.
  static TextStyle navLabel(NovaColors c) =>
      _body(c, NovaType.micro, w: NovaType.wMedium).copyWith(height: 1.1);

  /// `.avatar-state` pill.
  static TextStyle avatarState(NovaColors c) =>
      _body(c, NovaType.caption, w: NovaType.wMedium);

  /// `.cta-primary` label.
  static TextStyle cta(NovaColors c) =>
      _display(c, NovaType.body, NovaType.wSemiBold);
}

/// `context.nova` — token access without threading [NovaColors] through widgets.
extension NovaContext on BuildContext {
  NovaColors get nova => Theme.of(this).brightness == Brightness.dark
      ? NovaColors.dark
      : NovaColors.light;

  bool get novaReduceMotion => NovaTheme.reduceMotion(this);
}
