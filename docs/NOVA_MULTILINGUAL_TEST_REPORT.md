# NOVA — Multilingual Test Report

**Date:** 2026-09-23
**Device:** OnePlus 9R (`LE2101`), Android 14 (SDK 34), `Asia/Kolkata`
**Backends tested:** `services/api` locally over `adb reverse`, and production
`nova-api` on `91.107.202.66`
**Voice providers in use:** Sarvam (STT + TTS for Indic), Deepgram (STT for `en`),
ElevenLabs (TTS fallback for `en`), Anthropic (reasoning)

**Verdict up front:** NOVA genuinely understands and answers in **seven** Indian
languages end to end with real audio — Tamil, Hindi, Telugu, Kannada, Bengali,
Tanglish and Hinglish — and creates the reminder in each, in the speaker's own
script. The other Indian languages in the catalogue are wired, routed and were
sampled through the live pipeline, but were **not** acoustically sampled with real
speech; five of them (`ur`, `ne`, `ks`, `bho`, `awa`) answer in the right language
and speak the answer with an **English** voice, which is why they are marked
PARTIAL rather than supported. Nothing here is claimed as verified that was not
actually run.

---

## 1. How the evidence was produced

| Tier | What it means | Method |
|---|---|---|
| **A** | Real speech in, real speech out | macOS `say` renders a natural sentence in an Indian voice → played into the physical phone's microphone → NOVA's real STT, reasoning and TTS → the reply audio and the database row are inspected |
| **B** | Live pipeline, text-in | The real HTTP voice pipeline with a real sentence in the language; reply script and provider audio inspected. No microphone in the loop |
| **C** | Live pipeline, degraded voice | As B, but the TTS layer returns an English voice for a non-English reply |
| — | Not run | No evidence. Listed so the gap is visible rather than implied |

Audio used for tier A was generated with the macOS Indian voices
(Vani/`ta`, Lekha/`hi`, Geeta/`te`, Soumya/`kn`, Piya/`bn`) via
`/tmp/nova-val/audio/*.wav`, 16 kHz mono.

## 2. The matrix

Every row is a genuine run. `—` in a column means that column was not exercised
for that language, not that it passed.

| Language | STT | AI understanding | Response language | TTS voice | Task | Reminder | Context | Tier | Result |
|---|---|---|---|---|---|---|---|---|---|
| Tamil `ta` | correct transcript from real audio | correct | Tamil script | Sarvam, Tamil | — | created, own script | **verified** ("that" referring to the prior turn) | **A** | **PASS** |
| Hindi `hi` | correct transcript from real audio | correct | Devanagari | Sarvam, Hindi | — | created, own script | — | **A** | **PASS** |
| Telugu `te` | correct transcript from real audio | correct | Telugu script | Sarvam, Telugu | — | created, own script, `triggerAt` correct | — | **A** | **PASS** |
| Kannada `kn` | correct transcript from real audio | correct | Kannada script | Sarvam, Kannada | — | created, own script | — | **A** | **PASS** |
| Bengali `bn` | correct transcript from real audio | correct | Bengali script | Sarvam, Bengali | — | created, own script | — | **A** | **PASS** |
| Tanglish `tanglish` | correct transcript from real audio | correct | Tamil + Latin mix | Sarvam | — | created | — | **A** | **PASS** |
| Hinglish `hinglish` | correct transcript from real audio | correct | Hindi + Latin mix | Sarvam | — | created | — | **A** | **PASS** |
| Malayalam `ml` | — | correct | Malayalam script | Sarvam | — | — | — | **B** | **PARTIAL** |
| Marathi `mr` | — | correct | Devanagari | Sarvam | — | — | — | **B** | **PARTIAL** |
| Gujarati `gu` | — | correct | Gujarati script | Sarvam | — | — | — | **B** | **PARTIAL** |
| Punjabi `pa` | — | correct | Gurmukhi | Sarvam | — | — | — | **B** | **PARTIAL** |
| Odia `or` | — | correct | Odia script | Sarvam | — | — | — | **B** | **PARTIAL** |
| Assamese `as` | — | correct | Assamese script | provider audio | — | — | — | **B** | **PARTIAL** |
| Maithili `mai` | — | correct | Devanagari | provider audio | — | — | — | **B** | **PARTIAL** |
| Sanskrit `sa` | — | correct | Devanagari | provider audio | — | — | — | **B** | **PARTIAL** |
| Sindhi `sd` | — | correct | Arabic script | provider audio | — | — | — | **B** | **PARTIAL** |
| Dogri `doi` | — | correct | Devanagari | provider audio | — | — | — | **B** | **PARTIAL** |
| Manipuri `mni` | — | correct | Bengali script | provider audio | — | — | — | **B** | **PARTIAL** |
| Benglish `benglish` | — | correct | Bengali + Latin | provider audio | — | — | — | **B** | **PARTIAL** |
| Gujlish `gujlish` | — | correct | Gujarati + Latin | provider audio | — | — | — | **B** | **PARTIAL** |
| Urdu `ur` | — | correct | Urdu script | **English voice** | — | — | — | **C** | **FAIL (voice)** |
| Nepali `ne` | — | correct | Devanagari | **English voice** | — | — | — | **C** | **FAIL (voice)** |
| Kashmiri `ks` | — | correct | Devanagari | **English voice** | — | — | — | **C** | **FAIL (voice)** |
| Bhojpuri `bho` | — | correct | Devanagari | **English voice** | — | — | — | **C** | **FAIL (voice)** |
| Awadhi `awa` | — | correct | Devanagari | **English voice** | — | — | — | **C** | **FAIL (voice)** |
| English `en` | correct | correct | English | ElevenLabs | — | created | — | **A** | **PASS** |

