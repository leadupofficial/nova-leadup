# NOVA — Real-User Evidence Log

Raw, reproducible evidence behind `NOVA_REAL_USER_TEST_REPORT.md`. Nothing here is
inferred from source reading; every entry is an observed command and its output.

## E1. Device identity and state

```
$ adb devices -l
601f9bc0   device usb:18022400X product:OnePlus9R_IND model:LE2101 device:OnePlus9R

$ adb shell getprop ro.build.version.release   → 14
$ adb shell getprop ro.build.version.sdk       → 34
$ adb shell getprop ro.product.cpu.abi         → arm64-v8a
$ adb shell getprop persist.sys.timezone       → Asia/Kolkata
$ adb shell dumpsys package com.leadup.nova | grep versionName
    versionName=1.0.0   targetSdk=36
```

The device dropped off USB mid-session (`adb: no devices/emulators found`) and
reconnected 30 s later; `adb reverse` was re-established after reconnection.

## E2. The P0 multilingual failure — before the fix

Real speech, generated with macOS native Indian voices, POSTed to `/api/v1/voice/stt`
and then `/api/v1/voice/chat`:

```
$ say -v Lekha -o hi.aiff "कल सुबह आठ बजे का रिमाइंडर लगा दो"
$ afconvert -f WAVE -d LEI16@16000 -c 1 hi.aiff hi.wav     # 16 kHz mono
```

STT was **correct** for every language, which is what made the failure invisible:

```
Tamil     heard 'நாளைக்கு காலை எட்டு மணிக்கு …'     provider=sarvam detected=ta-IN
Hindi     heard 'कल सुबह 8 बजे का रिमाइंडर लगा दो।'  provider=sarvam detected=hi-IN
Telugu    heard 'రేపు ఉదయం ఎనిమిది గంటలకు …'          provider=sarvam detected=te-IN
Kannada   heard 'ನಾಳೆ ಬೆಳಿಗ್ಗೆ 8 ಗಂಟೆಗೆ …'             provider=sarvam detected=kn-IN
Bengali   heard 'আগামীকাল সকাল আটটা আজ একটা …'         provider=sarvam detected=bn-IN
Tanglish  heard 'நாளைக்கு மார்னிங் 8 ஓ கிளாக் …'        provider=sarvam detected=ta-IN
Hinglish  heard 'Reminder lag'                        provider=deepgram detected=hinglish
```

The server log showed the action failing while the reply looked healthy:

```
language=hi tools=['create_reminder:failed','create_reminder:failed'] iterations=3 capped=false
language=te tools=['create_reminder:failed','create_reminder:failed','create_reminder:failed'] capped=true
language=kn tools=['create_reminder:failed','create_reminder:failed']
language=bn tools=['create_reminder:failed','create_reminder:failed']
language=ta tools=['create_reminder:ok'] iterations=2
language=te reply='That didn't work. The reminder was not created.'      ← in English
```

Isolated proof of the guard itself:

```
Tamil     ALLOW  (time stated)  evidence="8 மணிக்கு"
English   ALLOW  (time stated)  evidence="at 8"
Hindi     REFUSE as invented (kind=none)  evidence=""
Telugu    REFUSE as invented (kind=none)  evidence=""
Kannada   REFUSE as invented (kind=none)  evidence=""
Bengali   REFUSE as invented (kind=none)  evidence=""
Tanglish  REFUSE as invented (kind=none)  evidence=""
```

## E3. The same pipeline after the fix — outcome, not wording

Reminder rows read back from the API after each spoken turn:

```
language   heard (their words)                      reminders created
Tamil      நாளைக்கு காலை எட்டு மணிக்கு…             1  -> rows: Reminder
Hindi      कल सुबह 8 बजे का रिमाइंडर लगा दो।        1  -> rows: Reminder
Telugu     రేపు ఉదయం ఎనిమిది గంటలకు…                 1  -> rows: Reminder
Kannada    ನಾಳೆ ಬೆಳಿಗ್ಗೆ 8 ಗಂಟೆಗೆ…                    1  -> rows: Reminder
Bengali    আগামীকাল সকাল আটটায়…                      1  -> rows: Reminder
Hinglish   Kal subah 8 baje ka reminder laga do      1  -> rows: Reminder
Tanglish   நாளைக்கு மார்னிங் 8 ஓ கிளாக்…               1  -> rows: Reminder
```

Replies in the same run, in the speaker's own script:

```
Telugu    'రిమైండర్ సెట్ చేసాను — రేపు ఉదయం ఎనిమిది గంటకు.'
Kannada   'ನಾಳೆ ಬೆಳಿಗ್ಗೆ 8 ಗಂಟೆಗೆ ರಿಮೈಂಡರ್ ಹಾಕಿದೆ.'
Bengali   'আগামীকাল সকাল আটটায় আপনার রিমাইন্ডার সেট হয়ে গেছে।'
Tamil     'நாளைக்கு காலை எட்டு மணிக்கு ரிமைண்டர் வைக்கப்பட்டுவிட்டது.'
```

## E4. The false-confirmation guard

