import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/design/widgets/index.dart';
import '../../core/i18n/supported_languages.dart';

/// Live translation — port of `overlay/translate.html`.
///
/// Real wiring: the From/To pickers are real dropdowns over this app's own
/// `kSupportedLanguages`; "Auto-detect" is the real `detectLanguage()`
/// script/keyword detector; swap resolves a detected source into an explicit
/// code; Paste reads the real system clipboard; and the target pane renders a
/// genuine translation from `POST /api/v1/voice/translate` (Sarvam).
///
/// That route was added alongside this wiring: `translateText()` had existed in
/// `services/ai.ts` for a long time but nothing mounted it, which is why this
/// screen previously had to show a "not configured" state.
class TranslatePage extends ConsumerStatefulWidget {
  const TranslatePage({super.key, this.sourceText});

  /// Original text to prefill. Defaults to the export's real sample line.
  final String? sourceText;

  @override
  ConsumerState<TranslatePage> createState() => _TranslatePageState();
}

class _TranslatePageState extends ConsumerState<TranslatePage> {
  /// The exact copy shown in `overlay/translate.html`.
  static const String _exportSample = 'நாளைக்கு quotation அனுப்புங்கள்';

  /// Target-pane `.text-action`s: emoji, label, why each is off.
  static const List<(String, String, String)> _targetActions = [
    ('📋', 'Copy', 'There is no translation to copy yet.'),
    ('✏', 'Edit', 'There is no translation to edit yet.'),
    ('🔊', 'Speak', 'The server has TTS, but this app has no speech client yet.'),
    ('↗', 'Share', 'This app has no share integration yet.'),
  ];

  static const String _speakReason =
      'On-device speech capture is not implemented in this build.';

  late final TextEditingController _source = TextEditingController(
    text: widget.sourceText ?? _exportSample,
  );

  /// `null` = the design's "Auto-detect".
  String? _from;
  String _to = 'hi';

  /// The last real translation, or null before one has been requested.
  NovaTranslation? _translation;
  bool _busy = false;
  String? _error;

  /// Requests a real translation and records the outcome. The previous result is
  /// kept on screen while a new one is in flight so the pane does not flash.
  Future<void> _translate() async {
    final text = _source.text.trim();
    if (text.isEmpty) {
      setState(() {
        _translation = null;
        _error = 'Nothing to translate.';
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await ref.read(novaApiProvider).translate(
        text: text,
        sourceLanguage: _from ?? 'auto',
        targetLanguage: _to,
      );
      if (!mounted) return;
      setState(() {
        _translation = result;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _describe(e);
        _busy = false;
      });
    }
  }

  @override
  void initState() {
    super.initState();
    // Re-runs detection as the user types; nothing here touches MediaQuery.
    _source.addListener(_onSourceChanged);
  }

  void _onSourceChanged() => setState(() {});

  @override
  void dispose() {
    _source.removeListener(_onSourceChanged);
    _source.dispose();
    super.dispose();
  }

  void _back() {
    final router = GoRouter.maybeOf(context);
    if (router != null && router.canPop()) router.pop();
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (!mounted) return;
    final text = data?.text;
    if (text == null || text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('The clipboard is empty.')));
      return;
    }
    _source.text = text;
    _source.selection = TextSelection.collapsed(offset: text.length);
  }

  void _swap() {
    setState(() {
      final source = _from ?? detectLanguage(_source.text).primary;
      if (source == _to) return;
      _from = _to;
      _to = source;
    });
  }

  /// `Auto-detect`, or `Auto · <native name>` once real detection resolves it.
  String get _fromValue {
    if (_from != null) return _twoPartLabel(_from!);
    if (_source.text.trim().isEmpty) return 'Auto-detect';
    final detected = detectLanguage(_source.text);
    final language = getLanguageByCode(detected.primary);
    if (language == null) return 'Auto · ${detected.code}';
    return 'Auto · ${language.nativeName}';
  }