## 3. Same-language response validation

The mandate requires the reply language to be compared with the input language.
The rule applied: a non-English input must produce a reply whose dominant script
is the input's script, unless the user asked to switch.

| Input language | Detected | Expected reply | Actual reply | Same language? |
|---|---|---|---|---|
| Tamil (spoken) | `ta` | Tamil | Tamil script | **yes** |
| Hindi (spoken) | `hi` | Hindi | Devanagari | **yes** |
| Telugu (spoken) | `te` | Telugu | Telugu script | **yes** |
| Kannada (spoken) | `kn` | Kannada | Kannada script | **yes** |
| Bengali (spoken) | `bn` | Bengali | Bengali script | **yes** |
| Tanglish (spoken) | `tanglish` | Tamil + English mix | Tamil script with Latin words | **yes** |
| Hinglish (spoken) | `hinglish` | Hindi + English mix | Devanagari with Latin words | **yes** |
| Telugu (text, live pipeline, 2026-09-23) | `te` | Telugu | Telugu script — 60 Telugu characters, **0** Latin |

No case was found where NOVA understood one Indian language and answered in
another. The failures found were of two other kinds: the **action** not happening
and the **voice** being the wrong language (§5).

## 4. Telugu end-to-end run — the full record

Run on 2026-09-23 through the live pipeline against a freshly started API, using
the real providers and real credits.

Input (natural Telugu, not a textbook phrase):

> రేపు ఉదయం తొమ్మిది గంటలకు నా క్లయింట్‌కి కాల్ చేయమని గుర్తు చేయి
> *("Remind me tomorrow morning at nine to call my client.")*

| Step | Observation |
|---|---|
| `POST /voice/chat {language:'te'}` | `200` in **4.6 s** |
| Reply | `రేపు ఉదయం తొమ్మిది గంటలకు క్లయింట్‌కి కాల్ చేయమని రిమైండర్ సెట్ చేసాను.` |
| Reply script | 60 Telugu characters, 0 Latin |
| Reminders before | **0** |
| Reminders after | **1** |
| Row created | title `క్లయింట్‌కి కాల్ చేయి` |
| Extracted instant | `triggerAt 2026-09-24T03:30:00.000Z` = **09:00 Asia/Kolkata, the next day** |
| Timezone | `Asia/Kolkata` |
| `POST /voice/tts {language:'te'}` | `200`, **291,250 bytes** of real audio, saved to `/tmp/nova-val/te_reply.mp3` |

Date **and** time extraction were both correct in Telugu — "tomorrow" resolved to
the next calendar day and "nine in the morning" to 09:00 local. The reminder row
is the proof that the action happened; the Telugu sentence alone would not have
been.

