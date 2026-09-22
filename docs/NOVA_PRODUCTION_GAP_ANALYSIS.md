# NOVA — Production Gap Analysis

Every row is a gap between the intended product and observed behaviour, with severity,
root cause, and what remains. Status legend: **FIXED** (code changed + re-verified),
**OPEN**, **BLOCKED** (needs an asset or decision I cannot supply).

| # | Feature | Expected | Current (observed) | Root cause | Sev | Fix | Remaining work | Production impact |
|---|---|---|---|---|---|---|---|---|
| 1 | Reminder creation in Indian languages | Any supported language creates the reminder | Hindi/Telugu/Kannada/Bengali turns failed the tool 2–3× and hit the iteration cap; Telugu answered in English with "That didn't work" | `stated-time.ts` clock-time guard knew only English + Tamil wording, so a stated hour read as *invented* | **P0** | **FIXED** — added o'clock markers + parts of day for 11 Indian languages, Latin transliterations, Tamil phonetic `ஓ கிளாக்`; guard still refuses time-less turns | Widen to remaining catalogue languages if their STT is enabled | The product's core action was unusable in 4 of 5 tested languages |
| 2 | Hinglish/Benglish/Gujlish speech recognition | Mixed speech understood | "Kal subah aath baje ka reminder laga do yaar" → **"Reminder lag"** | `getSttProviderForLanguage` special-cased only `tanglish`; other mixed codes fell to Deepgram (English) | **P0** | **FIXED** — all mixed codes route to Sarvam; same for voice provider | — | Mixed-language users lost most of every sentence |
| 3 | Honesty about completed actions | Never claim an action that did not happen | "ரிமைண்டர் வெச்சுடுச்சு" ("the reminder is set") with `tools: []` and no row | `claimsStateChange` missed the Tamil completive `-ச்சுடுச்சு / -ட்டு / -ஞ்சு` stems | **P1** | **FIXED** — stems added in Tamil + Latin; present-tense descriptions still ignored | Audit other reply shapes as new phrasings appear | User believes a reminder exists and misses the commitment |
| 4 | Proactive assistance delivery | Nudge reaches the phone | 82 `follow_up` rows, **0 read**, **no delivery column**, no FCM, socket.io dead, app never calls `/notifications` | No transport exists; `emitToUser` is a no-op | **P0** | OPEN | Add FCM + `firebase_messaging`, device-token registration, `delivered_at`; or a foreground-service poll while that is built | The entire proactive half of the product is inert |
| 5 | Wake word "Hey Nova" | Responds to the phrase, in and out of app | No reaction to human speech at 90 % volume; `dumpsys activity services` shows **0** NOVA services; no `nova_wake_word` channel | `WakeWordService` declared but never started in this build/state | **P0** | OPEN | Start the FGS on first run and on resume; verify the sherpa-onnx KWS model loads on-device | Voice-first promise is unbacked |
| 6 | Background listening | Continue while backgrounded | `appops RECORD_AUDIO: foreground`; no battery-optimisation exemption; not on Doze whitelist; `BootReceiver` returns early on API ≥ 34 | Design + platform restrictions not handled | **P0** | OPEN (partly by design) | Foreground service with `microphone` type + `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` prompt + boot restart; document what is genuinely impossible on OxygenOS | No background assistant turns |
| 7 | Notification permission in onboarding | Button raises the OS dialog | Three taps produced no dialog; `POST_NOTIFICATION: ignore`; Android recorded **no user decision** | Unconfirmed — `permission_handler` request path or a silently-denied prior attempt | **P1** | OPEN | Instrument `requestNotification()` result; if it returns `denied` permanently, route the user to app settings with an explanation | Reminders fire but are never shown |
| 8 | Permission state freshness | Reflect OS state on return | OS `granted=true` while the app showed "The system did not grant this" and kept **Continue** disabled | `PermissionNotifier.checkInitialPermissions()` runs only in the constructor; never re-read on resume | **P1** | OPEN | Re-read on `AppLifecycleState.resumed`; add a "refresh" affordance | User is stuck on the permissions screen until force-quit |
| 9 | Pre-auth consent sync | Silent/queued | Red **"Missing or invalid authorization header"** on every consent row during onboarding | `POST /api/v1/consent` → 401 before the user exists, and the raw message is rendered | **P1** | OPEN | Queue consent locally and sync post-auth, or suppress the technical message and show calm copy | Alarming, technical, and the first thing a new user sees |
| 10 | First-run order | Authentication first | **FIXED & VERIFIED ON DEVICE 2026-09-23.** A genuine uninstall/reinstall (`pm clear` is refused to `shell` on this ColorOS build) opened the *Meet NOVA* welcome page. Now a fresh install opens **Welcome back** with country + phone and a single CTA, *Continue with OTP*; no company/campaign/customization/language/dashboard screen is reachable, and email+password is behind an explicit switch. After the OTP the app lands on onboarding. | Router gated onboarding before auth (`_entryLocation` returned `resumeStep()` for any incomplete status) | **P0** | **FIXED** — the auth gate now runs first and `/onboarding/otp` counts as an auth route; splash sends a signed-out user to `/login` | — | A brand-new user was personalised before they had an account, and the product's specified first screen did not exist |
| 11 | Phone + Firebase OTP login (client + server) | Primary login, end to end | **WORKS, VERIFIED ON DEVICE 2026-09-23.** Fresh install → `7868002606` → *Continue with OTP* → 6-digit screen reading `+91 XXXXXX 2606` → `123456` → `FirebaseAuth: Notifying id token listeners about user ( vZnCX8gd3RNxUjA46pDItGa9zdc2 )` → a **new `sessions` row `71afc016-c5cb-4346-b3b8-676e047e05a3` at 2026-09-22T13:19:58Z** → onboarding. | Fixed in this session: `firebase_auth` added, debug SHA registered, `/api/v1/auth/firebase/exchange` implemented, Firebase resolved lazily | **P0** | **FIXED** | — | This is now the live login path |
| 11a | Phone-auth app verification (Firebase Android SDK) | OTP request always reaches a code | **INTERMITTENT.** One run completed in ~2 min; the next opened a browser Custom Tab at `…gging.firebaseapp.com` showing *"Unable to process request due to missing initial state"* and the sign-in failed. | `Failed to initialize reCAPTCHA config: No Recaptcha Enterprise siteKey configured for tenant/project *`. `recaptchaenterprise.googleapis.com` is **disabled** in the project; the SDK falls back to the reCAPTCHA web flow, which is broken. The service account has no `serviceusage.services.enable`. | **P0** | **BLOCKED** | See §Blocked below — a project Owner must enable the API and provision the reCAPTCHA/Play Integrity config for `com.leadup.nova` | Users are intermittently dumped into a broken browser page instead of receiving a code |
| 11b | OTP send count | One SMS per sign-in | **FIXED & VERIFIED.** The login screen sent a code, waited for `codeSent`, routed to the step, and the step **sent a second one** for the same sign-in. | The `/onboarding/otp` builder supplied the transport but not `requestOnStart`, which defaults to `true` | **P1** | **FIXED** — the route passes `requestOnStart: false` when the caller supplied a transport | — | Double SMS cost and needless pressure on the per-number throttle |
| 13 | Permission caption on a fresh install | The row states the system's real answer | Both Microphone and Notifications read **"The system did not grant this. You can allow it later."** before the user had tapped anything | `permission_handler` reports `denied` for *never asked* as well as for *refused*, and the caption treated one as the other | **P1** | **FIXED** — a row that has not been asked says "Not turned on yet"; a real refusal still reads as one. Verified on device (`perm_fixed.png`) | — | A false failure on the first screen after login; users were told the system refused something it was never asked for |
| 14 | Notification permission request | Button raises the OS dialog | Previous round recorded **no dialog across three taps** | The earlier observation was a transient device state, not a broken path — this round the dialog appeared on the first tap and `POST_NOTIFICATIONS: granted=true` | **P1 → RETRACTED** | **NOT A DEFECT** — re-tested and granted normally | Re-check if it recurs on a clean device | — |
| 15 | Home top bar vs floating avatar | Avatar is prominent without covering controls | The 80px summon orb sat at the same top-right position as the only top bar in the app, covering the notification bell and the settings icon | The overlay positioned the orb at `top: 60, right: gutter` with no awareness of the screen beneath it or of Home's own hero avatar | **P2** | **FIXED** — the orb is not drawn on `/`; Home keeps the hero avatar, other screens keep the orb. Verified on device (`home_fixed.png`) | — | Two avatars, one of them on top of the controls, on the first screen after onboarding |
| 12 | Language selection | All genuinely supported Indian languages | Four chips: Auto Tamil–English, Tamil, English, Tanglish | `companion_page.dart`, `me_page.dart`, `settings.ts` enum, `voice_protocol.dart` all hardcode the same four | **P1** | OPEN | Widen the API enum and both pickers to the verified set; mark fallback-voiced languages as partial | Non-Tamil Indian users cannot choose their language |
| 13 | Urdu/Nepali/Kashmiri/Bhojpuri/Awadhi voice | Spoken in-language | TTS provider reports `elevenlabs-fallback` — an English voice reading non-Latin script | Google provider selected in the catalogue but no Google key is configured | **P2** | OPEN | Either configure Google TTS or remove these from the selectable list and label them partial | Replies are textually right, spoken wrong |
| 14 | Avatar prominence | Large, centred, non-overlapping | Bubble overlaps the header bell and settings gear on every screen | In-app overlay positioned without reserving layout space | **P1** | OPEN | Move the bubble clear of the app bar or collapse header actions while it is shown; enlarge the Home avatar | Controls are visually and possibly physically blocked |
| 15 | Task/reminder state transitions | create/modify/complete/reopen/snooze/cancel | Serialized by the tool layer and covered by the API suite; **create** verified end-to-end this session | — | **P2** | OPEN | Re-verify each transition acoustically once §5/§6 are fixed | Lower risk than the above |
| 16 | Multi-turn context ("that", "it") | Resolve references | Not verified this session | — | **P2** | OPEN | Add a device test for pronoun resolution | Unknown |
| 17 | Company/business configuration | Collected in onboarding | No such screen in the observed flow | Not implemented | **P2** | OPEN | Add the step if the product requires it | Enterprise personalisation missing |
| 18 | iOS | Buildable with Firebase | `apps/mobile/ios/Runner/GoogleService-Info.plist` is a placeholder and not in `project.pbxproj` | Never wired | **P3** | OPEN | Add the real plist to the target | iOS build has no Firebase |

