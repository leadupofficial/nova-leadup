# NOVA — Visual UI Audit

**Date:** 2026-09-23
**Device:** OnePlus 9R (`LE2101`), 1080×2400, Android 14, dark theme
**Method:** every screenshot below was taken from the physical handset with
`adb exec-out screencap` while driving the app through the real flow. Issues were
reproduced, fixed in code, rebuilt, reinstalled and re-photographed — the
*verification* column says what was actually seen afterwards, and `—` means the
fix was not re-photographed and is not being claimed as verified.

Severity: **P0** blocks a core flow · **P1** major · **P2** important · **P3** polish.

---

## 1. First launch and authentication

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| First launch (fresh install) | `fresh_launch1.png` | The first screen a new user saw was the **marketing welcome page**, not authentication — the required flow is phone → OTP → authenticated → onboarding, and no customization/language/dashboard screen may come first | **P0** | `_entryLocation` returned `resumeStep()` for any incomplete onboarding status, and `redirect` gated onboarding before auth | Auth gate moved first; `/onboarding/otp` counts as an auth route; splash sends a signed-out user to `/login` | `auth_first2.png` — **Welcome back**, country + phone, one CTA |
| Login (entry) | `auth_first1.png` | A **dead back chevron** sat in the top-left of the entry screen, where there is nothing to go back to | **P3** | The top bar always drew the button | `_TopBar` takes `showBack`; the tile keeps its slot so the heading does not shift | `auth_first2.png` — gone |
| Login (entry) | `auth_first1.png` | Two authentication methods offered at once (email + password above phone) | **P2** | Both forms rendered unconditionally | Phone is the only method shown; email sits behind an explicit switch | `email_form.png` — the switch renders and is reversible |
| Phone entry | `phone_typed.png` | — | — | — | — | — |
| OTP step | `otp_entered.png` | The masked destination read `+91 XXXXX XXXXX`, so the user could not check which number the code went to | **P3** | `_maskPhone` masked every digit | Last four digits kept, as carriers and banks do | `otp_mask.png` — `+91 XXXXXX 2606` |
| OTP step | `otp_no_resend.png` | A browser Custom Tab opened at `…gging.firebaseapp.com` showing *"Unable to process request due to missing initial state"* | **P0** | The project has no reCAPTCHA Enterprise / Play Integrity configuration, so the Firebase SDK falls back to a web flow that is broken | Not a UI defect — recorded as **BLOCKED** on a project Owner in `NOVA_PRODUCTION_GAP_ANALYSIS.md` §B1 | — |
| Login (recovery) | `after_browser.png` | — | — | — | After the failure the app returned to a clean login screen: no crash, no stuck spinner, no wedged state | Verified |
| Login error state | `otp_retry.png` | **Good**: the OTP request timed out and the screen said *"We could not reach the verification service"* with the button re-enabled | — | — | Previously it span forever | Verified |

## 2. Onboarding

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Welcome | `post_login.png` | Reached only after a session exists — correct | — | — | — | — |
| Permissions | `onb2.png` | Both rows said **"The system did not grant this. You can allow it later."** before the user had tapped anything — a false failure on the first screen after login | **P1** | `permission_handler` reports `denied` for *never asked* as well as for *refused*, and the caption treated one as the other | A row that has not been asked says *"Not turned on yet"*; a real refusal still reads as one | `perm_fixed.png` — both rows corrected |
| OS microphone dialog | `mic_dialog.png` | — | — | — | — | `RECORD_AUDIO: granted=true` |
| OS notification dialog | `notif_dialog2.png` | — | — | — | — | `POST_NOTIFICATIONS: granted=true` |
| Permissions resolved | `perm_scroll2.png` | — | — | — | — | Microphone/Notifications/Memory/AI processing *Allowed*, Recording *Not now* |
| About you | `onb_next.png` | No top bar and no back affordance; the heading is jammed against the status bar, unlike Permissions and Create companion which both have one. A two-control form leaves most of the screen empty | **P3** | Screen does not use the shared scaffold chrome | OPEN | — |
| Create companion | `onb_companion.png` | Speech style offered only **4** options (Auto Tamil–English / Tamil / English / Tanglish) | **P1** | Four hardcoded chips in two files, a four-value API enum duplicated in two more | One catalogue-derived list in both pickers | `lang_sheet.png` — **27 options** |
| Create companion | `onb_companion.png` | The avatar preview is a large empty panel with the face low in it; the avatar reads as small for the space it is given, and the mandate asks for it to be prominent | **P2** | Preview panel fixed-height with the rig bottom-aligned | OPEN | — |
| Your preferences | `onb_health.png` | Top bar and back affordance missing, as on About you. Large unused area | **P3** | As above | OPEN | — |
| Assistant sheet (in-app) | `lang_sheet.png` | The floating orb overlaps the sheet's top-right corner | **P3** | The orb is drawn globally above the sheet | OPEN | — |

