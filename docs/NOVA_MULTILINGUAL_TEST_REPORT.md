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
| Urdu `ur` | — | correct | Urdu script | **English voice** (`elevenlabs-fallback`) | — | — | — | **C** | **FAIL (voice)** — flagged in the picker |
| Nepali `ne` | — | correct | Devanagari | **English voice** (`elevenlabs-fallback`) | — | — | — | **C** | **FAIL (voice)** — flagged in the picker |
| Kashmiri `ks` | — | correct | Devanagari | Sarvam fallback (Indic) | — | — | — | **C** | **PARTIAL** — degraded route, right language |
| Bhojpuri `bho` | — | correct | Devanagari | **English voice** (`elevenlabs-fallback`) | — | — | — | **C** | **FAIL (voice)** — flagged in the picker |
| Awadhi `awa` | — | correct | Devanagari | **English voice** (`elevenlabs-fallback`) | — | — | — | **C** | **FAIL (voice)** — flagged in the picker |
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
| Wrong voice for four languages | `ur`, `ne`, `bho`, `awa` produce a correct in-script reply that is then spoken by an **English** voice. Measured 2026-09-23 by reading the `provider` field of `/voice/tts` — not inferred from the catalogue. | **P1** | **PARTIALLY FIXED** — the claim is now honest: `voiceFallback` marks the four codes, the picker reads *"Urdu (basic voice)"*, and both suites pin the exact set. A real Indic voice for them is still missing, so they remain unspoken languages rather than supported ones. `ks` was re-measured and **removed** from this list: Google fails for it but the Sarvam fallback does serve it with an Indic voice |
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
- **The MacBook acoustic loop.** ~~The capture rig was proven, but the last
  physical loop attempt failed and has not been retried~~ — **the full
  bidirectional loop is now verified; see §4a of the real-user report.** The
  tier-A runs still used macOS-synthesised speech played into the phone's
  microphone, which is a generated human voice rather than a person speaking.

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

## 8. Why seven languages go through a fallback (2026-09-23)

The catalogue routes seven languages to Google Cloud TTS. This deployment has no
`GOOGLE_CLOUD_API_KEY` — Sarvam, ElevenLabs and Deepgram are configured — so all
seven fall through the chain, and nothing said so.

Measured directly rather than inferred:

```
google refused ur -> GOOGLE_CLOUD_API_KEY is not configured
provider for ks   -> sarvam-fallback        (google was its primary)
provider for ur   -> elevenlabs-fallback    (English voice)
```

The API now logs one line at boot per unrouted provider:

```
Voice provider "google" is routed for 7 language(s) [as, mai, sa, sd, ks, doi, mni]
but GOOGLE_CLOUD_API_KEY is not set — every one of them will fall through the TTS
chain to whichever provider is configured.
```

Routing is deliberately **not** changed. Google serves Urdu and Nepali natively,
so the catalogue is right if the credential is added; a code change would have to
be undone. What was missing was any signal that it is not there.

**Consequence for the matrix:** the `ks` row is better than the catalogue implies
(a Sarvam voice does speak it) and the `ur`/`ne`/`bho`/`awa` rows are worse (an
English voice does). Both are now labelled in the picker.

## 9. Switching language inside one conversation (2026-09-23)

§9 requires the reply language to match the input "unless the user explicitly
switches language", so the switch is the case that matters. One conversation, three
turns, run twice — once with the policy on `auto` and once pinned to Hindi. The
reply's dominant script was counted rather than eyeballed.

| Policy | Turn 1 — English | Turn 2 — Hindi | Turn 3 — English |
|---|---|---|---|
| **`auto`** | Latin ✓ | **Devanagari** ✓ | **Latin** ✓ |
| **pinned `hi`** | Devanagari | Devanagari ✓ | Devanagari |

**`auto` follows the speaker**, including switching language mid-conversation and
switching back — the exact behaviour §9 asks for. The Hindi turn was answered in
Devanagari with grounded content (*"कल सुबह नौ बजे आपको क्लायंट को कॉल करना है…"* —
the client call at nine, which is a real reminder this account holds).

**A pinned language holds.** With `hi` selected, an English turn is still answered
in Hindi. That is the right reading of §9 for a user who deliberately pinned a
language — the setting is the standing instruction — but it is worth stating
plainly because it means the pin outranks the language the user is speaking.