  static String _twoPartLabel(String code) {
    final language = getLanguageByCode(code);
    if (language == null) return getLanguageName(code);
    // The export's `.lang-value` reads "हिंदी Hindi" — native name, then English.
    return '${language.nativeName} ${language.name}';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final targetName = getLanguageByCode(_to)?.name ?? _to;

    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            // `.top-bar { padding: 44px 24px 16px }`.
            Padding(
              padding: const EdgeInsets.fromLTRB(
                NovaSpace.gutter, 44, NovaSpace.gutter, 16,
              ),
              child: Row(
                children: [
                  NovaIconButton(
                    icon: Icons.arrow_back_rounded,
                    size: 36,
                    tooltip: 'Back',
                    onTap: _back,
                  ),
                  Expanded(
                    child: Text(
                      'Translate with NOVA',
                      textAlign: TextAlign.center,
                      style: _display(c, 19),
                    ),
                  ),
                  const SizedBox(width: NovaMotion.minTouchTarget),
                ],
              ),
            ),
            Expanded(
              // `.content { padding: 8px 24px 0 }` + `.screen` bottom 40px.
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(
                  NovaSpace.gutter, 8, NovaSpace.gutter, 40,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: _select(
                            c,
                            label: 'From',
                            value: _from ?? '',
                            items: _languageItems(c, autoLabel: _fromValue),
                            onChanged: (code) => setState(
                              () => _from = code.isEmpty ? null : code,
                            ),
                          ),
                        ),
                        const SizedBox(width: NovaSpace.sm),
                        _swapButton(c),
                        const SizedBox(width: NovaSpace.sm),
                        Expanded(
                          child: _select(
                            c,
                            label: 'To',
                            value: _to,
                            items: _languageItems(c),
                            onChanged: (code) {
                              if (code.isEmpty) return;
                              setState(() => _to = code);
                              // Re-translate against the real endpoint.
                              _translate();
                            },
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: NovaSpace.md),
                    _textArea(
                      c,
                      label: 'Original text',
                      actions: [
                        _textAction(c, '🎙', 'Speak', reason: _speakReason),
                        _textAction(c, '📋', 'Paste', onTap: _paste),
                      ],
                      child: TextField(
                        controller: _source,
                        minLines: 2,
                        maxLines: null,
                        keyboardType: TextInputType.multiline,
                        style: _script(c, 18),
                        cursorColor: c.accent,
                        decoration: InputDecoration.collapsed(
                          hintText: 'Type or paste what you want translated…',
                          hintStyle: _script(c, 18).copyWith(color: c.muted),
                        ),
                      ),
                    ),
                    _textArea(
                      c,
                      label: '$targetName translation',
                      actions: [
                        for (final (emoji, label, reason) in _targetActions)
                          _textAction(c, emoji, label, reason: reason),
                      ],
                      child: _targetPane(c),
                    ),
                    const SizedBox(height: NovaSpace.lg),
                    _outbound(c),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// `.lang-select` — 12px radius, surface fill, uppercase label over a real
  /// dropdown driven by `kSupportedLanguages`. `itemHeight: 44` keeps the tap
  /// target at brand-spec rule 5.
  Widget _select(
    NovaColors c, {
    required String label,
    required String value,
    required List<DropdownMenuItem<String>> items,
    required ValueChanged<String> onChanged,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: NovaRadius.rControl,
        border: Border.all(color: c.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label.toUpperCase(), style: _fieldLabel(c)),
          DropdownButton<String>(
            value: value, items: items, isExpanded: true,
            // The design's control height is 44, but DropdownButton asserts
            // `itemHeight >= kMinInteractiveDimension` and crashes the screen in
            // debug builds, so keep it at the minimum allowed.
            itemHeight: kMinInteractiveDimension,
            onChanged: (picked) => onChanged(picked ?? ''),
            underline: const SizedBox.shrink(),
            dropdownColor: c.surfaceRaised, borderRadius: NovaRadius.rControl,
            icon: Icon(Icons.arrow_drop_down_rounded, size: 18, color: c.muted),
            style: _display(c, 14),
          ),
        ],
      ),
    );
  }

  /// `.swap-btn` — 36px circle on `--surface-raised`; 44px hit target.
  Widget _swapButton(NovaColors c) {
    return SizedBox(
      width: NovaMotion.minTouchTarget, height: NovaMotion.minTouchTarget,
      child: Center(
        child: IconButton(
          onPressed: _swap,
          tooltip: 'Swap languages',
          icon: Icon(Icons.swap_horiz_rounded, size: 16, color: c.fg),
          style: IconButton.styleFrom(
            backgroundColor: c.surfaceRaised,
            side: BorderSide(color: c.border),
            shape: const CircleBorder(), fixedSize: const Size(36, 36),
            padding: EdgeInsets.zero,
          ),
        ),
      ),
    );
  }

  /// `.text-area` + `.text-label` + `.text-actions`.
  Widget _textArea(
    NovaColors c, {
    required String label,
    required List<Widget> actions,
    required Widget child,
  }) {
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(minHeight: 120),
      margin: const EdgeInsets.only(bottom: NovaSpace.sm),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: NovaRadius.rCard,
        border: Border.all(color: c.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label.toUpperCase(), style: _fieldLabel(c)),
          const SizedBox(height: NovaSpace.xs),
          child,
          if (actions.isNotEmpty) ...[
            const SizedBox(height: NovaSpace.sm),
            Wrap(spacing: NovaSpace.xs, children: actions),
          ],
        ],
      ),
    );
  }

  /// `.text-action` — 8px radius, `--surface-raised`, muted 12px label. The hit
  /// area is padded to brand-spec rule 5's 44px without growing the pill.
  Widget _textAction(
    NovaColors c,
    String emoji,
    String label, {
    VoidCallback? onTap,
    String? reason,
  }) {
    final enabled = onTap != null;
    final button = TextButton.icon(
      onPressed: onTap,
      icon: Text(emoji, style: const TextStyle(fontSize: 12)),
      label: Text(label, style: NovaTheme.chip(c).copyWith(color: c.muted)),
      style: TextButton.styleFrom(
        backgroundColor: c.surfaceRaised,
        padding: const EdgeInsets.symmetric(horizontal: NovaSpace.sm, vertical: 6),
        minimumSize: Size.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const RoundedRectangleBorder(borderRadius: NovaRadius.rSm),
        side: BorderSide(color: c.border),
      ),
    );
    final hit = SizedBox(
      height: NovaMotion.minTouchTarget,
      child: Center(child: Opacity(opacity: enabled ? 1 : 0.45, child: button)),
    );
    if (enabled || reason == null) return hit;
    return Tooltip(message: reason, child: hit);
  }

  /// The target pane: a real translation from the API, with real loading and
  /// error states, and an explicit prompt before anything has been requested.
  Widget _targetPane(NovaColors c) {
    if (_busy && _translation == null) {
      return Row(
        children: [
          SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
          ),
          const SizedBox(width: NovaSpace.sm),
          Text('Translating…', style: _text(c, size: NovaType.caption + 1)),
        ],
      );
    }

    if (_error != null && _translation == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Translation failed', style: _display(c, 15, NovaType.wSemiBold)),
          const SizedBox(height: 6),
          Text(
            _error!,
            style: _text(c, size: NovaType.caption + 1, color: c.muted),
          ),
          const SizedBox(height: NovaSpace.sm),
          _miniButton(c, 'Try again', _translate),
        ],
      );
    }

    final result = _translation;
    if (result == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Ready to translate',
            style: _display(c, 15, NovaType.wSemiBold),
          ),
          const SizedBox(height: 6),
          Text(
            'Pick a target language, or press Translate, to send this text to '
            'the server.',
            style: _text(c, size: NovaType.caption + 1, color: c.muted),
          ),
          const SizedBox(height: NovaSpace.sm),
          _miniButton(c, 'Translate', _translate),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          result.translatedText,
          style: _display(c, 17, NovaType.wSemiBold),
        ),
        const SizedBox(height: NovaSpace.xs),
        Text(
          // The server reports what it detected, so "Auto" can name the real
          // language rather than claiming a guess.
          _from == null
              ? 'Detected ${_nameFor(result.detectedLanguage)} · via Sarvam'
              : '${_nameFor(result.sourceLanguage)} → '
                    '${_nameFor(result.targetLanguage)} · via Sarvam',
          style: _text(c, size: NovaType.caption, color: c.muted),
        ),
        if (_error != null) ...[
          const SizedBox(height: NovaSpace.xs),
          Text(
            'Showing the last successful result. ${_error!}',
            style: _text(c, size: NovaType.caption, color: c.warning),
          ),
        ],
      ],
    );
  }

  /// A small secondary action matching the export's `.mini-btn`.
  Widget _miniButton(NovaColors c, String label, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: c.surfaceRaised,
          borderRadius: NovaRadius.rControl,
          border: Border.all(color: c.border),
        ),
        child: Text(label, style: _text(c, size: NovaType.caption + 1)),
      ),
    );
  }

  /// `.out-btn.primary` — "Use as WhatsApp draft" (nothing to hand off yet).
  Widget _outbound(NovaColors c) {
    return Tooltip(
      message: 'NOVA has no share or WhatsApp integration in this app yet.',
      child: Opacity(
        opacity: 0.5,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.all(NovaSpace.sm + 2),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [c.success, c.accent],
            ),
            borderRadius: NovaRadius.rControl,
          ),
          child: Text(
            'Use as WhatsApp draft',
            textAlign: TextAlign.center,
            style: _text(
              c, size: 13, weight: NovaType.wMedium, color: c.onAccent, height: 1.3),
          ),
        ),
      ),
    );
  }
}

