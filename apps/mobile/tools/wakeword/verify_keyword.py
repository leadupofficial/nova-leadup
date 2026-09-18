#!/usr/bin/env python3
"""Verify a sherpa-onnx KWS keyword actually fires, and tune its threshold.

Builds speech with the macOS `say` synthesiser, runs the real keyword spotter from
`pip install sherpa-onnx`, and reports detection per voice plus false positives on
near-miss phrases.

This exists because a wake word is not "done" when the model loads — it is done when it
fires on the phrase and stays quiet on everything else, with a threshold you chose from
measurements rather than guessed.

Usage:
    python3 verify_keyword.py --model-dir /path/to/model --phrase "HEY NOVA"
    python3 verify_keyword.py --model-dir /path/to/model --phrase "HEY NOVA" --sweep

Requires: sherpa-onnx, numpy, sentencepiece, and macOS `say`.
"""
import argparse
import hashlib
import pathlib
import subprocess
import sys
import wave

try:
    import numpy as np
    import sherpa_onnx
except ImportError as exc:
    print(f"Missing dependency ({exc}). Install with: pip install sherpa-onnx numpy sentencepiece", file=sys.stderr)
    sys.exit(2)

DEFAULT_VOICES = ["Samantha", "Alex", "Daniel", "Karen", "Moira", "Tessa", "Rishi", "Fred"]
DEFAULT_NEGATIVES = [
    "hello world",
    "hey jarvis",
    "hey siri",
    "what is the weather today",
    "nova",
    "hey nora",
    "ok nova",
]


def synth(text, voice, path, work_dir):
    """Renders text to 16 kHz mono 16-bit PCM WAV. Cached on disk."""
    if path.exists():
        return True
    result = subprocess.run(
        ["say", "-v", voice, "-o", str(path), "--data-format=LEI16@16000", text],
        capture_output=True,
    )
    return result.returncode == 0 and path.exists()


def read_wav(path):
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise SystemExit(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        raise SystemExit(f"{path}: expected 16 kHz, got {rate}")
    return samples


def make_spotter(model_dir, keywords_file, threshold, score):
    return sherpa_onnx.KeywordSpotter(
        tokens=str(model_dir / "tokens.txt"),
        encoder=str(model_dir / "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        decoder=str(model_dir / "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
        joiner=str(model_dir / "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        keywords_file=str(keywords_file),
        num_threads=2,
        keywords_score=score,
        keywords_threshold=threshold,
        provider="cpu",
    )


def detect(spotter, samples):
    stream = spotter.create_stream()
    stream.accept_waveform(16000, samples)
    # Trailing silence flushes the final tokens through the decoder.
    stream.accept_waveform(16000, np.zeros(int(0.5 * 16000), dtype=np.float32))
    stream.input_finished()

    hit = None
    while spotter.is_ready(stream):
        spotter.decode_stream(stream)
        result = spotter.get_result(stream)
        if result:
            hit = result
            spotter.reset_stream(stream)
    return hit


def render_corpus(work_dir, voices, negatives):
    """Renders the positive/negative corpus, dropping voices that are not really
    installed.

    macOS `say` silently substitutes a fallback voice when a requested voice is not
    downloaded, and two "different" voices then produce byte-identical audio. Counting
    those as separate speakers inflates the score and makes results jump between runs
    (the fallback's output is not stable). Identical audio is therefore collapsed and
    reported.
    """
    clips = {}
    seen_hashes = {}
    dropped = []

    for voice in voices:
        path = work_dir / f"pos_{voice}.wav"
        if not synth("hey nova", voice, path, work_dir):
            dropped.append((voice, "synthesis failed"))
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest in seen_hashes:
            dropped.append((voice, f"identical audio to {seen_hashes[digest]}"))
            continue
        seen_hashes[digest] = voice
        clips[("pos", voice)] = read_wav(path)

    if dropped:
        print("Dropped voices (not usable as independent speakers):")
        for voice, reason in dropped:
            print(f"  - {voice}: {reason}")
        print()

    for phrase in negatives:
        path = work_dir / f"neg_{phrase.replace(' ', '_')}.wav"
        if synth(phrase, "Samantha", path, work_dir):
            clips[("neg", phrase)] = read_wav(path)
    return clips


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-dir", required=True, type=pathlib.Path)
    parser.add_argument("--phrase", default="HEY NOVA")
    parser.add_argument("--boost", type=float, default=2.0)
    parser.add_argument("--threshold", type=float, default=0.25)
    parser.add_argument("--score", type=float, default=1.0)
    parser.add_argument("--work-dir", type=pathlib.Path, default=pathlib.Path("/tmp/kws-verify"))
    parser.add_argument("--sweep", action="store_true", help="Sweep threshold/boost combinations")
    args = parser.parse_args()

    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    from build_keyword import load_vocabulary, tokenize  # noqa: E402

    args.work_dir.mkdir(parents=True, exist_ok=True)
    vocabulary = load_vocabulary(args.model_dir / "tokens.txt")
    pieces = tokenize(args.model_dir, args.phrase)
    unknown = [p for p in pieces if p not in vocabulary]
    if unknown:
        print(f"FAIL: {args.phrase!r} uses pieces absent from the model: {unknown}", file=sys.stderr)
        return 1

    base = " ".join(pieces)
    print(f"phrase {args.phrase!r} -> {base}\n")
    clips = render_corpus(args.work_dir, DEFAULT_VOICES, DEFAULT_NEGATIVES)

    keywords_file = args.work_dir / "keywords.txt"

    def evaluate(boost, threshold, score):
        line = base + (f" :{boost}" if boost else "")
        keywords_file.write_text(line + "\n", encoding="utf-8")
        spotter = make_spotter(args.model_dir, keywords_file, threshold, score)
        caught, missed, false_positives = [], [], []
        for (kind, name) in clips:
            hit = detect(spotter, clips[(kind, name)])
            if kind == "pos":
                (caught if hit else missed).append(name)
            elif hit:
                false_positives.append(name)
        return caught, missed, false_positives

    if not args.sweep:
        caught, missed, false_positives = evaluate(args.boost, args.threshold, args.score)
        for voice in sorted(v for k, v in clips if k == "pos"):
            print(f"  {'DETECTED' if voice in caught else 'MISSED  '}  {voice}")
        print()
        for phrase in sorted(p for k, p in clips if k == "neg"):
            print(f"  {'FALSE+' if phrase in false_positives else 'silent'}   {phrase!r}")
        print(f"\ncaught {len(caught)}/{len(caught) + len(missed)}, false positives {len(false_positives)}")
        return 0 if not false_positives else 1

    print(f"{'boost':>6} {'thr':>6} {'score':>6} {'caught':>7} {'missed':>7} {'false+':>7}")
    best = None
    for boost in [1.0, 2.0, 3.0]:
        for threshold in [0.25, 0.15, 0.10, 0.05, 0.02]:
            for score in [1.0, 2.0, 3.0]:
                caught, missed, false_positives = evaluate(boost, threshold, score)
                print(
                    f"{boost:6.1f} {threshold:6.2f} {score:6.1f} "
                    f"{len(caught):7d} {len(missed):7d} {len(false_positives):7d}"
                )
                if not missed and not false_positives and best is None:
                    best = (boost, threshold, score)

    print()
    if best:
        print(f"BEST: boost={best[0]} threshold={best[1]} score={best[2]}")
    else:
        print("No configuration caught every voice without a false positive; pick the "
              "highest-recall configuration with zero false positives.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