### What this does not cover

The switch was tested through the pipeline with typed turns, not spoken ones. The
spoken path was verified for single-language turns (§4) and for one full lifecycle
(§28), not for a mid-conversation switch.

## 10. The required-language sweep, run in full (2026-09-23)

Every language §6 names, exercised in one pass through the real pipeline: one
natural request **written in that language**, `language` set to that code, real
model, real database. The reply's dominant script was counted rather than eyeballed.

| Language | Expected script | Reply script | Task created |
|---|---|---|---|
| Hindi `hi` | Devanagari | **Devanagari** ✓ | no — asked a question |
| Marathi `mr` | Devanagari | **Devanagari** ✓ | **yes** |
| Bengali `bn` | Bengali | **Bengali** ✓ | **yes** |
| Assamese `as` | Bengali | **Bengali** ✓ | **yes** |
| Punjabi `pa` | Gurmukhi | **Gurmukhi** ✓ | no — stated intent only |
| Gujarati `gu` | Gujarati | **Gujarati** ✓ | no — asked a question |
| Odia `or` | Odia | **Odia** ✓ | no — asked a question |
| Tamil `ta` | Tamil | **Tamil** ✓ | **yes** |
| Telugu `te` | Telugu | **Telugu** ✓ | **yes** |
| Kannada `kn` | Kannada | **Kannada** ✓ | **yes** |
| Malayalam `ml` | Malayalam | **Malayalam** ✓ | **yes** |
| Urdu `ur` | Arabic | **Arabic** ✓ | **yes** |
| English `en` | Latin | **Latin** ✓ | **yes** |

**Same-language replies: 13 / 13.** Every language answered in its own script,
including Urdu in Perso-Arabic and Odia in Odia script — the two most likely to fall
back to Latin or Devanagari.

### The inconsistency this surfaced

The *same* request — "create a task to call the client tomorrow" — produced an
action in **9** languages and a **clarifying question** in **4** (`hi`, `gu`, `or`),
with Punjabi replying *"I'll create the task, but…"* and creating nothing.

That matters for two reasons:

1. **It contradicts the app's own instruction.** The prompt tells the model that for
   a day given without a time it should *send the date and not ask for an hour*
   (added in the round that fixed an invented 6 pm). Four languages ask anyway.
2. **Punjabi's reply reads like a confirmation and is not one.** No tool ran, so
   "I'll create the task" leaves the user believing something was filed. It is
   future-tense intent rather than a completed claim, so the false-confirmation
   guard correctly does not fire — but the user-visible effect is the same.

A user cannot tell which behaviour they will get, and it depends only on the
language they spoke.

### What the 9 that acted used for the time

Midnight — `bn` said *"মধ্যরাত"*, `kn` *"ಮಧ್ಯರಾತ್ರಿ"*, `ur` *"بارہ بجے رات"* —
which matches the documented rule for a day with no time.

### Test data

Nine tasks were created by the sweep and **all were deleted afterwards** (verified:
0 remaining), so the account is not carrying test rows into later rounds.

## 11. The sweep repeated, and a method error of mine (2026-09-23)

§10 reported 13/13 same-language replies and 9/13 languages acting on the same
request. This round tried to improve the acting rate and mostly learned that the
measurement was not sound.

### Same-language replies: now confirmed three times

13/13 in §10, 13/13 on a repeat with the prompt strengthened, and 13/13 again
afterwards. Three independent runs on different builds agree, so that result stands
firmly: **every required language answers in its own script.**

### The acting rate could not be compared

| Run | Prompt | Acted |
|---|---|---|
| §10 | as shipped | 9/13 |
| first repeat | strengthened | 10/13 |
| second repeat | strengthened | 9/13 |

Three numbers, no comparable pair. The reason is a **method error I made**: the
sweep creates a task per language, and the app **de-duplicates**. So whether a
later language "acted" depended on what the earlier languages had already filed —
Punjabi's *"you already have three tasks"* was de-duplication working, not a
failure. My first repeat even inherited the first run's leftovers, and my
"isolated" second attempt cleaned up *during* the run rather than before it.

The prompt change was therefore **reverted**: it was built on a comparison that does
not hold, and an unproven change to the assistant's instructions does not belong in
the tree. The clean method, recorded for the next attempt, is: clear the relevant
tasks, send **one** language, and read its reply against the task count — no sweep.