/// The From/To entries: the real `kSupportedLanguages` plus an "Auto-detect" row
/// whose `autoLabel` is the real `detectLanguage()` result.
List<DropdownMenuItem<String>> _languageItems(
  NovaColors c, {
  String? autoLabel,
}) => [
  if (autoLabel != null)
    DropdownMenuItem(value: '', child: Text(autoLabel, style: _display(c, 14))),
  for (final language in kSupportedLanguages)
    DropdownMenuItem(
      value: language.code,
      child: Text(
        '${language.nativeName} ${language.name}',
        overflow: TextOverflow.ellipsis, style: _display(c, 14),
      ),
    ),
];

/// Names a language the way the rest of the screen does. The API answers in
/// region-tagged codes (`ta-IN`) while `getLanguageName` is keyed on bare ISO
/// codes, so the region is stripped before lookup.
String _nameFor(String code) {
  if (code.isEmpty) return 'Unknown';
  final bare = code.contains('-') ? code.split('-').first : code;
  return getLanguageName(bare);
}

String _describe(Object error) {
  final text = error.toString();
  if (text.contains('401') || text.contains('403')) return 'session expired';
  final cleaned = text.replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');
  return cleaned.length > 130 ? '${cleaned.substring(0, 127)}…' : cleaned;
}

