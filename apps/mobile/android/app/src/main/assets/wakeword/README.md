# Wake word models

NOVA performs wake-word detection entirely on device using
[openWakeWord](https://github.com/dscripka/openWakeWord), which is Apache-2.0
licensed. There is **no access key, no account, and no per-device licence**, in
contrast to Picovoice Porcupine. Inference runs locally through ONNX Runtime.

## Files

| File | Purpose | Source |
| --- | --- | --- |
| `../melspectrogram.onnx` | Shared audio front-end (mel spectrogram) | openWakeWord `v0.5.1` |
| `../embedding_model.onnx` | Shared audio front-end (speech embeddings) | openWakeWord `v0.5.1` |
| `hey_jarvis_v0.1.onnx` | Wake-word classifier | openWakeWord `v0.5.1` |
| `models.json` | Registry of installed classifiers | this repo |

The two front-end models **must stay at the root of `assets/`**: the
`xyz.rementia:openwakeword` runtime resolves those two filenames relative to the
assets root. Only the classifiers live in this subdirectory.

Checksums (SHA-256) of the bundled files:

```
ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f  melspectrogram.onnx
70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f  embedding_model.onnx
94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb  hey_jarvis_v0.1.onnx
```

## Why `hey_jarvis` and not "hey nova"

openWakeWord ships a fixed set of **pretrained** classifiers: `alexa`,
`hey_jarvis`, `hey_mycroft`, `hey_rhasspy`, `timer`, and `weather`. There is no
pretrained "NOVA" or "hey nova" model. `hey_jarvis` is bundled so the feature
works out of the box.

To use a genuinely custom wake word you have three options. A solution for a real
**"hey nova"** has been built and verified that needs **no training, no account and no
access key** — see
[`apps/mobile/tools/wakeword/README.md`](../../../../../tools/wakeword/README.md).

1. **sherpa-onnx KWS (verified, no training).** The English KWS model takes the wake
   word as a BPE-tokenised text file (`HEY NOVA` -> `▁HE Y ▁NO V A`), measured at 5/7
   distinct synthesised speakers with 0/7 false positives on confusable phrases. It
   needs an engine swap on Android because its AAR is not on Maven Central, which is
   why `hey_jarvis` is still the shipped default.
2. **Train an openWakeWord classifier** (free, no account) with the official
   synthetic-data notebook, then drop the `.onnx` in this directory and point
   `models.json` at it. Keeps the current engine.
3. **Use Picovoice Porcupine**, which offers a custom keyword on its free tier but
   requires an account and an access key to be approved.

## Adding or replacing a wake word

1. Drop the `.onnx` classifier into this directory.
2. Add an entry to `models.json`:

   ```json
   { "name": "hey_nova", "asset": "wakeword/hey_nova_v0.1.onnx", "threshold": 0.5 }
   ```

3. Rebuild. `WakeWordService.availability()` reports the installed names to Dart,
   so the UI reflects the change with no code edits.

`threshold` is the openWakeWord detection score (0.0–1.0) above which a detection
fires. Raising it reduces false activations; lowering it makes detection more
sensitive. 0.5 is the upstream default.

## What adding a second classifier changes in the app

Nothing needs editing, but two behaviours follow from the manifest:

* **The picker appears.** With **one** entry installed — today's build — the wake
  word screen (`Me → Wake word`, route `/me/wake-word`) says *"Only one wake word
  is installed"* and shows no picker, because a one-option list would be a control
  that does nothing. As soon as a **second** entry is installed,
  `WakeWordAvailability.models` has more than one name and the same screen renders
  a real single-choice list.
* **The service listens for the selected classifier only.** `WakeWordService`
  filters `models.json` down to
  `WakeWordModelSelection.resolve(stored, installed)` and hands that one model to
  the engine, so a build with several classifiers fires on the phrase the user
  picked rather than on all of them. The choice is persisted by the native
  `selectModel` method under `flutter.nova_wake_word_model` in
  `FlutterSharedPreferences` (the same store `BootReceiver` reads), and a stored
  name whose asset is gone falls back to the first installed classifier instead of
  silencing the microphone.

The account-level record at `PATCH /api/v1/device/wake-word/config` (§13.10, see
`services/api/src/routes/device.ts`) is **a preference record, not a control**:
the server stores which phrase the client reported choosing, validated against the
phrases that client reported as installed. It cannot change what any microphone
listens for — only the assets in this directory can do that.

## Refreshing the models

```bash
BASE=https://github.com/dscripka/openWakeWord/releases/download/v0.5.1
cd apps/mobile/android/app/src/main/assets
curl -L -o melspectrogram.onnx   "$BASE/melspectrogram.onnx"
curl -L -o embedding_model.onnx  "$BASE/embedding_model.onnx"
curl -L -o wakeword/hey_jarvis_v0.1.onnx "$BASE/hey_jarvis_v0.1.onnx"
```