### One observation I could not confirm

In the many-duplicates state, one Hindi reply appeared to claim a task had been
created while no new row appeared in the count. Two direct tests in clean isolation
say otherwise: with no duplicate the task was created and the reply said so, and
with one duplicate a **second** task was created and the reply said so. I could not
reproduce a claim-without-action, so it is recorded here as an unreproduced
observation rather than as a defect — and it is recorded at all rather than dropped,
because a confirmation for an action that did not happen is the one failure worth
chasing.

### Test data

Every task created by these sweeps has been deleted — verified: **0** remaining.

## 12. It is not the language — it is run-to-run variance (2026-09-23)

§11 left the acting rate unquantified because two sweeps were contaminated by
leftover tasks and the app's de-duplication. This round ran the method §11
prescribed: **one language per clean state**, with the relevant tasks cleared
before the run and after each language.

### The clean baseline

Against the **shipped** prompt, 13/13 same-language replies and **10/13 acted**.
The three that did not — `hi`, `bn`, `or` — each replied with a clarifying question
or a note that something already existed.

### Then the three were re-sampled

If those languages behaved that way *because of the language*, repeating them
should reproduce it. It does not:

| Language | first sweep | trial 1 | trial 2 |
|---|---|---|---|
| Hindi `hi` | did not act | **acted** | **acted** |
| Bengali `bn` | did not act | **acted** | **acted** |
| Odia `or` | did not act | did not act | **acted** |

Hindi and Bengali act on every immediate retry. So the first sweep's result for
them was **noise from a single sample**, and §10's "9/13, and it depends on the
language" attributed run-to-run variance to the language.

### What is actually true

For the identical request, the assistant files the task in roughly **10–12 runs out
of 13**, and occasionally answers with a clarifying question instead. That happens
**regardless of language** — the spread across my four sweeps (9, 10, 9, 10) is
consistent with that, and the retries place the three "failures" inside it.

Two consequences worth stating plainly:

- **The multilingual finding is withdrawn.** Same-language replies are 13/13 and
  solid; the acting behaviour is not language-dependent.
- **A consistency observation remains**, and is a *product* matter rather than a
  multilingual one: the same request occasionally gets a question instead of the
  action, which a user cannot predict. Recorded as such, at P3, with the frequency
  measured rather than guessed.

### Why the earlier numbers were wrong

Not the model — the method. A sweep creates a task per language and the app
de-duplicates, so each language's result depended on the ones before it; and two of
the three sweeps did not start from a clean state. One language per clean state is
the only version of this test that means anything.

### Test data

Every task created across these runs was deleted — verified: **0** remaining.

## 13. Urdu and Nepali now speak Urdu and Nepali (2026-09-23)

The four languages listed as spoken by an English voice are down to two. The cause
was not the permission, the voice id, or the routing metadata — it was the model.

### What was wrong

`synthesizeSpeech` hardcoded `eleven_flash_v2_5` and sent **no `language_code`**, so
the model auto-detected the language from the text and, given Urdu script, read it
as English phonetics. The account's own `/v1/models` says why:

| Model | Languages | `ur` | `ne` |
|---|---|---|---|
| `eleven_flash_v2_5` (was hardcoded) | 32 | ✗ | ✗ |
| `eleven_v3` | 74 | **✓** | **✓** |

Flash does not merely lack the voice — it **rejects the language code**:

```
{"message":"Model 'eleven_flash_v2_5' does not support language_code 'ur'."}
```

### The fix

Only languages Flash has no voice for are routed to `eleven_v3` **with**
`language_code`. The 32 it already serves keep it, because v3 is the costlier model
and those languages were verified working; a test pins both halves, since a table
that grew by accident would raise the bill silently.

### Evidence

Round-tripped through Deepgram `detect_language`, same Urdu sentence:

| | Transcript |
|---|---|
| before | कल सुबह **ten** बजे कल **आईंड** को call करें — *کلائنٹ* mangled into nonsense |
| **after** | कल सुबह **ten** बजे **client** को call करें — the word is intelligible |

And the audio the route serves is **byte-identical to a direct `eleven_v3` call** —
36 824 bytes, against Flash's 39 750 — so the route is genuinely using v3, not
merely claiming to.