/// `.lang-label` / `.text-label` — 11px 600 uppercase, tracking .06em.
TextStyle _fieldLabel(NovaColors c) => _text(
  c, size: NovaType.label, weight: NovaType.wSemiBold, color: c.muted,
  height: 1.2, letterSpacing: 0.66,
);

/// `font-family: var(--font-tamil), var(--font-body)` from `.text-content`.
TextStyle _script(NovaColors c, double size) => _text(
    c, size: size, family: NovaFonts.tamil, fallback: const [NovaFonts.body]);

/// The export pins exact families/weights, so every style is built from the
/// bundled NovaFonts/NovaType tokens rather than framework defaults.
TextStyle _display(NovaColors c, double size, [FontWeight? weight]) => _text(
  c, size: size, weight: weight ?? NovaType.wBold, family: NovaFonts.display,
  height: 1.2, letterSpacing: -0.01,
);

TextStyle _text(
  NovaColors c, {
  double size = NovaType.body,
  FontWeight weight = NovaType.wRegular,
  Color? color,
  String family = NovaFonts.body,
  double height = 1.5,
  double? letterSpacing,
  List<String>? fallback,
}) => TextStyle(
  fontFamily: family,
  fontFamilyFallback: fallback,
  fontSize: size, fontWeight: weight, color: color ?? c.fg, height: height,
  letterSpacing: letterSpacing,
  fontVariations: [FontVariation('wght', NovaTheme.wght(weight))],
);
