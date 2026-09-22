#!/usr/bin/env python3
"""Generates the store listing artwork.

Both stores require images that do not exist anywhere in the repository, and a listing
cannot be submitted without them:

  * **Google Play** — a 512x512 listing icon, a 1024x500 feature graphic, and 2-8 phone
    screenshots. The icon and the feature graphic are produced here.
  * **App Store Connect** — a 1024x1024 marketing icon with no alpha channel, which
    `apps/mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset` already carries; the
    512 Play icon is derived from the same master so the two cannot drift.

There is no imaging library available in this environment (no Pillow, no ImageMagick,
and `qlmanage` letterboxes and rescales an SVG unpredictably), so this writes PNGs
directly — zlib for the compression, struct for the container — and draws the type with a
small stroke font defined below. That keeps the artwork reproducible from the repository
instead of being a binary nobody can regenerate.

Colours are the app's own tokens (`apps/mobile/lib/core/theme/nova_tokens.dart`):
primary `#5778DF`, accent `#3BCFCF`, deep `#2A3C8F`.

Usage:
    python3 store-assets/generate.py
"""
import math
import struct
import sys
import zlib
from pathlib import Path

PRIMARY = (0x57, 0x78, 0xDF)
ACCENT = (0x3B, 0xCF, 0xCF)
DEEP = (0x2A, 0x3C, 0x8F)
WHITE = (255, 255, 255)

SS = 3  # supersampling factor, for anti-aliasing without a drawing library

OUT = Path(__file__).resolve().parent


# ─── PNG output ───────────────────────────────────────────────────────────────

def write_png(path, rows, with_alpha):
    size_w = len(rows[0])
    size_h = len(rows)
    colour_type = 6 if with_alpha else 2
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter: none
        for px in row:
            raw += bytes(px[:4] if with_alpha else px[:3])

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', size_w, size_h, 8, colour_type, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


# ─── A stroke font ────────────────────────────────────────────────────────────
#
# Each glyph is a list of polylines on a 4-wide, 6-tall grid (y grows downward). Drawn
# as thick anti-aliased strokes, which stays legible at any size — unlike a bitmap font,
# which goes blocky the moment it is scaled to a feature graphic.

FONT = {
    'A': [[(0, 6), (0, 2), (2, 0), (4, 2), (4, 6)], [(0, 4), (4, 4)]],
    'B': [[(0, 6), (0, 0), (3, 0), (4, 1), (3, 3), (0, 3)], [(3, 3), (4, 4), (3, 6), (0, 6)]],
    'C': [[(4, 1), (2, 0), (0, 2), (0, 4), (2, 6), (4, 5)]],
    'D': [[(0, 6), (0, 0), (3, 0), (4, 2), (4, 4), (3, 6), (0, 6)]],
    'E': [[(4, 0), (0, 0), (0, 6), (4, 6)], [(0, 3), (3, 3)]],
    'F': [[(4, 0), (0, 0), (0, 6)], [(0, 3), (3, 3)]],
    'G': [[(4, 1), (2, 0), (0, 2), (0, 4), (2, 6), (4, 5), (4, 3), (2, 3)]],
    'H': [[(0, 0), (0, 6)], [(4, 0), (4, 6)], [(0, 3), (4, 3)]],
    'I': [[(1, 0), (3, 0)], [(2, 0), (2, 6)], [(1, 6), (3, 6)]],
    'J': [[(4, 0), (4, 5), (2, 6), (0, 5)]],
    'K': [[(0, 0), (0, 6)], [(4, 0), (0, 3)], [(0, 3), (4, 6)]],
    'L': [[(0, 0), (0, 6), (4, 6)]],
    'M': [[(0, 6), (0, 0), (2, 3), (4, 0), (4, 6)]],
    'N': [[(0, 6), (0, 0), (4, 6), (4, 0)]],
    'O': [[(2, 0), (0, 2), (0, 4), (2, 6), (4, 4), (4, 2), (2, 0)]],
    'P': [[(0, 6), (0, 0), (3, 0), (4, 1), (4, 2), (3, 3), (0, 3)]],
    'Q': [[(2, 0), (0, 2), (0, 4), (2, 6), (4, 4), (4, 2), (2, 0)], [(3, 4), (4, 6)]],
    'R': [[(0, 6), (0, 0), (3, 0), (4, 1), (4, 2), (3, 3), (0, 3)], [(2, 3), (4, 6)]],
    'S': [[(4, 1), (2, 0), (0, 1), (0, 2), (2, 3), (4, 4), (4, 5), (2, 6), (0, 5)]],
    'T': [[(0, 0), (4, 0)], [(2, 0), (2, 6)]],
    'U': [[(0, 0), (0, 4), (2, 6), (4, 4), (4, 0)]],
    'V': [[(0, 0), (2, 6), (4, 0)]],
    'W': [[(0, 0), (1, 6), (2, 3), (3, 6), (4, 0)]],
    'X': [[(0, 0), (4, 6)], [(4, 0), (0, 6)]],
    'Y': [[(0, 0), (2, 3), (4, 0)], [(2, 3), (2, 6)]],
    'Z': [[(0, 0), (4, 0), (0, 6), (4, 6)]],
    ' ': [],
    '-': [[(1, 3), (3, 3)]],
    '.': [[(2, 5.4), (2, 6)]],
    "'": [[(2, 0), (2, 1.4)]],
}