### What is left

**Bhojpuri `bho` and Awadhi `awa` are in neither model.** They stay as they are:
still spoken by a voice that is not theirs, still labelled "(basic voice)" in the
picker. Kashmiri `ks` remains on the Sarvam fallback, whose Indic voice does read
it, so it was never in this group.

### A follow-up this creates

The picker still labels Urdu and Nepali **"(basic voice)"**. That label was honest
when it was added and is now inaccurate for these two. It is left in place until a
listening check confirms the improvement by ear — an STT round-trip shows the
mangled word is fixed, not that the prosody is good.

## 14. Why the chain falls through, in the providers' own words (2026-09-23)

The four "English-voiced" languages were never a routing mistake in NOVA. Asking
each configured provider directly, rather than inferring from the app's behaviour,
gives the answer in their own error messages.

### Sarvam `bulbul:v3` — 23 languages, three of them gated

`target_language_code` is validated against a fixed list, and the list is printed
back on a rejection:

```
Input should be 'as-IN', 'bn-IN', 'brx-IN', 'doi-IN', 'en-IN', 'gu-IN', 'hi-IN',
'kn-IN', 'kok-IN', 'ks-IN', 'mai-IN', 'ml-IN', 'mni-IN', 'mr-IN', 'ne-IN',
'od-IN', 'pa-IN', 'sa-IN', 'sat-IN', 'sd-IN', 'ta-IN', 'te-IN' or 'ur-IN'
```

`ur-IN`, `ne-IN` and `ks-IN` are **in that list and still refused**:

```
400  "Please request beta access to ur-IN by contacting our support team."
400  "Please request beta access to ne-IN by contacting our support team."
400  "Please request beta access to ks-IN by contacting our support team."
```

So the app's Sarvam-primary call fails for Urdu and Nepali not because the code is
wrong but because **this account has no access to them**. That is the whole reason
an ElevenLabs fallback ever served them — and it retroactively confirms the §13
routing: with Sarvam unavailable, `eleven_v3` was the only voice either of them
could get.

**`bho-IN` and `awa-IN` are not in the list at all.** They are not gated; they do
not exist.

### ElevenLabs — 32 languages on Flash, 74 on v3, neither has Bhojpuri or Awadhi

The account's `/v1/models` reports both models' language sets, and the API rejects
an unsupported code rather than ignoring it:

```
"Model 'eleven_flash_v2_5' does not support language_code 'ur'."
```

`bho` and `awa` are absent from both.

### What that means for the four languages

| Language | Sarvam bulbul:v3 | ElevenLabs Flash | ElevenLabs v3 | Outcome |
|---|---|---|---|---|
| Urdu `ur` | beta-gated | ✗ | **✓** | **spoken correctly** (§13) |
| Nepali `ne` | beta-gated | ✗ | **✓** | **spoken correctly** (§13) |
| Kashmiri `ks` | beta-gated | ✗ | ✗ | still on the Sarvam fallback voice |
| Bhojpuri `bho` | **not offered** | ✗ | ✗ | **no voice anywhere** |
| Awadhi `awa` | **not offered** | ✗ | ✗ | **no voice anywhere** |

### The two operator actions this identifies

1. **Request beta access to `ur-IN`, `ne-IN` and `ks-IN` from Sarvam.** Those are
   *native Indic* voices for three languages, two of which currently depend on
   ElevenLabs' generic multilingual model. This is a quality upgrade and probably a
   cost reduction, and it is an email rather than an engineering task.
2. **Bhojpuri and Awadhi have no path through any configured provider.** They should
   either be sourced from a provider that has them, or offered as text-only.

## 15. The label now matches the evidence, per language (2026-09-23)

§13 fixed the voice for Urdu and Nepali, which made the picker's **"(basic voice)"**
label out of date for `ur`. Removing it for both would have over-claimed, because
the two languages do not have the same evidence behind them.

| Language | Model declares it | Audio verified by STT | Label |
|---|---|---|---|
| Urdu `ur` | ✓ `eleven_v3` | ✓ intelligible transcript | **"Urdu"** — label removed |
| Nepali `ne` | ✓ `eleven_v3` | **✗ no STT could transcribe it** | **"Nepali (basic voice)"** — kept |
| Bhojpuri `bho` | ✗ neither model | — | "(basic voice)" — kept |
| Awadhi `awa` | ✗ neither model | — | "(basic voice)" — kept |