## Cross-cutting notes

- **The assistant brain is ahead of the shell.** STT, the language-aware prompt, the tool
  layer, the reminder scheduler and the audit trail all behaved correctly once the two
  guards were widened. The failures that block daily use are transport (proactivity),
  process lifecycle (foreground service / wake word / Doze) and first-run flow.
- **Two guards were the same bug in different languages.** Both the invented-time guard
  and the false-claim guard were correct for English and Tamil and blind everywhere else.
  Any future guard that pattern-matches user or model language should be treated as
  language-scoped until proven otherwise, and tested in at least the tier-A languages.
- **Do not read a green reply as a green action.** The Telugu failure produced a
  perfectly-scripted Telugu sentence while nothing was created; only the reminder count
  revealed it. Outcome assertions, not reply assertions, are what caught it.

---

## Blocked — exact action required

These are not code problems and cannot be closed from this machine.

### B1. Firebase phone-auth app verification (blocks row 11a) — P0

**STATUS: BLOCKED**

**Reason.** The Firebase Android SDK must produce an app-verification attestation
before it will send an OTP. This project has neither provider configured:

- `recaptchaenterprise.googleapis.com` → `403 … has not been used in project
  nova-leadup-stagging before or is disabled`
- `androidcheck.googleapis.com` (legacy Android Device Verification) and
  `playintegrity.googleapis.com` → not enabled
