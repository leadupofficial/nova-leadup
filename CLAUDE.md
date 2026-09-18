# NOVA-Leadup — Claude Code

## Project

NOVA is a voice-first personal AI companion monorepo (Leadup Technologies). TypeScript and Node.js with pnpm workspaces (`apps/*`, `services/*`, `packages/*`).

## Rules

- Do what was asked; avoid unrelated changes.
- Prefer editing existing files over creating new ones.
- Do not create documentation unless requested.
- Do not commit secrets, credentials, or `.env` files.
- Keep new files out of the repo root; use `apps/`, `services/`, `packages/`, `src/`, `tests/`, `docs/`, and `config/` as appropriate.
- Read a file before editing it.
- Keep files reasonably small (under ~500 lines when practical).
- Validate input at system boundaries.

## Build and test

After substantive code changes:

```bash
pnpm install
pnpm run build
pnpm test
```

Use `pnpm run lint` and `pnpm run typecheck` when relevant.

These root commands do **not** cover the mobile app, and `@nova/api` does not currently
type-check cleanly (pre-existing errors in `packages/database/src/utils/base-repository.ts`,
`services/api/src/services/ai.ts`, `services/api/src/utils/health.ts`,
`services/api/src/routes/settings.ts`). Verify the API by running it — see below.

## Mobile (`apps/mobile`)

`apps/mobile` is a **Flutter** app. Check `pubspec.yaml` / `lib/` rather than believing
prose: `CURRENT_ARCHITECTURE.md` described it as Expo for a long time, and that stale
claim sent agents chasing React Native problems that do not exist.

The Expo/React Native sources (`app/`, `src/`, `package.json`, `eas.json`,
`app.config.js`, and the Expo-based workflows) are **dead weight and are not built**.
Leftovers in `android/` are what broke the Android build: `MainActivity` extended
`ReactActivity`, `MainApplication` was React Native's, and the manifest had no
`flutterEmbedding` meta-data, so `flutter build apk` aborted with *"Build failed due to
use of deleted Android v1 embedding."* Do not reintroduce them.

```bash
cd apps/mobile
flutter analyze                                          # must be clean
flutter test                                             # 153 tests, 2 skipped
flutter build apk --debug --target-platform android-arm64
```

### JDK — required, and not on PATH

`java` is **not on your PATH**, so every Gradle/Flutter Android build fails with
*"Unable to locate a Java Runtime"* until you export a JDK. AGP 9.1 + Gradle 9.3.1 need
JDK 17+; 21 is verified:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"
```

Note there are **two Android SDK installs** (`~/Library/Android/sdk` and
`/Volumes/External/Android Studio/SDK`). Use the former; an emulator launched from the
latter squats a port and makes `adb` report confusing offline devices.

## Local development

```bash
# 1. Postgres + pgvector on port 5433, user nova_user
bash packages/database/scripts/start-pgvector.sh

# 2. Apply the canonical schema (40 tables). Required — booting no longer migrates.
DATABASE_URL=postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova \
  pnpm --filter @nova/database migrate

# 3. API on :3001 (reads services/api/.env)
cd services/api && npx tsx src/server.ts
```

Things that will otherwise cost an hour:

- `DATABASE_URL` is the single source of truth for the database. `packages/database/drizzle/*.sql`
  and `packages/database/src/schema.ts` are canonical; the old `src/migrations/*.ts` set was
  **deleted** because its schema contradicted `schema.ts` (`users.display_name` vs
  `users.name`, `sessions.token_hash` vs `sessions.refresh_token_hash`).
- Auto-migration on API boot was removed deliberately. Run `pnpm db:migrate` as a deploy step.
- The refresh secret is `JWT_REFRESH_SECRET` (aliases accepted); access tokens live 15 min and
  the mobile client refreshes them automatically.
- `https://api.nova.leadup.tech` is **not reachable**, and release builds target it. For
  on-device testing build debug with `--dart-define=API_URL=http://localhost:3001` and run
  `adb reverse tcp:3001 tcp:3001`.

## Verifying auth work

```bash
# API end-to-end, 24 checks (paces itself around the 10 req/min auth rate limit)
python3 services/api/scripts/verify-auth.py

# The real Dart client against a live API (needs NOVA_LIVE_API=1)
cd apps/mobile
NOVA_LIVE_API=1 flutter test --dart-define=API_URL=http://127.0.0.1:3001 \
  test/integration/auth_live_test.dart
```