GLYPH_W = 4.0
GLYPH_H = 6.0
ADVANCE = 6.0  # 4 wide + 2 of letter spacing


def text_width(text, height):
    """Width in pixels of `text` drawn at the given glyph height."""
    scale = height / GLYPH_H
    return max(0.0, (len(text) * ADVANCE - (ADVANCE - GLYPH_W)) * scale)


def _distance_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def draw_text(canvas, text, x, y, height, colour, thickness=None, opacity=255):
    """Draws `text` with its top-left at (x, y) into a float RGB canvas."""
    scale = height / GLYPH_H
    stroke = thickness if thickness is not None else height * 0.11
    half = stroke / 2.0
    cw = len(canvas[0])
    ch = len(canvas)

    for index, ch_ in enumerate(text.upper()):
        polylines = FONT.get(ch_, FONT[' '])
        ox = x + index * ADVANCE * scale
        for line in polylines:
            for i in range(len(line) - 1):
                (x1, y1), (x2, y2) = line[i], line[i + 1]
                x1, y1 = ox + x1 * scale, y + y1 * scale
                x2, y2 = ox + x2 * scale, y + y2 * scale
                min_x = max(0, int(min(x1, x2) - stroke - 2))
                max_x = min(cw - 1, int(max(x1, x2) + stroke + 2))
                min_y = max(0, int(min(y1, y2) - stroke - 2))
                max_y = min(ch - 1, int(max(y1, y2) + stroke + 2))
                for py in range(min_y, max_y + 1):
                    for px in range(min_x, max_x + 1):
                        d = _distance_to_segment(px + 0.5, py + 0.5, x1, y1, x2, y2)
                        if d <= half:
                            cover = 1.0
                        elif d <= half + 1.0:
                            cover = half + 1.0 - d
                        else:
                            continue
                        cover *= opacity / 255.0
                        cell = canvas[py][px]
                        canvas[py][px] = (
                            cell[0] + (colour[0] - cell[0]) * cover,
                            cell[1] + (colour[1] - cell[1]) * cover,
                            cell[2] + (colour[2] - cell[2]) * cover,
                        )


# ─── Backgrounds ──────────────────────────────────────────────────────────────

def diagonal_gradient(width, height, radius_hint=None):
    """The brand gradient, with the same radial vignette as the app icon so the listing
    artwork and the icon look like one product."""
    canvas = [[(0.0, 0.0, 0.0)] * width for _ in range(height)]
    cx, cy = width / 2.0, height / 2.0
    radius = radius_hint or (max(width, height) * 0.72)
    for y in range(height):
        for x in range(width):
            t = (x / width + y / height) / 2.0
            base = tuple(PRIMARY[i] + (ACCENT[i] - PRIMARY[i]) * t for i in range(3))
            d = math.hypot(x - cx, y - cy) / radius
            k = min(1.0, d * d) * 0.30
            canvas[y][x] = tuple(base[i] + (DEEP[i] - base[i]) * k for i in range(3))
    return canvas


