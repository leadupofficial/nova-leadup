#!/usr/bin/env python3
"""Build a sherpa-onnx KWS keywords file for an arbitrary phrase.

sherpa-onnx's keyword-spotting models are tiny zipformer transducers whose modelling
units are BPE pieces. A wake word is therefore *data*, not a trained artefact: you
tokenise the phrase with the model's own `bpe.model` and write the pieces, space
separated, into a keywords file. No training, no account, no per-keyword licence.

Every produced piece is validated against the model's `tokens.txt`, so a phrase that the
vocabulary cannot represent fails loudly instead of silently never firing.

Usage:
    python3 build_keyword.py --model-dir /path/to/sherpa-onnx-kws-... \\
        --phrase "HEY NOVA" --boost 2.0 --output keywords_hey_nova.txt

Why uppercase: the GigaSpeech KWS model was trained on uppercased text, so
"hey nova" tokenises to ▁ hey ▁ nova (pieces that do not exist) while "HEY NOVA"
tokenises to ▁HE Y ▁NO V A (all present).

Requires: sentencepiece  (`pip install sentencepiece`)
"""
import argparse
import pathlib
import sys

try:
    import sentencepiece as spm
except ImportError:
    print("Missing dependency: pip install sentencepiece", file=sys.stderr)
    sys.exit(2)


def load_vocabulary(tokens_path):
    vocabulary = set()
    for line in tokens_path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if parts:
            vocabulary.add(parts[0])
    if not vocabulary:
        raise SystemExit(f"No tokens parsed from {tokens_path}")
    return vocabulary


def tokenize(model_dir, phrase):
    bpe_model = model_dir / "bpe.model"
    if not bpe_model.exists():
        raise SystemExit(f"Not found: {bpe_model}")
    processor = spm.SentencePieceProcessor()
    processor.load(str(bpe_model))
    return processor.encode(phrase, out_type=str)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-dir", required=True, type=pathlib.Path)
    parser.add_argument("--phrase", required=True, help='e.g. "HEY NOVA"')
    parser.add_argument(
        "--boost",
        type=float,
        default=2.0,
        help="Per-keyword score boost (sherpa `:N` suffix). Default 2.0. Values of 3.0+ "
        "were measured to *reduce* recall, so only raise this with measurements.",
    )
    parser.add_argument("--output", type=pathlib.Path, help="Write the keywords file here")
    args = parser.parse_args()

    vocabulary = load_vocabulary(args.model_dir / "tokens.txt")
    pieces = tokenize(args.model_dir, args.phrase)

    unknown = [p for p in pieces if p not in vocabulary]
    if unknown:
        print(
            f"FAIL: phrase {args.phrase!r} produced pieces absent from tokens.txt: {unknown}\n"
            "Try the phrase in a different case, or pick a phrase the model can represent.",
            file=sys.stderr,
        )
        return 1

    line = " ".join(pieces)
    if args.boost and args.boost > 0:
        line += f" :{args.boost}"

    print(f"phrase   : {args.phrase!r}")
    print(f"pieces   : {' '.join(pieces)}")
    print(f"keywords : {line}")

    if args.output:
        args.output.write_text(line + "\n", encoding="utf-8")
        print(f"wrote    : {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
