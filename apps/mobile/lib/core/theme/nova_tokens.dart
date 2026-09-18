import 'package:flutter/widgets.dart';

/// NOVA design tokens — ported from the OpenDesign handoff.
///
/// Source of truth: `assets/brand-spec.md` plus the `:root` blocks shared by all
/// 24 exported screens (`nova-mobile.zip`, DESIGN-HANDOFF.md). The export
/// declares its tokens in **OKLch**; the hex values here are the exact sRGB
/// equivalents, resolved two independent ways (OKLab->linear-sRGB maths and a
/// Chromium canvas probe) which agreed on every value.
///
/// DESIGN-HANDOFF.md is explicit that this is a visual contract and that
/// implementations must "match the exported pixels", so do not substitute
/// Tailwind/indigo defaults: the designed accent is #5778DF, *not* #6366F1.
///
/// The light theme is specified in `brand-spec.md` but **no exported screen
/// implements it** (all 24 are dark-only), so the light values below come from
/// the spec block alone and are not pixel-verified against a screen.
@immutable
class NovaColors {
  const NovaColors({
    required this.bg,
    required this.surface,
    required this.surfaceRaised,
    required this.fg,
    required this.muted,
    required this.border,
    required this.accent,
    required this.accentSecondary,
    required this.cyan,
    required this.success,
    required this.warning,
    required this.danger,
    required this.recording,
    required this.shadow,
    required this.glass,
    required this.glassBorder,
    required this.overlay,
    required this.onAccent,
  });

  final Color bg;
  final Color surface;
  final Color surfaceRaised;
  final Color fg;
  final Color muted;
  final Color border;
  final Color accent;
  final Color accentSecondary;
  final Color cyan;
  final Color success;
  final Color warning;
  final Color danger;
  final Color recording;
  final Color shadow;
  final Color glass;
  final Color glassBorder;
  final Color overlay;

  /// Foreground that sits on an accent/gradient fill. The export hardcodes
  /// `white` for CTA and mic-button labels.
  final Color onAccent;

  /// oklch(0.12 0.03 260)
  static const dark = NovaColors(
    bg: Color(0xFF020511),
    surface: Color(0xFF050F21),
    surfaceRaised: Color(0xFF0F1B2D),
    fg: Color(0xFFEBEFF5),
    muted: Color(0xFF6B727E),
    border: Color(0xFF1B2433),
    accent: Color(0xFF5778DF),
    accentSecondary: Color(0xFF8F7EDE),
    cyan: Color(0xFF3BCFCF),
    success: Color(0xFF35C177),
    warning: Color(0xFFF0BB3B),
    danger: Color(0xFFED5350),
    recording: Color(0xFFE24947),
    shadow: Color(0x66000000),
    glass: Color(0x0AFFFFFF),
    glassBorder: Color(0x14FFFFFF),
    overlay: Color(0x99000000),
    onAccent: Color(0xFFFFFFFF),
  );

  /// From `brand-spec.md` `[data-theme="light"]` (not present in any export).
  static const light = NovaColors(
    bg: Color(0xFFF3F5F9),
    surface: Color(0xFFFFFFFF),
    surfaceRaised: Color(0xFFF0F2F5),
    fg: Color(0xFF050B18),
    muted: Color(0xFF545E6F),
    border: Color(0xFFD0D8E5),
    accent: Color(0xFF3D5DCF),
    accentSecondary: Color(0xFF7563C0),
    cyan: Color(0xFF00989A),
    success: Color(0xFF00A159),
    warning: Color(0xFFCF9B00),
    danger: Color(0xFFD33A3C),
    recording: Color(0xFFD33A3C),
    shadow: Color(0x14000000),
    glass: Color(0x05000000),
    glassBorder: Color(0x0F000000),
    overlay: Color(0x66000000),
    onAccent: Color(0xFFFFFFFF),
  );

  /// Decorative page aura. `bg-aura::before` in the export: two blurred radial
  /// gradients — accent at 18% opacity, accent-secondary at 12%.
  List<Color> get auraColors => [
    accent.withValues(alpha: 0.18),
    accentSecondary.withValues(alpha: 0.12),
  ];

  /// `linear-gradient(135deg, var(--accent), var(--accent-secondary))`.
  /// brand-spec rule 4: the primary CTA always uses this gradient.
  LinearGradient get accentGradient => LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [accent, accentSecondary],
  );

  /// brand-spec rule 6: "Recording states always use the red-amber gradient,
  /// never indigo."
  LinearGradient get recordingGradient => LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [recording, warning],
  );

  /// Avatar container fill: `linear-gradient(180deg, surface-raised 40%, bg)`.
  LinearGradient get avatarContainerGradient => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [surfaceRaised.withValues(alpha: 0.4), bg],
  );

  /// Bottom-nav fill: `oklch(0.10 0.02 260 / 0.6)` + backdrop blur.
  Color get navBar => bg.withValues(alpha: 0.6);

  /// `oklch(0 0 0 / 0.5)` backdrop used by the avatar status pill.
  Color get pillScrim => const Color(0xFF000000).withValues(alpha: 0.5);
}

/// brand-spec.md "Font stacks". Screens must not fall back to framework
/// defaults — DESIGN-HANDOFF.md checklist item 9 rejects that explicitly.
class NovaFonts {
  const NovaFonts._();

  static const display = 'PlusJakartaSans';
  static const body = 'Inter';
  static const mono = 'JetBrainsMono';
  static const tamil = 'NotoSansTamil';
}