def draw_waveform(canvas, cx, cy, total_w, colour, opacity=255, heights=(0.20, 0.36, 0.54, 0.36, 0.20)):
    """The five-bar voice mark the app icon and the splash screen use."""
    bar_w = total_w / (len(heights) * 3.0)
    gap = bar_w
    span = len(heights) * bar_w + (len(heights) - 1) * gap
    left0 = cx - span / 2.0
    for i, h in enumerate(heights):
        bh = h * total_w
        left = left0 + i * (bar_w + gap)
        top = cy - bh / 2.0
        _rounded_bar(canvas, left, top, bar_w, bh, colour, opacity)


def _rounded_bar(canvas, left, top, width, height, colour, opacity=255):
    radius = width / 2.0
    cw, ch = len(canvas[0]), len(canvas)
    for py in range(max(0, int(top) - 1), min(ch, int(top + height) + 2)):
        for px in range(max(0, int(left) - 1), min(cw, int(left + width) + 2)):
            fx, fy = px + 0.5, py + 0.5
            dx = max(left + radius - fx, 0, fx - (left + width - radius))
            dy = max(top + radius - fy, 0, fy - (top + height - radius))
            d = math.hypot(dx, dy)
            if d <= radius - 0.5:
                cover = 1.0
            elif d <= radius + 0.5:
                cover = radius + 0.5 - d
            else:
                continue
            cover *= opacity / 255.0
            cell = canvas[py][px]
            canvas[py][px] = tuple(cell[i] + (colour[i] - cell[i]) * cover for i in range(3))


def to_rows(canvas, with_alpha=False, alpha=255):
    rows = []
    for row in canvas:
        out = []
        for (r, g, b) in row:
            px = (int(round(r)), int(round(g)), int(round(b)))
            out.append(px + (alpha,) if with_alpha else px)
        rows.append(out)
    return rows


# ─── The assets ───────────────────────────────────────────────────────────────

def feature_graphic():
    """1024x500, Google Play's feature graphic.

    Play crops this to a 1024x500 banner and overlays nothing, but it is also used
    smaller in some surfaces, so the wordmark is centred and large enough to survive
    being scaled down. No text sits in the outer ~10% because Play's own guidance warns
    that edges can be cropped on some placements.
    """
    w, h = 1024, 500
    canvas = diagonal_gradient(w, h)

    wave_w = 150
    draw_waveform(canvas, w / 2.0, 150, wave_w, WHITE, opacity=235)

    title = 'NOVA'
    title_h = 118
    draw_text(canvas, title, (w - text_width(title, title_h)) / 2.0, 232, title_h, WHITE)

    tagline = 'YOUR VOICE COMPANION'
    tag_h = 30
    draw_text(canvas, tagline, (w - text_width(tagline, tag_h)) / 2.0, 378, tag_h,
              WHITE, thickness=4.0, opacity=205)

    write_png(OUT / 'play-feature-graphic-1024x500.png', to_rows(canvas), with_alpha=False)


def play_icon(ios_master):
    """512x512 listing icon, derived from the iOS marketing icon.

    Play takes a PNG or JPEG up to 1 MB; 512x512 is the required size and the file must
    not carry a transparent background. Deriving it from the same master the app icon
    uses is what stops the two drifting apart.
    """
    import subprocess

    out = OUT / 'play-icon-512.png'
    subprocess.run(
        ['sips', '-z', '512', '512', str(ios_master), '--out', str(out)],
        check=True, capture_output=True,
    )
    return out



# ─── Screenshot framing ───────────────────────────────────────────────────────
#
# Google Play rejects a phone screenshot whose aspect ratio exceeds **2:1**. The app's
# native captures are 1080x2424 (2.24:1), so they are rejected as they come off the
# device — which is easy to miss, because the images look perfectly fine. Each one is
# therefore scaled to fit and centred on a 2:1 canvas in the brand gradient.
#
# `sips` does the resampling (it has a proper filter; this file does not), and the
# composite is a straight integer paste, so no second resample is introduced.

SCREENSHOT_CANVAS = (1200, 2400)  # exactly 2:1


def _paste(canvas, image, offset_x, offset_y):
    for y, row in enumerate(image):
        target_y = offset_y + y
        if target_y < 0 or target_y >= len(canvas):
            continue
        canvas_row = canvas[target_y]
        for x, px in enumerate(row):
            target_x = offset_x + x
            if 0 <= target_x < len(canvas_row):
                canvas_row[target_x] = (float(px[0]), float(px[1]), float(px[2]))