## 3. Home

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Home (first paint) | `home.png` | **The floating summon orb sat through the notification bell and the settings icon** — two avatars, one covering the controls | **P2** | The overlay hardcoded `top: 60`, inside `NovaScaffold`'s top bar (`topInset` 44 + a 44px row + 16px padding = 104) | Orb hidden on `/`, and moved to `_kOrbTopBelowTopBar` (112) everywhere else | `home_fixed.png` — bell and gear clear |
| Home | `home.png` | "Today's Overview" cards are clipped behind the bottom notice and the nav bar | **P3** | Content height vs bottom chrome | OPEN | — |
| Home | `home_fixed.png` | — | — | — | Hero avatar, *Tap to talk*, wake-word hint, five-tab nav all render correctly | Verified |

## 4. Profile

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Profile | `me_via_gear.png` | The orb covered the **sign-out** button — excluding Home was not enough | **P2** | Same hardcoded orb position | Fixed structurally (below the shared top bar) rather than by listing routes | `profile_orb.png` — sign-out clear |
| Profile | `profile_orb.png` | The orb now overlaps the user card. A floating affordance over content is the normal FAB trade-off, and it no longer covers a control | **P3** | — | Accepted | Verified |

## 5. Notifications (push)

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Shade, app backgrounded | `push_shade2.png` | — | — | — | **NOVA — Call Arun — "You have a reminder to call Arun. Would you like to do it now?"** | Verified |
| Shade, app foregrounded | `push_shade.png` | The push was accepted by FCM and **nothing appeared** | **P1** | Android posts a system notification only when the app is backgrounded; with NOVA open the message went to `onMessage` and nobody drew it | `PushForegroundHandler` draws it through the existing channel | `fg_push_shade.png` — visible; `dumpsys` shows `id=900001`, `importance=4` |
| Shade | `fg_push_shade.png` | The notification was posted **silently** (`sound=null`, grouped under the silent indicator) | **P2** | Channel created with `Importance.high` but no sound, and Android never updates an existing channel — so the id moved to `nova_reminders_v2` | Explicit sound, vibration, banner | `reminder_fired.png` — lands in the *alerting* group, not "Silent" |
| First sign-in | `fresh_perm.png` | The OS **"Allow NOVA to send you notifications?"** prompt appears over the *Get started* screen, before the app's own Permissions screen explains what it is for | **P3** | Push-token registration requests permission at first sign-in | OPEN | — |
| Reminder fired | `reminder_fired.png` | — | — | — | **"NOVA reminder — Check the oven"**, alerting group | Verified |
| Wake word screen | `wakeword_page.png` | **"WAKE WORD IS OFF"** with a *Turn on* button that reads as disabled (low-contrast outline, bottom bar) though it works | **P3** | Button styling | OPEN | — |
| Wake word notification | `wake_notification.png` | **"NOVA — Heard \"Hey Nova\" — tap to talk"** | — | — | Tapping only launched the app; now it opens Converse already listening | `tap_converse.png` — **LISTENING** |
| Home bell (before) | `bell_badge.png` | The bell had **no badge at all** — and before this round a hardcoded `0`. The server held a real unread count of **4**. | **P2** | The client read `data['data']` while `_get` had already unwrapped the envelope, so the count was always 0 | `parseUnreadCount` handles both shapes and is total | `bell_badge2.png` — **4** |
| Notification inbox | `inbox.png` | — | — | — | New sheet: four rows with title, body, relative time, unread accent, dismiss button, and a real empty state | Verified |
| Notification inbox (after tap) | `inbox_read.png` | — | — | — | The tapped row renders as read and the badge behind the sheet drops 4 → 3; the database confirms 1 read / 3 unread | Verified |