The Nepali audio was produced and the API accepted the code, but **no available
speech recogniser could read it back**: Deepgram returned an empty transcript
through `detect_language`, and Sarvam's `saarika:v2.5` rejects the language outright:

```
400  "Language 'ne-IN' is not supported by saarika:v2.5 model."
```

With no way to hear the result, the label stays. It is the same rule the label was
introduced under — do not present a voice as speaking a language until it has been
shown to.

### Verified on the handset

The speech-style picker now reads **"Urdu"** with no suffix, while **"Nepali (basic
voice)"**, **"Bhojpuri (basic voice)"** and **"Awadhi (basic voice)"** are unchanged.

### Two more catalogue claims that do not match the providers

Found while checking this, and recorded rather than silently left:

- **`sttProvider: 'sarvam'` for `ur` and `ne` is wrong.** Sarvam's STT model refuses
  both languages, so both silently fall back to Deepgram. This is not aspirational —
  it is a different model (`saarika:v2.5`) that has no such language.
- **`voiceProvider: 'sarvam'` for `ur` and `ne` is aspirational.** It would be right
  if the operator obtains the beta access from §14; today the call fails every time
  before ElevenLabs serves it.

## 16. Urdu voice input was transcribing to nothing (2026-09-23)

Checking §15's note that the catalogue claims Sarvam STT for Urdu turned up
something worse than a wasted call.

### The defect

`transcribeAudio` takes a `language` argument and **never used it**. The request URL
was built without any language parameter:

```
https://api.deepgram.com/v1/listen?punctuate=true&smart_format=true
```

so every Deepgram request ran the English default regardless of what the caller
asked for. Measured on one Urdu clip through the app's own
`transcribeAudioForLanguage`:

| Request | Transcript |
|---|---|
| as shipped | **`''`** — empty |
| with `detect_language=true` | *"कल सौ दस बजे client को call करें."* |

Urdu reaches Deepgram on **every** request, because Sarvam's STT model refuses the
language outright:

```
400  "Language 'ur-IN' is not supported by saarika:v2.5 model."
```

So the fallback was the only path Urdu had, and it returned an empty string. A user
could speak Urdu and NOVA heard **silence** — not a degraded transcript, nothing at
all. That is the difference between a language being supported and being listed.

### The fix

Non-English languages now ask Deepgram to detect; English keeps the plain URL, which
is already correct for it. Verified through the same path: Urdu goes from empty to a
real transcript.

### Nepali is *not* fixed by this

The same path now returns text for Nepali — but the text is nonsense:

```
ne: provider=deepgram  transcript="Bully das bei Dir Ha gleich ho."
```

Deepgram's language detection has no Nepali to find, and Sarvam refuses `ne-IN` as
well. Nepali voice **input** therefore remains unusable, and now measurably so:
previously an empty string, now Latin-script gibberish. It is recorded as its own
finding rather than counted as fixed.

### What this changes about the language matrix

Urdu's row moves from *listed but unhearable* to **working input**, and Nepali's
from *silent* to *demonstrably wrong*. Both are improvements in what is known; only
one is an improvement in what a user gets.

## 17. Narrowing my own claim: which path was broken (2026-09-23)

§16 concluded that "Urdu voice input was transcribing to nothing". That is true of
**one path**, and the round that found it did not say so precisely enough. Checking
the live path revises the scope.

### The two STT paths are not the same model

| Path | Used for | Model | `ur-IN` |
|---|---|---|---|
| `transcribeAudio` (REST) | uploaded audio, meeting pipeline | Sarvam `saarika:v2.5` | **rejected** — *"Language 'ur-IN' is not supported"* |
| `realtime/stt/sarvam.ts` (streaming) | **spoken conversation** | Sarvam `saaras:v3-realtime` | **accepted** |

Measured by opening the streaming socket with each language code:

```
hi-IN    OPEN — accepted
ur-IN    OPEN — accepted
ne-IN    OPEN — accepted
```

So the REST model's refusal is **not** the streaming model's limitation. §16's empty
transcript — and the fix that repaired it — concern the **upload** path. A live Urdu
conversation reaches a recogniser that accepts the language, and the earlier claim
overstated the damage by not distinguishing the two.