def frame_screenshot(source, destination):
    """Scales `source` to fit SCREENSHOT_CANVAS and centres it on the brand gradient."""
    import subprocess
    import tempfile

    width, height = SCREENSHOT_CANVAS
    with tempfile.TemporaryDirectory() as tmp:
        resized = Path(tmp) / 'resized.png'
        subprocess.run(
            ['sips', '--resampleHeight', str(height), str(source), '--out', str(resized)],
            check=True, capture_output=True,
        )
        w, h, _ct, rows = _read_png(resized)

    canvas = diagonal_gradient(width, height)
    _paste(canvas, rows, (width - w) // 2, max(0, (height - h) // 2))
    write_png(destination, to_rows(canvas), with_alpha=False)
    return w, h


def _read_png(path):
    """Minimal PNG reader — same reasoning as the writer: no imaging library here.

    Only what `sips` emits is supported (8-bit, non-interlaced) because that is all this
    pipeline ever reads.
    """
    import struct as _struct
    import zlib as _zlib

    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'{path} is not a PNG')
    pos, idat = 8, bytearray()
    width = height = colour_type = None
    while pos < len(data):
        (length,) = _struct.unpack('>I', data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b'IHDR':
            width, height, bit_depth, colour_type, _c, _f, interlace = _struct.unpack('>IIBBBBB', body)
            if bit_depth != 8 or interlace != 0:
                raise ValueError('only 8-bit non-interlaced PNGs are supported')
        elif tag == b'IDAT':
            idat += body
        elif tag == b'IEND':
            break

    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colour_type]
    raw = _zlib.decompress(bytes(idat))
    stride = width * channels
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(height):
        filt = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if filt == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filt == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filt == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif filt == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif filt != 0:
            raise ValueError(f'unknown PNG filter {filt}')
        row = []
        for x in range(width):
            base = x * channels
            if channels == 1:
                v = line[base]; row.append((v, v, v, 255))
            elif channels == 3:
                row.append((line[base], line[base + 1], line[base + 2], 255))
            elif channels == 2:
                v, a = line[base], line[base + 1]; row.append((v, v, v, a))
            else:
                row.append((line[base], line[base + 1], line[base + 2], line[base + 3]))
        rows.append(row); prev = line
    return width, height, colour_type, rows


def frame_all_screenshots():
    """Frames every capture in `store-assets/screenshots/` in place.

    Idempotent only in the sense that re-running re-frames the already-framed file, which
    would shrink it again — so the raw captures are kept in `screenshots/raw/` and the
    framed output is what a listing uses.
    """
    raw_dir = OUT / 'screenshots' / 'raw'
    out_dir = OUT / 'screenshots'
    if not raw_dir.exists():
        print(f'no {raw_dir.name}/ directory; nothing to frame', file=sys.stderr)
        return 0
    framed = 0
    for source in sorted(raw_dir.glob('*.png')):
        destination = out_dir / source.name
        w, h = frame_screenshot(source, destination)

        # Asserted rather than eyeballed. The canvas is constructed to be exactly 2:1, so
        # this only fires if someone changes SCREENSHOT_CANVAS — which is precisely when
        # it matters, because Play rejects anything over 2:1 and the images look fine.
        canvas_w, canvas_h = SCREENSHOT_CANVAS
        ratio = max(canvas_w, canvas_h) / min(canvas_w, canvas_h)
        if ratio > 2.0:
            raise SystemExit(
                f'{destination.name}: aspect {ratio:.3f}:1 exceeds the 2:1 the stores accept'
            )
        for side in SCREENSHOT_CANVAS:
            if not 320 <= side <= 3840:
                raise SystemExit(f'{destination.name}: {side}px is outside the 320-3840 range')

        print(f'framed {source.name} ({w}x{h} on {canvas_w}x{canvas_h}, {ratio:.3f}:1)')
        framed += 1
    return framed


def main():
    ios_master = OUT.parent / 'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png'
    feature_graphic()
    print('wrote play-feature-graphic-1024x500.png')

    if ios_master.exists():
        play_icon(ios_master)
        print('wrote play-icon-512.png')
    else:
        print(f'SKIPPED play icon: {ios_master} not found', file=sys.stderr)
        return 1

    frame_all_screenshots()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