## 5. Failures, and what they actually were

### 5.1 Fixed during this work

| Failure | Root cause | Status |
|---|---|---|
| Hindi, Telugu, Kannada and Bengali reminder turns failed the tool 2–3× and hit the iteration cap; Telugu answered in English with *"That didn't work. The reminder was not created."* | `stated-time.ts` recognised clock times only in digits, English and Tamil wording, so a stated hour read as *invented* and the guard blocked the tool | **FIXED** — o'clock markers and parts of day added for 11 Indian languages plus Latin transliterations |
| Hinglish *"Kal subah aath baje ka reminder laga do yaar"* transcribed as **"Reminder lag"** | `getSttProviderForLanguage` special-cased only `tanglish`; other mixed codes fell to Deepgram, which is English-only | **FIXED** — every mixed code routes to Sarvam |
| *"ரிமைண்டர் வெச்சுடுச்சு"* ("the reminder is set") reached the user with `tools: []` and no row | `claimsStateChange` missed the Tamil completive `-ச்சுடுச்சு / -ட்டு / -ஞ்சு` stems, so a false completion claim passed the honesty guard | **FIXED** — stems added in Tamil and Latin; present-tense descriptions still correctly ignored |
| A language chosen on the server was never sent on the wire | The client allowlist `kVoiceProtocolLanguages = {en, ta, hi, auto}` rewrote every other code to `auto` | **FIXED** — derived from the catalogue; all 27 options survive normalisation, asserted by test |
| Only four languages were selectable at all | Four hardcoded chips in two files, and a four-value `languagePolicy` enum duplicated in `routes/settings.ts` and `schemas/index.ts` | **FIXED** — one shared catalogue-derived schema, one shared options list |

### 5.2 Open

| Failure | Detail | Severity | Status |
|---|---|---|---|
| Wrong voice for five languages | `ur`, `ne`, `ks`, `bho`, `awa` produce a correct in-script reply that is then spoken by an **English** voice (`elevenlabs-fallback`) | **P1** | OPEN — needs an Indic voice for these codes, or the picker must mark them partial. The catalogue currently **claims** `ur`/`ne`/`bho`/`awa` are Sarvam-routed, so the mapping and the observed behaviour disagree and must be reconciled |
| Reliability of the `askedUserBack` path | In the production multilingual run, 5 of 7 languages created the reminder and 2 (Bengali, Tanglish) asked a clarifying question instead. Same input, different outcome across runs | **P2** | OPEN — model non-determinism, not a language gap |

## 6. What was NOT tested

- **Real speech for the tier-B and tier-C languages.** They were driven through
  the live pipeline as text. No microphone was involved, so their STT accuracy is
  unknown. They must not be described as verified.
- **Tasks, context and proactive behaviour per language.** Reminders were tested
  across the tier-A languages; the task lifecycle and context references were
  verified in Tamil only.
- **Proactive delivery in any language.** The transport does not exist yet — 82
  `follow_up` rows, 0 read, no delivery column. A language cannot be credited with
  proactive behaviour when no language has it.
- **Latency across languages.** Only Telugu was timed (4.6 s for the turn). One
  sample is not a latency measurement.
- **The MacBook acoustic loop.** The capture rig was proven, but the last
  physical loop attempt failed and has not been retried; the tier-A runs used
  macOS-synthesised speech played into the phone's microphone, which is a
  generated human voice rather than a person speaking.

## 7. Evidence index

| Artefact | Path |
|---|---|
| Real speech samples, 16 kHz mono | `/tmp/nova-val/audio/*.wav` |
| Language matrix driver | `/tmp/nova-val/lang_matrix.py` |
| Single-language probe | `/tmp/nova-val/lang_probe.py` |
| Reminder outcome probe | `/tmp/nova-val/reminder_probe.py` |
| Telugu end-to-end run (this round) | `/tmp/nova-val/te_pipeline.py` |
| Telugu reply audio, 291 KB | `/tmp/nova-val/te_reply.mp3` |
| Widen picker, on device | `/tmp/nova-val/lang_sheet.png` |
| Language setting persisted | `/tmp/nova-val/lang_e2e.py` |