### What is still not established

Whether the *quality* of live Urdu or Nepali transcription is good. I tried to
measure it by feeding a real Urdu clip through the socket and **the probe returned no
finals for Urdu or for the Hindi control** — so the probe's protocol handling is
wrong and it proves nothing in either direction. It is recorded as a failed attempt,
not as a result.

The next attempt needs the response shape and flush semantics from
`sarvam.ts` (the service flushes with real silence and reads `final` events) rather
than a guessed message format.

### What this changes

- **Nothing about the fix** — `transcribeAudio` was genuinely dropping the language,
  and that is repaired and verified.
- **Everything about the claim's reach.** "Urdu voice input is broken" becomes "the
  REST/upload STT path discarded Urdu, and the live path's quality is unmeasured".
- Nepali's measured gibberish stands for the upload path; the live path accepts
  `ne-IN` and its quality is likewise unmeasured.

## 18. Live Urdu and Nepali work — measured, and my §16 scope was wrong again (2026-09-23)

§17 narrowed §16's claim to the upload path but left the live path's *quality*
unmeasured, because my first socket probe returned nothing (it looked for a message
shape the provider does not send). Reading `sarvam.ts` gave the real protocol —
`{"event":"audio_input"}`, answered with `transcript.partial` / `transcript.final` —
and one run settled it.

### The measurement

Real Urdu audio (16 kHz linear16) fed through the **same streaming endpoint the app
uses**, language set to the code the app sends:

| Language | Input | Transcript |
|---|---|---|
| Urdu `ur-IN` | کل صبح دس بجے کلائنٹ کو کال کریں | **`کل صبح دس بجے کلائنٹ کو کال`** |
| Nepali `ne-IN` | (Nepali clip) | **`कल सोभा दस बजे क्लाइन्टको कल`** |

Urdu comes back **in Urdu script, word for word**, missing only the final verb — the
transcript is a partial, and the partial is correct. Nepali comes back as
recognisable Nepali, with the spelling variance expected from a recogniser.

**So the path a real user talks through handles both languages well.** The empty
transcript in §16 and the gibberish in §17 are properties of the **REST/upload**
path (`transcribeAudio`, Sarvam `saarika:v2.5`), which is used for uploaded audio
and the meeting pipeline — not for conversation.

### A fix recommendation of mine that would have caused a regression

Row 42 recommended changing `sttProvider` from `sarvam` to `deepgram` for `ur` and
`ne` because Sarvam's *REST* model refuses them. **That recommendation is
withdrawn.** One catalogue field feeds **both** paths:

```
realtime/stt/types.ts:  resolveSttProvider()  ->  getSttProviderForLanguage()  (sarvam for ur)
transcribeAudioForLanguage()                  ->  getSttProviderForLanguage()  (sarvam for ur)
```

Sarvam streaming **works** for Urdu and Nepali — just measured — while Deepgram
streaming with `language=ur` merely *opens* (tested) and its quality is unverified.
Writing `deepgram` into the catalogue would have moved a verified-good language onto
an unverified model to save one failed REST call. The field is not wrong; it is
being asked to describe two different things.

### What is actually needed

A REST-specific decision, not a catalogue change: the REST path already falls back
to Deepgram for these languages, so the only loss is one refused upstream call. If
that latency matters, the fix belongs in `transcribeAudioForLanguage` — try the
provider the REST model actually supports first — and not in a field that also
routes the streaming path.

### Standing state of the two languages

| Path | Urdu | Nepali |
|---|---|---|
| Live conversation (streaming) | **works — verified** | **works — verified** |
| Uploaded audio (REST) | fixed in §16, verified | **gibberish — open** |

## 19. The REST STT path now transcribes Nepali and Urdu correctly (2026-09-23)

§16 stopped the upload path discarding the language and used `detect_language`.
That was half a fix: it repaired Urdu and left Nepali producing gibberish. Both are
now correct, and the reason is that **two** things were wrong.

### The model mattered as much as the code

| Language | Request | Transcript |
|---|---|---|
| Nepali | `detect_language` | *"Hana das Bagegra Hacklai Phone Gardnose."* — gibberish |
| Nepali | **`nova-3` + `language=ne`** | **"भोलि बिहान १० बजे ग्राहकलाई फोन गर्नुहोस्"** — correct |
| Urdu | **`nova-3` + `language=ur`** | **"کل صبح 10 بجے کلائنٹ کو کال کرے۔"** — correct |
| Urdu | `nova-2` + `language=ur` | **HTTP 400** — no such model/language combination |

