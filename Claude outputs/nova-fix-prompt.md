# NOVA — Full Redesign + Make the AI Companion Actually Work (Prompt)

Paste this whole document as the first message to a coding agent (Claude Code / Cowork) that has full file and shell access to the `NOVA-Leadup` repo, plus the Figma design MCP and a real Android/iOS device or simulator for manual verification. Give it your highest-effort/most capable model — this is a multi-day job, not a quick patch. Use every subagent, skill, and testing tool available to you rather than eyeballing code and declaring it done.

## Mission

NOVA (`nova-monorepo`, "Voice-first personal AI companion," Leadup Technologies) has a solid architecture but the AI companion experience is not actually working end to end, and the UI needs a full redesign. Do not trust old audit documents or your own read of the code as proof something works — the only acceptance criterion is: it works when you actually run the app, speak to it, and watch it respond, on a real device/simulator.

Two existing docs in the repo root, `PRODUCTION_READINESS.md` and `PRODUCTION_READINESS_PLAN.md`, contain a prior audit (dated 2026-08-31). Re-verify every claim in them yourself — some may be stale or already partially fixed — before relying on them.

## Ground rules

- Work in phases, in order. Do not start the visual redesign until the app builds, typechecks, and boots cleanly. Do not declare the AI companion "fixed" from reading the code — prove it by running the app and exercising the feature.
- After every phase, run `pnpm typecheck`, `pnpm build`, `pnpm lint`, and `pnpm test` from the repo root and fix anything red before moving on.
- For anything touching the mobile app's mic, speaker, wake word, avatar rendering, device control, or notifications, verify on an actual Android and iOS build (simulator is acceptable for most of this, but wake word / foreground service needs a physical Android device) — these are exactly the things a code review or a headless test cannot confirm.
- Where you find a stub, a mock fallback (`apps/mobile/src/mock/data.ts`), or a simulated engine standing in for a real one, replace it with the real thing rather than polishing the simulation.
- Use the Figma MCP tools for all design work, not hand-rolled mockups. Use the Playwright e2e suite already in `tests/e2e/` for automated regression, and add to it as you fix things.

## Phase 1 — Get to a clean, honest baseline

The prior audit lists these as build-blocking. Confirm each is actually still broken, then fix:

1. `@nova/auth` has no real export map — `packages/auth/src/index.ts` needs to export `authMiddleware`/`authenticateJwt`, `signAccessToken`, `signRefreshToken`, `verifyRefreshToken`, `hashPassword`, `verifyPassword`, and the `AuthenticatedRequest` type; `packages/auth/package.json` needs an `exports` map. Every service importing `@nova/auth` should resolve cleanly.
2. TypeScript errors across `services/admin`, `packages/memory` (`store.ts`, `search.ts`, `embedding.ts`, `extraction.ts` — bad import paths from `drizzle-orm`, missing `MemoryStatus` enum values), and `services/workflow-engine` (generic `Map<string, JobDefinition<any, any>>` typing). Run `pnpm -r typecheck` and clear every error, don't just silence them with `any`.
3. Environment validation is missing — add a zod schema validated at startup for `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `REDIS_URL`, and whatever else each service actually requires, so a missing var fails fast and loud instead of crashing mysteriously later.
4. Database migrations — confirm there's a real, runnable migration path (drizzle-kit or equivalent), not just a schema file with nothing to apply it.
5. CI (`.github/workflows/ci.yml`, `ci-cd.yml`) currently doesn't gate on typecheck/lint/test — wire it up so broken code can't merge.

Do not proceed to Phase 2 until `pnpm build` and `pnpm -r typecheck` are fully green and the app actually starts via `docker-compose.dev.yml` / `pnpm dev`.

## Phase 2 — Complete screen redesign via the Figma design MCP

The mobile app (`apps/mobile`, Expo + React Native 0.86 + NativeWind + Reanimated + Skia) has these routed screens under `apps/mobile/app/(tabs)/`: `index` (home), `converse` (the main voice/chat companion screen), `device` (device control), `me` (profile), `memory`, `tasks`, `translate`, plus the shared `_layout.tsx`. The underlying screen components live in `apps/mobile/src/screens/` (`DeviceControlScreen.tsx`, `MeScreen.tsx`, `MemoryScreen.tsx`, `TasksScreen.tsx`, `TranslateScreen.tsx`) and there's a component library in `packages/ui` and `apps/mobile/src/components/` (avatar, voice, hud, particles, emotion, premium, translation subfolders) plus the NativeWind theme in `apps/mobile/src/styles/globals.css`.

1. Load the Figma MCP skills (`figma-use` first, then `figma-generate-design` and `figma-code-connect` as needed) before calling any Figma tool.
2. Check whether a NOVA Figma file already exists (ask the user for a link if you can't find one via `get_libraries`/search). If one exists, pull its design context (`get_design_context`, `get_variable_defs`, `get_screenshot`) as the source of truth. If none exists, generate a new, cohesive design system in Figma from the current app (colors, type scale, spacing, the avatar/voice HUD components) — don't invent an unrelated new brand; extract and formalize what's already implied by `packages/ui` and the existing screens, then improve it.
3. Redesign every one of the seven screens listed above as a real, complete flow (not just polish on `converse` and calling it done) — consistent nav, empty/loading/error states for each, and specific attention to the `converse` screen since that's where the avatar, mic state, and conversation live, and to `device` since that's the device-control surface.
4. Implement the redesign back into the RN codebase (design-to-code), keeping `nativewind`/Tailwind tokens in sync with the Figma variables so future changes don't drift.
5. Add error boundaries to both `apps/web` and `apps/mobile` (currently missing per the audit) as part of this pass, plus basic accessibility (labels on interactive elements, contrast) since you're touching every screen anyway.

## Phase 3 — Make the AI companion real, end to end

This is the core complaint: it doesn't speak, doesn't listen, and generally isn't a "live" companion. Go feature by feature and make each one real, then prove it on-device.

**Listening / wake word.** `apps/mobile/src/hooks/useWakeWord.ts` currently hard-blocks anything that isn't Android (`if (Platform.OS !== 'android') return false`), and `apps/mobile/src/modules/wake-word.ts` is a pure-JS timer/state-machine simulation with no real microphone or audio-detection engine behind it — it can't actually hear "Hey NOVA" today. Replace it with a real wake-word/continuous-listening engine (e.g. Picovoice Porcupine, or a native on-device STT such as Whisper/Vosk streaming into `services/voice-api`), wired to real mic input via a proper native module. Cover iOS too (push-to-talk is an acceptable fallback there if a true always-on wake word isn't feasible, but it must be a real, working fallback, not silently unsupported). This also requires the Android manifest fixes the audit flagged: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` (Android 14+), `POST_NOTIFICATIONS`, a real foreground `WakeWordService`, and the matching iOS `Info.plist` microphone/speech-recognition usage strings.