- `GET identitytoolkit/v2/projects/nova-leadup-stagging/config` returns
  `recaptchaConfig: null`

Enabling them needs `serviceusage.services.enable`, which the Firebase Admin SDK
service account does not hold:

```
POST serviceusage.googleapis.com/v1/projects/nova-leadup-stagging/services/recaptchaenterprise.googleapis.com:enable
403 PERMISSION_DENIED  "Permission denied to enable service"
```

There is no `gcloud` on this machine and no application-default credentials, so
there is no broader credential to use.

**Required (project Owner, Google Cloud / Firebase console).** Any one of:

1. Enable **reCAPTCHA Enterprise API** for `nova-leadup-stagging`, then in
   Firebase Console → Authentication → Settings provision the reCAPTCHA key for
   the Android app `com.leadup.nova` (SHA-1
   `06:3F:DC:2F:0F:BD:4C:F7:0E:38:E7:1B:05:E6:70:52:A9:3F:68:C2`).
2. Or set up **Play Integrity** for the app and enable App Check.
3. Or grant the deploy service account `roles/serviceusage.serviceUsageAdmin`
   so the API enablement can be automated here.

**Already confirmed working without it.** The Firebase backend itself is correct:
phone provider enabled, and `+917868002606` is registered as a test number with
the fixed code `123456`. Server-side the full chain is proven —
`accounts:sendVerificationCode` → `accounts:signInWithPhoneNumber` (correct code
`200`, wrong code `400 INVALID_CODE`) → `POST /api/v1/auth/firebase/exchange`
`200` → `GET /api/v1/auth/me` `200` — and the on-device path completed once, with
a real session row as evidence. Only the SDK's attestation step is unreliable.