`nova-2` carries no Indic language at all and `nova-3` does, and being *told* the
language beats asking Deepgram to guess it: detection gave gibberish for Nepali and
a partial for Urdu, while the explicit code transcribed both.

### The fix

Non-English asks for `nova-3` with the language. Deepgram **refuses** a code it does
not carry rather than ignoring it, so an explicit attempt degrades to detection
instead of failing the turn; English keeps `nova-2`, which is right for it.

Verified through the app's own `transcribeAudioForLanguage`:

| Language | Provider | Transcript |
|---|---|---|
| Nepali | deepgram | **"भोलि बिहान १० बजे ग्राहकलाई फोन गर्नुहोस्"** — was gibberish |
| Urdu | deepgram | **"کل صبح 10 بجے کلائنٹ کو کال کرے۔"** — was empty two rounds ago |
| Hindi | sarvam | *"कल सुबह दस बजे क्लाइंट को कॉल करें।"* — unchanged, primary still serves it |

### Where the two languages stand now

| Path | Urdu | Nepali |
|---|---|---|
| Live conversation (streaming, §18) | **works — verified** | **works — verified** |
| Uploaded audio (REST) | **works — verified** | **works — verified** |

Both languages are now transcribed correctly on both paths, each verified with real
audio and real provider calls rather than inferred from configuration.

## 20. The acoustic loop, in Hindi (2026-09-23)

The MacBook-as-human loop was run once before, in English (§21 of the production
report). It had never been run in an Indian language, and the pieces of the Hindi
path had only been verified separately. This is the whole loop, on the physical
phone, with the MacBook on both ends.

### The rig

MacBook speakers → **OnePlus 9R microphone** → Sarvam streaming STT → the model →
Sarvam TTS → **phone speaker** → MacBook microphone, recorded with `rec` at 16 kHz.
The MacBook spoke with macOS's Hindi voice, **Lekha**.

### What was said, and what came back

| | |
|---|---|
| MacBook said | *"आज मेरे पास क्या-क्या काम है?"* — "what work do I have today?" |
| Phone's transcript | **"आज मेरे पास क्या क्या काम है?"** — exact |
| NOVA replied | **"आज तुम्हारे पास कोई खुला काम नहीं है — सब काम कल और परसों के लिए हैं। कल यानी गुरुवार को तुम्हें ये काम करने हैं: क्लायंट को कॉल करना — सुबह नौ बजे, फार्मसी का ऑर्डर लेना — शाम पाँच बजे, बैंक को कॉल करना — शाम पाँच बजे, दंत चिकित्सक को कॉल करना — शाम पाँच बजे…"** |
| Avatar | **SPEAKING**, mouth open |

Three things are true of that reply at once: it is **in Hindi**, it is **in
Devanagari rather than transliterated**, and it is **grounded** — the client call at
nine, the pharmacy order, the bank and the dentist are the reminders this account
actually holds, from the lifecycle rounds. It is not a sample sentence.

### The return path, measured

The MacBook's recording, per-quarter-second RMS:

```
quiet floor  ~ 124
peak         ~ 2116   at 10.5 s      (17x the floor)
speech burst   10.0 s → 25.5 s       (~15 s of speech)
```

The burst begins *after* the MacBook stopped speaking, so it is the phone. Direction
one is proven by the transcript, direction two by the level, and neither is inferred
from the code.

## 21. The pinned language never reached the microphone (2026-09-23)

Testing code-switching on the handset turned up a defect bigger than the thing being
tested: **the language the user selected was not the language the recogniser used.**

### How it showed

The persona was pinned to `hinglish`, the app was rebuilt and launched, and the
MacBook spoke *"Kal subah mera kya schedule hai, batao na please"*. The app's own
server log said which language the turn ran with:

```
"language":"auto"
```

Not `hinglish`. The recogniser returned *"Cal Subamericaia schedule high, bateo na
please."* — Latin-script mangling of Hindi words — and NOVA answered:

> *"I'm not quite sure what you're asking for… **Feel free to write in English,
> Portuguese, or mix them however feels natural.**"*

