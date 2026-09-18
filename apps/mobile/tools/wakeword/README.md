# Custom "HEY NOVA" wake word — no training required

This directory contains the tooling that produces a **real, custom `HEY NOVA` wake
word** for NOVA, replacing the placeholder `hey_jarvis` model. There is no training
step, no Picovoice account, and no access key.

## How a custom wake word works here

sherpa-onnx's keyword-spotting models are ~3.3 M-parameter zipformer transducers whose
modelling units are BPE pieces. A wake word is therefore **data, not a trained
artefact**: you tokenise the phrase with the model's own `bpe.model` and write the
pieces into a keywords file. That file *is* the wake word.

```
HEY NOVA  ->  ▁HE Y ▁NO V A
```

Case matters: the GigaSpeech model was trained on uppercased text, so `hey nova`
tokenises to `▁ hey ▁ nova`, whose pieces do not exist in the vocabulary, while
`HEY NOVA` tokenises to pieces that all do. `build_keyword.py` validates every piece
against `tokens.txt` and fails loudly otherwise.

## Engine choice

| | openWakeWord (currently shipped) | sherpa-onnx KWS (this) |
| --- | --- | --- |
| Licence | Apache-2.0 | Apache-2.0 |
| Account / key | none | none |
| Custom wake word | **requires training** (synthetic-data pipeline) | **just a text file** |
| Android dependency | `xyz.rementia:openwakeword` on Maven Central | official AAR from GitHub releases (not on Maven Central) |
| Model assets | ~3.6 MB | ~5.9 MB (int8) |

Both are free and key-free. sherpa-onnx is the better fit for a *custom* wake word
because it needs no training; the cost is that its Android AAR is not published to
Maven Central, so it has to be vendored into `android/app/libs/`.

## Verified results

Measured with `verify_keyword.py` on macOS-synthesised speech, model
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, keyword
`▁HE Y ▁NO V A :2.0`, `threshold=0.25`:

```
5 / 7 distinct speakers detected
0 / 7 false positives
```

| | |
| --- | --- |
| Detected | Samantha, Daniel, Karen, Moira, Tessa |
| Missed | Fred (a novelty robotic voice), and the "Alex"/"Rishi" fallback voice |
| Stayed silent | "hello world", "hey jarvis", "hey siri", "nova", "nova nova", "hey nora", "ok nova", "what is the weather today" |

Important caveats, stated plainly:

- **This is synthetic speech, not human speech.** Real-world recall must be measured on
  a device with a microphone, then tuned via `keywords_threshold` (lower = more
  sensitive, more false accepts).
- **`say` is an unreliable speaker simulator.** Two of the voices it reported installed
  ("Alex", "Rishi") produced byte-identical audio, meaning macOS silently substituted a
  fallback voice. `verify_keyword.py` detects and drops these instead of counting them
  as separate speakers. Detection itself is deterministic: repeated runs on the same
  audio file give identical results.
- **The `:N` boost had no measurable effect** in testing (identical results at 1.0, 2.0
  and 3.0). Do not raise it expecting better recall; it was measured at 3.0 to *reduce*
  recall. Tune `threshold` instead.
- "hey nora" staying silent is a good sign, since it is the nearest confusable phrase.

## Usage

```bash
# 1. Get the model (16.8 MB, Apache-2.0)
curl -L -o /tmp/kws.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2
tar xjf /tmp/kws.tar.bz2 -C /tmp

# 2. Build the keyword (needs: pip install sentencepiece)
python3 build_keyword.py \
  --model-dir /tmp/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 \
  --phrase "HEY NOVA" --boost 2.0 --output keywords_hey_nova.txt

# 3. Prove it fires (needs: pip install sherpa-onnx numpy sentencepiece, and macOS `say`)
python3 verify_keyword.py \
  --model-dir /tmp/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 \
  --phrase "HEY NOVA"

# Or sweep threshold/boost combinations to choose a threshold from measurements
python3 verify_keyword.py --model-dir <model> --phrase "HEY NOVA" --sweep
```

`keywords_hey_nova.txt` in this directory is the verified output of step 2.

## Wiring it into the Android app

Not yet done — it is an engine swap, and it should be validated on a device with a real
microphone before replacing the working `hey_jarvis` path.

1. Vendor the official AAR (there is no Maven Central coordinate):

   ```bash
   curl -L -o /tmp/sherpa-android.tar.bz2 \
     https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-android.tar.bz2
   tar xjf /tmp/sherpa-android.tar.bz2 -C /tmp
   mkdir -p apps/mobile/android/app/libs
   cp /tmp/sherpa-onnx-v1.13.8-android/jniLibs/arm64-v8a/*.so apps/mobile/android/app/libs/  # see archive layout
   cp /tmp/*/sherpa-onnx.aar apps/mobile/android/app/libs/
   ```

2. `implementation(files("libs/sherpa-onnx.aar"))` in `android/app/build.gradle.kts`.

3. Copy `encoder-*.int8.onnx`, `decoder-*.onnx`, `joiner-*.int8.onnx`, `tokens.txt` into
   `android/app/src/main/assets/wakeword/kws/` and add `keywords_hey_nova.txt`.

4. In `WakeWordService.kt`, replace the openWakeWord `WakeWordEngine` with
   `com.k2fsa.sherpa.onnx.KeywordSpotter` (or `OnlineKeywordSpotter` for streaming),
   feeding it the same 16 kHz mono stream the service already captures, and keep the
   existing `EventChannel` contract so nothing above the service changes.

The service's Flutter-facing contract (`nova/wake_word` method/event channels) is
engine-agnostic, so the Dart side needs no changes.