```
MISSED  நாளைக்கு மார்னிங் 8 ஓ க்ளாக்குக்கு ரிமைண்டர் வெச்சுடுச்சு.   ← reached a real user
MISSED  Reminder vechuduchu
MISSED  செஞ்சுடுச்சு
MATCH   Done! I've set the reminder.
MISSED  நாளைக்கு reminder இருக்கு          ← present tense; MUST stay unmatched
MISSED  காலை 8 மணிக்கு reminder வைக்கணுமா?  ← a question; MUST stay unmatched
```
After the fix all six classify correctly and the two negative cases stay negative.

## E5. Language capability matrix (26 codes, live pipeline)

```
en   yes/ok/elevenlabs-audio     hi  yes/ok/sarvam-audio   bn  yes/ok/sarvam-audio
ta   yes/ok/sarvam-audio         te  yes/ok/sarvam-audio   kn  yes/ok/sarvam-audio
ml   yes/ok/sarvam-audio         mr  yes/ok/sarvam-audio   gu  yes/ok/sarvam-audio
pa   yes/ok/sarvam-audio         or  yes/ok/sarvam-audio   as  yes/ok/sarvam-fallback-audio
mai  yes/ok/sarvam-fallback      sa  yes/ok/sarvam-fallback sd yes/ok/sarvam-fallback
doi  yes/ok/sarvam-fallback      mni yes/ok/sarvam-fallback
ur   yes/ok/elevenlabs-fallback  ne  yes/ok/elevenlabs-fallback
ks   yes/ok/elevenlabs-fallback  bho yes/ok/elevenlabs-fallback
awa  yes/ok/elevenlabs-fallback
hinglish / tanglish / benglish / gujlish : yes/ok/sarvam-audio
```
`elevenlabs-fallback` means an English voice read non-Latin script — textually right,
spoken wrong. STT was exercised with **real audio** for ta, hi, te, kn, bn, tanglish and
hinglish; the rest were not sampled acoustically and are not claimed as such.

## E6. Proactive assistance — the numbers

```
notifications columns: id,user_id,type,title,body,payload,read,read_at,occurred_at
                       ↑ no delivery column of any kind
by type: [{"type":"follow_up","n":82}]
follow-ups read vs total: {"total":82,"read":0}
most recent: "Your reminder Client meeting went off and has not been dismissed."
             occurred_at 2026-09-22T02:21:19Z
```
Mobile app: `ApiConfig.notifications` is declared and has **no call site**.
`setupNotificationSocketHandlers` / `notificationService.setSocketServer`: no callers.

## E7. Wake word and background — the phone's own report

```
$ adb shell dumpsys activity services | grep -c com.leadup.nova
0                                              ← the declared WakeWordService is not running
$ adb shell cmd appops get com.leadup.nova RECORD_AUDIO
Uid mode: RECORD_AUDIO: foreground             ← microphone is foreground-only
$ adb shell dumpsys deviceidle whitelist | grep -i leadup
(no output)                                    ← not exempt from Doze
$ adb shell dumpsys notification | grep nova_wake_word
(no output)                                    ← the channel was never created
```
Acoustic attempt, MacBook speakers at 90 % output volume, phone on the desk:
three utterances of "Hey Nova" → **no logcat line, no service, no UI change, no transcript**.

## E8. Onboarding on the handset

Order observed by walking it: `welcome → permissions → profile → companion → health → login`.

- Microphone `Allow` → real Android `GrantPermissionsActivity` → `RECORD_AUDIO: granted=true`,
  row became "Allowed".
- Notifications `Allow` ×3 → no `GrantPermissionsActivity` in logcat, appop stayed
  `ignore`, and `dumpsys package` showed no `USER_SET` flag, i.e. **Android recorded no
  user decision at all**. `pm grant` and `appops set` are refused to `shell`
  (`SecurityException: … does not have android.permission.GRANT_RUNTIME_PERMISSIONS`),
  so it was enabled through system Settings, after which the toggle read
  `POST_NOTIFICATIONS: granted=true, flags=[USER_SET|…]`.
- With the permission granted at OS level the app still rendered
  *"The system did not grant this"* and kept **Continue** disabled. Force-stop + relaunch
  → the row read "Allowed". This is the staleness defect.
- Every consent row rendered, in red:
  *"Missing or invalid authorization header — saved on this device; it will sync once you
  sign in."*, traced to `POST /api/v1/consent → 401` (`"path":"/api/v1/consent","statusCode":401`).
- Speech style choices offered: **Auto Tamil–English, Tamil, English, Tanglish** only.
- Login page: email+password **and** Country `India (+91)` / Phone number /
  **"Continue with OTP"** disabled under **"Phone sign-in is not available on this server."**

## E9. Acoustic capture rig (working, for the retest)

```
mac volume: 90
rec -q -c 1 -r 48000 /tmp/nova-val/loop.wav trim 0 45   # captures MacBook mic
sox /tmp/nova-val/loop.wav -n stat
  Maximum amplitude: 0.205621   RMS amplitude: 0.011284  # real signal, room quiet enough
```
The rig records fine; there was no NOVA speech to capture because the phone never
entered a listening session.

## E10. Regression evidence

```
services/api        Test Files 64 passed (64)   Tests 1089 passed (1089)
assistant-stated-time.test.ts    75 tests passed
assistant-grounding.test.ts      52 tests passed
```
One full-suite run showed `create-idempotency` and `rate-limit` failing; both pass twice
in isolation with the same changes applied, and the full suite passes on re-run —
recorded as a parallelism flake, not a regression.