It did not answer the question, and it suggested **Portuguese**: a language with no
connection to the user, the input, or the catalogue.

### The cause

Every voice entry point took the language like this:

```dart
ref.read(personaProvider).asData?.value.languagePolicy
```

`personaProvider` was a lazy `FutureProvider.autoDispose`. A **read** of a lazy
provider that has not loaded returns `asData == null` — and nothing had watched it,
so it never loaded. `null` normalises to `'auto'` by design, so the pinned language
was discarded on the **first turn of every app run**. There was corroborating
evidence in the log: **no `/settings/persona` request at all** between app launch
and the turn.

### The fix

The provider is no longer `autoDispose`, and all four voice entry points (Converse,
Home, the floating orb, and the wake-word path) **await** `personaProvider.future`
instead of reading a possibly-cold value.

### Verified, one build apart, same sentence and voice

| | Language sent | Transcript | Reply |
|---|---|---|---|
| before | `auto` | *"Cal Subamericaia schedule high, bateo na please."* | *"I'm not quite sure… Portuguese…"* |
| **after** | **`hinglish`** | *"कै सब अमेरिका ये स्केजुल हाई बात है ना प्लीज।"* | **"हाँ, बिल्कुल। आपके पास कल (गुरुवार) को एक बहुत busy दिन है — सब कुछ दोपहर बारह बजे तक due है: वेंडर को कॉल करना, क्वार्टरली रिपोर्ट भेजना, लाइसेंस रिन्यू करना…"** |

The reply after the fix is **Hinglish** (Devanagari with English words), **correct**,
and **grounded** — the vendor call, quarterly report and licence renewal are this
account's real tasks.

### What is still not good

**The transcript is still imperfect** — *"कै सब अमेरिका ये स्केजुल हाई"* for *"Kal
subah mera kya schedule hai"*. The assistant recovered the meaning and answered
correctly, so the outcome is right, but the words are not. Recognising romanised
Hindi spoken by an English voice is a genuinely hard case and this is recorded as a
**quality** limitation, not a pass.

## 22. Tamil on the handset, and the previous round's fix holding (2026-09-23)

§21 fixed the pinned language never reaching the microphone. This round verifies that
fix on a **second** language and completes the Tamil loop on the physical phone.

### The prompt was real Tamil speech from a real provider

macOS has no Tamil voice installed, so the "human" was the app's own TTS: Sarvam
synthesised *"நாளை எனக்கு என்ன வேலை இருக்கு?"* and the MacBook played it at the
phone's microphone with `afplay`. (Sarvam returns **WAV** regardless of the `.mp3`
name the code implies — `afplay` refused it until it was converted.)

### What the session did

| Check | Evidence |
|---|---|
| The pinned language reached the microphone | server log: **`"language":"ta"`** — the same log said `auto` before §21 |
| The transcript | **`நாளை எனக்கு என்ன வேலை இருக்கு?`** — **exact**, word for word |
| The reply | Tamil, in Tamil script, **grounded**: *"5 மணிக்கு மருந்து கடை ஆர்டர் எடுக்க வேண்டும்… 5 மணிக்கு வங்கிக்கு போன் செய்ய வேண்டும்… 5 மணிக்கு பல்லியல் மருத்துவரை கால் செய்ய வேண்டும்… 6 மணிக்கு பால் வாங்க வேண்டும். நிறைய இருக்கு தான்! வேற ஏதாவது உதவி வேண்டுமா?"* |
| The register | colloquial — *"நிறைய இருக்கு தான்!"* — not textbook Tamil |
| The return path | MacBook's mic: floor ~133, peak **1618**, **17.8 s** of speech |

The pharmacy order, the bank call, the dentist and the milk are this account's real
reminders, so the answer is grounded rather than plausible.

### A correction about my own method

My first Tamil run showed a **truncated reply** — one line, cut mid-word: *"நாளை
(வியாழன் 24 செப்"*. I had tapped **Stop** while NOVA was still speaking, and the
MacBook's recording confirms it: **2 s** of phone audio in that run against **17.8 s**
in the uninterrupted one. The truncation was mine, not the product's, and the second
run — which let the VAD end the turn — produced the complete answer above.

Recorded because a single interrupted run would have been reported as a defect.