**Speaking.** Trace the full path from an agent response in `services/agent-orchestrator` → `@nova/voice` (`packages/voice/src/engine.ts`, `transcriber.ts`, `translator.ts`) → `services/voice-api` → the device's TTS output (`expo-speech` is already a dependency). Confirm audio actually plays out of the speaker for a real response, not just that a function returns without throwing.

**Visual avatar.** `@nova/avatar` (`packages/avatar/src/index.ts`) has a genuinely solid viseme/audio-analysis/gesture engine already, and it's wired into `apps/mobile/src/components/AvatarView.tsx` and `useLipSync.ts`. Verify it's rendering live off real microphone/TTS audio (via Skia, given `@shopify/react-native-skia` is a dependency) rather than falling back to `apps/mobile/src/mock/data.ts` — remove any mock-data fallback from the production code path and confirm the mouth/expression actually moves in sync while NOVA is speaking, on device.

**Device control.** `apps/mobile/src/screens/DeviceControlScreen.tsx` and `apps/mobile/src/lib/device-controller.ts` need every listed action to perform a real, permissioned device action (not a stub that just updates local UI state) — verify each one actually does something on the phone.

**Notifications & reminders.** `apps/mobile/src/lib/notification-service.ts`, `apps/mobile/src/modules/reminders.ts`, `apps/mobile/src/modules/proactive-assistant.ts`, and the backend `services/notification-service` need to be verified end to end: creating a reminder actually schedules a real local/push notification via `expo-notifications`, it actually fires at the right time with the device backgrounded, and proactive nudges from `useProactive.ts` actually reach the user. Test this by setting a reminder and waiting for it, not by reading the scheduling code.

## Phase 4 — Test everything end to end

1. Run the existing Playwright suite in `tests/e2e/` — `voice-chat.spec.ts`, `onboarding.spec.ts`, `dashboard.spec.ts`, `tasks.spec.ts`, `settings.spec.ts`, `conversations.spec.ts`, `auth.spec.ts` — and the top-level `tests/*.e2e.test.ts` files. Fix every failure; don't skip or `.only` around red tests.
2. Extend the suite to cover what it's currently missing given this fix pass: the redesigned screens, and whatever of the companion flow can be exercised headlessly (API-level voice pipeline, notification scheduling logic).
3. For the parts Playwright fundamentally can't verify — wake word activating from real speech, TTS being audible, avatar lip-sync visibly matching audio, a scheduled reminder actually notifying, a device-control action actually doing something — do a manual on-device pass and report exactly what you observed for each, not just "should work."
4. Re-run `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm test` one final time, all green.

## Definition of done

- `pnpm build`, `pnpm -r typecheck`, `pnpm lint`, and `pnpm test` all pass clean from a fresh clone.
- Every screen under `apps/mobile/app/(tabs)/` reflects the new Figma-driven design, implemented with synced design tokens, with no broken/mismatched screens left over from the old UI.
- On a real device: saying the wake phrase (or using the verified fallback) actually starts listening; speaking to NOVA produces an audible spoken reply; the avatar visibly lip-syncs to that reply; a device-control action visibly does something on the phone; setting a reminder actually notifies you later.
- The full Playwright e2e suite is green, and you can point to which specific test covers which specific claim above.
- You have a short written note of exactly what you changed and, for each of the five "on a real device" checks above, what you personally observed when you tested it — not an assumption that it works.