## 6. Screens audited on the handset (2026-09-23)

Every screen below was opened on the OnePlus 9R and its screenshot read, with the
observations recorded rather than the image alone. Screenshots: `r59_*.png`.

| Screen | Verdict |
|---|---|
| **Memory** | Clean. Honest empty state — "Nothing remembered yet / NOVA stores what matters so you do not have to repeat yourself" with an *Add a memory* action — a search field above, and the orb sitting clear of all text. No issues. |
| **Translate** | Functional, one layout weakness: the action buttons stack **one per line** (`Speak`/`Paste`, then `Copy`/`Edit`/`Speak`/`Share`) where a single row is the norm, taking four lines of vertical space and leaving the right half of each band empty. **P3.** |
| **Conversations** | Two identical default rows read **"New Conversation"** and **"New conversation"** — the same string capitalised differently, which reads as sloppiness. **P3.** Each row carries a bare trash icon with no visible confirmation step; not exercised, so nothing is claimed about whether deletion is guarded. |
| **Activity Centre** | The orb **covered the tail of a row's text** — a mid-list row read *"…via Pyth"* with the rest hidden. **Fixed** this round; see §11. The filter chip row also clips its last chip at the screen edge, which is horizontal scrolling without a fade or other affordance. **P3.** |

| **Admin console** | Correct and unusually candid: *"The admin console is limited to the owner and admin roles. This session is signed in as \"user\", and every /api/v1/admin route would answer 403."* One layout defect: the app-bar title is **truncated to "Admin C…"** because the `v1.0.0` pill competes for the same row. **P3.** |
| **Offline** | Reached by turning connectivity off — `adb shell cmd connectivity airplane-mode enable`, confirmed with a failed ping; the `/offline` deep link cannot reach it while online, and correctly rendered Home instead. Clean centred layout, no orb (right for a state where voice cannot work), and specific copy. One wording problem: the headline says *"Your saved reminders still work"* while the table directly beneath reads **"Reminders — Not cached"**. Both can be true — the alarm is armed locally while the list is not cached — but read together they look like a contradiction. **P3.** |

## 6b. Still not audited

Not opened on the handset: reminder detail, the menu, wake-word settings, avatar &
appearance, privacy controls, daily briefing, and every error/empty state other than
those noted. The light theme was not exercised — the app is dark-only in this build.

## 7. Standing visual risks

- **Nav taps did not register** on the Home bottom bar (`input tap` at the tab
  centre, twice); the settings gear worked. Either the touch target is smaller
  than it looks or the system gesture area interferes. Worth checking with
  `uiautomator`, because a bottom tab that a scripted tap misses may also be a
  small target for a thumb.
- **The avatar is duplicated** wherever the orb is shown: the hero card on Home
  and the floating orb elsewhere. Only the Home collision was a defect, but the
  product should decide whether the orb is a second presence or a shortcut.

## 8. Home — wake word line (2026-09-23)

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Home, fresh install | `r17_home2.png` | Home printed **`or say "Hey Nova"`** while the row above it read "Wake word is off". The wake word is off until opted in, so every new user was told to say something the app was not listening for. | **P2** | The line advertised the phrase whenever a wake-word model was *installed*, which is true even when the user has never enabled it | `wakeWordHomeLine` decides it in one tested place: off → "Tap to turn on the wake word" (tappable), listening → "Listening for …", enabled-but-arming → "Starting wake word…" | `r17_home2.png` — the line reads "Tap to turn on the wake word"; tapping it opens the wake word screen (`r17_tap.png`) |

An existing widget test had encoded the contradiction — it required `or say "Hey
Nova"` while the switch was off. It was updated, not deleted, and now asserts the
opposite.

