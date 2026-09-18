import 'package:flutter/material.dart';

import '../../theme/nova_tokens.dart';
import '../../theme/nova_theme.dart';

/// Renders the light markdown the assistant actually emits.
///
/// The model answers in markdown — `**bold**`, `- bullets`, `---` rules — and
/// the transcript bubble used to print it raw, so replies read
/// "**NOVA** is here" instead of "**NOVA** is here" with the emphasis applied.
///
/// This is deliberately a small subset rather than a full CommonMark parser:
/// it covers what the assistant produces, adds no dependency, and cannot throw
/// on arbitrary model output. Anything it does not recognise is shown verbatim
/// rather than swallowed.
class NovaMarkdown extends StatelessWidget {
  const NovaMarkdown({
    super.key,
    required this.text,
    required this.style,
    this.codeStyle,
    this.tight = false,
  });

  final String text;

  /// Base style for body text. Inline emphasis is layered on top of it, so the
  /// caller's colour is preserved.
  final TextStyle style;

  /// Style for `` `inline code` ``. Defaults to the base style in the mono face.
  final TextStyle? codeStyle;

  /// When true, block spacing is halved — used inside the compact bubbles.
  final bool tight;

  @override
  Widget build(BuildContext context) {
    final blocks = _parseBlocks(text);
    if (blocks.isEmpty) {
      return Text(text, style: style);
    }
    final gap = tight ? NovaSpace.xxs : NovaSpace.xs;
    final children = <Widget>[];
    for (var i = 0; i < blocks.length; i++) {
      if (i > 0) children.add(SizedBox(height: gap));
      children.add(blocks[i].build(this));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: children,
    );
  }

  TextStyle get resolvedCodeStyle =>
      codeStyle ??
      style.copyWith(fontFamily: NovaFonts.mono, fontSize: (style.fontSize ?? NovaType.body) - 1);

  /// Renders a run of text with inline emphasis applied.
  TextSpan span(String source) => TextSpan(
    style: style,
    children: _inlineSpans(source, resolvedCodeStyle),
  );

  // ── Parsing ────────────────────────────────────────────────────────────────

  /// Matches `**bold**`, `__bold__`, `*italic*`, `_italic_` and `` `code` ``.
  /// Bold alternatives come first so `**x**` never parses as nested italics.
  static final RegExp _inline = RegExp(
    r'\*\*(.+?)\*\*|__(.+?)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`',
  );

  List<InlineSpan> _inlineSpans(String source, TextStyle code) {
    final spans = <InlineSpan>[];
    var cursor = 0;
    for (final match in _inline.allMatches(source)) {
      if (match.start > cursor) {
        spans.add(TextSpan(text: source.substring(cursor, match.start)));
      }
      final bold = match.group(1) ?? match.group(2);
      final italic = match.group(3) ?? match.group(4);
      final mono = match.group(5);
      if (bold != null) {
        spans.add(
          TextSpan(
            text: bold,
            style: const TextStyle(fontWeight: NovaType.wBold),
          ),
        );
      } else if (italic != null) {
        spans.add(
          TextSpan(
            text: italic,
            style: const TextStyle(fontStyle: FontStyle.italic),
          ),
        );
      } else if (mono != null) {
        spans.add(TextSpan(text: mono, style: code));
      }
      cursor = match.end;
    }
    if (cursor < source.length) {
      spans.add(TextSpan(text: source.substring(cursor)));
    }
    return spans;
  }

  static final RegExp _bullet = RegExp(r'^\s*[-*•]\s+(.*)$');
  static final RegExp _ordered = RegExp(r'^\s*(\d{1,3})[.)]\s+(.*)$');
  static final RegExp _rule = RegExp(r'^\s*([-*_])\s*(?:\1\s*){2,}$');
  static final RegExp _heading = RegExp(r'^\s*(#{1,6})\s+(.*)$');

  List<_Block> _parseBlocks(String source) {
    final lines = source.replaceAll('\r\n', '\n').split('\n');
    final blocks = <_Block>[];
    final paragraph = <String>[];
    final bullets = <String>[];
    final ordered = <(String, String)>[];

    void flushParagraph() {
      if (paragraph.isEmpty) return;
      blocks.add(_Paragraph(paragraph.join(' ')));
      paragraph.clear();
    }

    void flushBullets() {
      if (bullets.isEmpty) return;
      blocks.add(_Bullets(List<String>.of(bullets)));
      bullets.clear();
    }

    void flushOrdered() {
      if (ordered.isEmpty) return;
      blocks.add(_Ordered(List<(String, String)>.of(ordered)));
      ordered.clear();
    }

    void flushAll() {
      flushParagraph();
      flushBullets();
      flushOrdered();
    }

    for (final line in lines) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) {
        flushAll();
        continue;
      }
      if (_rule.hasMatch(trimmed)) {
        flushAll();
        blocks.add(const _Rule());
        continue;
      }
      final heading = _heading.firstMatch(trimmed);
      if (heading != null) {
        flushAll();
        blocks.add(_Heading(heading.group(2)!.trim(), heading.group(1)!.length));
        continue;
      }
      final bullet = _bullet.firstMatch(line);
      if (bullet != null) {
        flushParagraph();
        flushOrdered();
        bullets.add(bullet.group(1)!.trim());
        continue;
      }
      final number = _ordered.firstMatch(line);
      if (number != null) {
        flushParagraph();
        flushBullets();
        ordered.add((number.group(1)!, number.group(2)!.trim()));
        continue;
      }
      flushBullets();
      flushOrdered();
      paragraph.add(trimmed);
    }
    flushAll();
    return blocks;
  }
}

// ── Blocks ───────────────────────────────────────────────────────────────────

sealed class _Block {
  const _Block();

  Widget build(NovaMarkdown owner);
}

class _Paragraph extends _Block {
  const _Paragraph(this.text);

  final String text;

  @override
  Widget build(NovaMarkdown owner) =>
      Text.rich(owner.span(text), textAlign: TextAlign.start);
}

class _Heading extends _Block {
  const _Heading(this.text, this.level);

  final String text;
  final int level;

  @override
  Widget build(NovaMarkdown owner) {
    // The transcript is already inside a capped bubble, so headings are
    // flattened to a bold run of body text rather than jumping the type scale.
    return Text.rich(
      TextSpan(
        style: owner.style.copyWith(fontWeight: NovaType.wBold),
        children: owner._inlineSpans(text, owner.resolvedCodeStyle),
      ),
    );
  }
}

class _Bullets extends _Block {
  const _Bullets(this.items);

  final List<String> items;

  @override
  Widget build(NovaMarkdown owner) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      for (final item in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1, right: 6),
                child: Text('•', style: owner.style),
              ),
              Expanded(child: Text.rich(owner.span(item))),
            ],
          ),
        ),
    ],
  );
}

class _Ordered extends _Block {
  const _Ordered(this.items);

  /// (number as written, text)
  final List<(String, String)> items;

  @override
  Widget build(NovaMarkdown owner) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      for (final (number, item) in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1, right: 6),
                child: Text('$number.', style: owner.style),
              ),
              Expanded(child: Text.rich(owner.span(item))),
            ],
          ),
        ),
    ],
  );
}

class _Rule extends _Block {
  const _Rule();

  @override
  Widget build(NovaMarkdown owner) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Divider(
      height: 1,
      thickness: 1,
      color: owner.style.color?.withValues(alpha: 0.18),
    ),
  );
}