/// brand-spec.md rule 7 (overrides the blueprint's §6.3 scale where they
/// disagree — the export is the visual contract).
class NovaType {
  const NovaType._();

  static const display = 32.0;
  static const h1 = 24.0;
  static const h2 = 20.0;
  static const h3 = 17.0;
  static const body = 15.0;
  static const bodySmall = 14.0;
  static const caption = 12.0;

  /// Extras used by the exported screens.
  static const hero = 28.0; // .name
  static const stat = 22.0; // .stat-value
  static const label = 11.0; // .stat-label
  static const micro = 10.0; // .msg-label

  static const wLight = FontWeight.w300;
  static const wRegular = FontWeight.w400;
  static const wMedium = FontWeight.w500;
  static const wSemiBold = FontWeight.w600;
  static const wBold = FontWeight.w700;
  static const wExtraBold = FontWeight.w800;
}

/// Spacing scale from blueprint §6.4, which the export honours (4/8/12/16/24).
class NovaSpace {
  const NovaSpace._();

  static const xxs = 4.0;
  static const xs = 8.0;
  static const sm = 12.0;
  static const md = 16.0;
  static const lg = 24.0;
  static const xl = 32.0;
  static const xxl = 48.0;
  static const xxxl = 64.0;

  /// Screen gutter used by every exported screen (`padding: 0 24px`).
  static const gutter = 24.0;
}

/// Radii from the export: 8 small, 12 controls, 16 cards, 18 bubbles/CTA,
/// 24 large, 28 avatar container, 999 pills.
class NovaRadius {
  const NovaRadius._();

  static const sm = 8.0;
  static const control = 12.0;
  static const card = 16.0;
  static const bubble = 18.0;
  static const lg = 24.0;
  static const avatarContainer = 28.0;
  static const pill = 999.0;

  static const rSm = BorderRadius.all(Radius.circular(sm));
  static const rControl = BorderRadius.all(Radius.circular(control));
  static const rCard = BorderRadius.all(Radius.circular(card));
  static const rBubble = BorderRadius.all(Radius.circular(bubble));
  static const rLg = BorderRadius.all(Radius.circular(lg));
  static const rAvatarContainer = BorderRadius.all(
    Radius.circular(avatarContainer),
  );
  static const rPill = BorderRadius.all(Radius.circular(pill));
}

/// blueprint §6.5: UI transitions 180–280ms, avatar state transitions
/// 250–450ms, and the OS "Reduce Motion" setting must always be respected.
class NovaMotion {
  const NovaMotion._();

  static const fast = Duration(milliseconds: 120); // :active scale
  static const uiMin = Duration(milliseconds: 180);
  static const ui = Duration(milliseconds: 220);
  static const uiMax = Duration(milliseconds: 280);
  static const avatarMin = Duration(milliseconds: 250);
  static const avatar = Duration(milliseconds: 350);
  static const avatarMax = Duration(milliseconds: 450);

  /// Breathing loops from the export.
  static const breathe = Duration(seconds: 5); // .avatar-container::before
  static const breatheRing = Duration(seconds: 4); // .avatar-ring
  static const waveform = Duration(seconds: 1); // .recording-indicator .bar
  static const pulse = Duration(milliseconds: 1400); // .status-pill .dot

  /// Minimum touch target — brand-spec rule 5.
  static const minTouchTarget = 44.0;
}

/// Elevations from the export (`--shadow` plus the accent glow on the CTA).
class NovaShadows {
  const NovaShadows._();

  static List<BoxShadow> cta(NovaColors c) => [
    BoxShadow(
      color: c.accent.withValues(alpha: 0.5),
      blurRadius: 50,
      spreadRadius: -16,
      offset: const Offset(0, 20),
    ),
  ];

  static List<BoxShadow> mic(NovaColors c) => [
    BoxShadow(
      color: c.accent.withValues(alpha: 0.5),
      blurRadius: 40,
      spreadRadius: -12,
      offset: const Offset(0, 16),
    ),
  ];

  static List<BoxShadow> avatarRing(NovaColors c) => [
    BoxShadow(
      color: c.accent.withValues(alpha: 0.5),
      blurRadius: 80,
      spreadRadius: -20,
      offset: const Offset(0, 30),
    ),
  ];

  static List<BoxShadow> card(NovaColors c) => [
    BoxShadow(
      color: c.shadow,
      blurRadius: 24,
      spreadRadius: -8,
      offset: const Offset(0, 8),
    ),
  ];
}

/// Semantic icon/colour mapping for the avatar states in the export.
///
/// The export shows `Ready`, `Speaking` and `Listening…`. The blueprint's
/// §5.6 table is the longer target list; states with no designed screen are
/// marked so the UI can fall back rather than invent styling.
enum NovaAvatarState {
  idle('Ready'),
  wake('Wake detected'),
  listening('Listening…'),
  thinking('Thinking…'),
  awaitingConfirmation('Awaiting confirmation'),
  executing('Working…'),
  speaking('Speaking'),
  success('Done'),
  error('Something went wrong'),
  recording('Recording');

  const NovaAvatarState(this.label);

  final String label;

  /// `Recording` and `Listening` use the danger/red treatment
  /// (brand-spec rule 6); everything else is accent or neutral.
  bool get isRecordingStyle =>
      this == NovaAvatarState.recording || this == NovaAvatarState.listening;

  bool get isAnimated =>
      this != NovaAvatarState.idle && this != NovaAvatarState.error;
}