## 9. Onboarding — the wake word step (2026-09-23)

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Onboarding, step 5 of 7 | `r28_step.png` | Onboarding never asked about the wake word, so every new user finished setup with it off and had to find it under Profile. | **P1** | The step simply did not exist | New `WakeWordStepPage` between *companion* and *health* | Renders on the handset: title "Wake word", the phrase explanation, a state card reading **"Wake word is off"** with a **Turn on** action, and **"Not now"** as the CTA. Reached by advancing from the companion step (`PUSH onboarding-wakeword prev=onboarding-companion`). |
| Onboarding, companion (speech style) | `r28_companion.png` | — | — | — | — | **Also closes a round-16 gap:** the picker's honest labels are visible on the device — **"Urdu (basic voice)"** and **"Nepali (basic voice)"** among the chips. |

The step keeps a full-screen layout with the CTA pinned to the bottom, which
leaves a large empty middle. That is consistent with the other onboarding steps
and was left alone.

## 10. Reminders — the exact-alarm notice, and the orb on top of it (2026-09-23)

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Reminders | `r30_rem3.png` | The floating summon orb sat on the notice **"Let reminders arrive on time"** and covered the tail of three lines — `deliver a reminde…`, `fire them at the…`, `Android's…`. The explanation of why reminders arrive late was itself unreadable. | **P2** | The orb was positioned `top: 112` to clear the top bar's controls, which put it on the first card of every screen instead. No page reserves space for it, and no test pinned the position. | Moved above the bottom navigation — the conventional slot, which belongs to chrome rather than content. Converse is excluded because its microphone is in that corner. | `r30_fixed.png` — the notice reads in full. `r30_converse.png` — no orb over the message list, mic unobstructed. |
| Reminders | `r30_fixed.png` | The orb now overlaps the right edge of a list card's **background** (not its text), as a Material FAB does. | **P3** | Accepted consequence of a floating control over a list | None — deliberate | Visible in `r30_fixed.png` |

### What the notice itself confirms

The screen carries an honest prompt for the exact-alarm access, and its copy is
accurate:

> **Let reminders arrive on time** — *"By default Android may deliver a reminder a
> few minutes late to save battery. To fire them at the exact time you set, NOVA
> needs Android's special "Alarms & reminders" access."* … *"Reminders keep working
> either way — without it they are just approximate."*

That matches the measurement in §33 exactly (87–294 s late after a reboot). The
app explains the delay and offers the fix; the access is a user choice on a system
screen, which is what Play's policy requires.

## 11. Activity Centre — the orb on a row's text (2026-09-23)

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Activity Centre | `r59_tasks_activity.png` | The floating orb sat on an activity row: the line behind it read *"…via Pyth"* with the remainder hidden. Round 30 moved the orb off the top of the page, which cured a *permanent* cover on Reminders; over a long list it still lands on whatever is beneath it. | **P2** | The rows are a plain `Column` with no trailing space, so the list's final row came to rest underneath the orb. The orb is 80 px tall and 98 px above the screen bottom, so ~60 px of content area is beneath it. | A 64 px clearance after the last row. Deliberately per-screen rather than a shell-wide inset: the orb is hidden on Converse (round 30), so a global bottom pad would leave a real gap there. | `r59_activity_bottom.png` — scrolled to the end, the last row reads *"…via Python-urllib/3.9"* with nothing hidden |

Other long lists carry the same overlap. It is the conventional floating-button
trade-off — a row can always be scrolled out from under the orb — and each screen
that needs it should get the same clearance rather than a global pad.

## 12. Conversations — two default titles, fixed (2026-09-23)

| Screen | Screenshot | Issue | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|---|---|
| Conversations | `r59_conversations.png` | Two identical rows read **"New Conversation"** and **"New conversation"** — the same string capitalised differently. | **P3** | Two sources of the same default: `converse_page.dart` passed an explicit `'New conversation'` at two call sites, while the server defaults to `'New Conversation'` when no title is sent. A row's title therefore depended on which path created it. | The client no longer sends a title at either call site, so the server's single default applies. `createConversation(title:)` and `startConversation(title:)` already treat it as optional. | Verified against the API: the conversation the app created after the rebuild reads **`'New Conversation'`**; the row created before it still reads `'New conversation'` — history is not rewritten |
