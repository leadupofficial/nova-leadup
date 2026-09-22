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
| Shade | `fg_push_shade.png` | The notification is posted **silently** (`sound=null`, grouped under the silent indicator) | **P2** | Channel created with `Importance.high` but no sound | OPEN | — |

## 6. Screens not audited

These were not opened on the handset, so nothing is claimed about them:
Converse, Tasks, Memory, reminder detail, history, the notifications sheet, the
menu, the admin console, translate, wake-word settings, avatar & appearance,
privacy controls, daily briefing, and every error/empty state other than the two
above. The light theme was not exercised — the app is dark-only in this build.

## 7. Standing visual risks

- **Nav taps did not register** on the Home bottom bar (`input tap` at the tab
  centre, twice); the settings gear worked. Either the touch target is smaller
  than it looks or the system gesture area interferes. Worth checking with
  `uiautomator`, because a bottom tab that a scripted tap misses may also be a
  small target for a thumb.
- **The avatar is duplicated** wherever the orb is shown: the hero card on Home
  and the floating orb elsewhere. Only the Home collision was a defect, but the
  product should decide whether the orb is a second presence or a shortcut.
