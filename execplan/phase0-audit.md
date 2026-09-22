# Phase 0 — NOVA Architecture and Repository Audit (ExecPlan)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

If PLANS.md file is checked into the repo, reference the path to that file here from the repository root and note that this document must be maintained in accordance with PLANS.md.

PLANS.md path: `PLANS.md` (if present in repo root; otherwise follow the standard ExecPlan methodology from the skill).

## Purpose / Big Picture

Explain in a few sentences what someone gains after this change and how they can see it working. State the user-visible behavior you will enable.

This ExecPlan guides a complete Phase 0 audit of the NOVA-Leadup repository before any migration or feature work begins. After completion, a reader will understand the current state of the codebase, the health of the backend build pipeline, the structure of the mobile app, the licensing and architecture of six external research repositories, and the recommended path for migrating from Expo/React Native to Flutter. The deliverable is a set of documentation files under `docs/` that future engineers can use to make informed decisions without repeating this research.

## Progress

Use a list with checkboxes to summarize granular steps. Every stopping point must be documented here, even if it requires splitting a partially completed task into two ("done" vs. "remaining"). This section must always reflect the actual current state of the work.

- [x] (2026-09-06 13:15 IST) Run backend typecheck, lint, and build commands. Document exact errors.
- [x] (2026-09-06 13:15 IST) Map monorepo directory structure: apps/, services/, packages/, infrastructure/, docs/.
- [x] (2026-09-06 13:15 IST) Inspect mobile app: Expo/React Native state, Android/iOS folders, key gaps.
- [x] (2026-09-06 13:15 IST) Write `docs/NOVA_ARCHITECTURE_AUDIT.md` with current-state findings.
- [x] (2026-09-06 13:15 IST) Analyze all six external repositories: license, architecture, features, recommended action.
- [x] (2026-09-06 13:15 IST) Write `docs/REPOSITORY_DECISIONS.md` with reuse decisions and rationale.
- [x] (2026-09-06 13:15 IST) Write `docs/AVATAR_REPOSITORY_ANALYSIS.md` with avatar-specific findings.
- [x] (2026-09-06 13:15 IST) Write `docs/VOICE_REPOSITORY_ANALYSIS.md` with voice-specific findings.
- [x] (2026-09-06 13:15 IST) Write `docs/ANDROID_ASSISTANT_REPOSITORY_ANALYSIS.md` with native Android findings.
- [x] (2026-09-06 13:15 IST) Write `docs/NOVA_RESEARCH_MATRIX.md` with feature comparison table.
- [x] (2026-09-06 13:15 IST) Write `docs/FLUTTER_MIGRATION_ANALYSIS.md` with phased migration plan.
- [x] (2026-09-06 13:30 IST) Create `execplan/phase0-audit.md` as the canonical ExecPlan for Phase 0.
- [ ] (pending) Verify backend test results (not yet run during audit).
- [ ] (pending) Verify mobile app build status (Expo build not yet attempted).
- [ ] (pending) Obtain explicit permission from Jarvis-AI-Assistant author before any code study beyond README.
- [ ] (pending) Obtain explicit permission from DeVA author before any code study beyond README.

## Surprises & Discoveries

Document unexpected behaviors, bugs, optimizations, or insights discovered during implementation. Provide concise evidence.

- Observation: The repo analysis subagent reported Hark as "USE DIRECTLY" while the detailed analysis showed it should be "ADAPT CONCEPT" for most code (only platform bridge boilerplate is directly reusable under Apache 2.0).
 Evidence: `docs/repo-analysis.md` line 286 says "USE DIRECTLY" but the actual reusable surface is limited to platform bridge pattern; the OACP-specific code is not applicable to NOVA.
- Observation: TypeScript errors in `agent-orchestrator` and `integration-service` both stem from a missing `@nova/auth` workspace package export, not from individual package bugs.
 Evidence: `pnpm run typecheck` output shows `TS2307: Cannot find module '@nova/auth'` in both services.
- Observation: ESLint v9 flat config migration is incomplete across the entire monorepo. Every service fails lint due to missing `eslint.config.js` files.
 Evidence: `pnpm run lint` output shows 12 services failing with "ESLint couldn't find an eslint.config.(js|mjs|cjs) file."
- Observation: The `avatar` package in the monorepo is a complete stub with no implementation, despite being listed as a workspace package.
 Evidence: `packages/avatar/src/stub.ts` exists with no real avatar logic.
- Observation: The repo contains multiple temporary Python and JavaScript scripts in the root directory (`.tmp_*.py`, `.tmp_*.mjs`, `fix_*.py`) suggesting prior debugging sessions were not cleaned up.
 Evidence: `ls /Volumes/External/github-projects/NOVA-Leadup/.tmp_*` and `fix_*.py` files in root.

## Decision Log

Record every decision made while working on the plan in the format:

- Decision: ...
 Rationale: ...
 Date/Author: ...

- Decision: Treat Jarvis-AI-Assistant and DeVA as REFERENCE ONLY despite their architectural value.
 Rationale: Both have non-permissive licenses (All Rights Reserved, Personal Use License). NOVA-Leadup is a commercial product. Code cannot be copied, vendored, or forked without explicit permission. Architectural concepts can still inform design.
 Date/Author: 2026-09-06 / Phase 0 Audit

- Decision: Use Rive Flutter as the primary avatar runtime.
 Rationale: MIT licensed, production-ready, official Flutter runtime, 1.5k stars, active maintenance. No other Flutter-compatible avatar runtime exists in the research set.
 Date/Author: 2026-09-06 / Phase 0 Audit

- Decision: Keep Sarvam behind the backend voice API, never expose keys to Flutter.
 Rationale: Master prompt explicitly states this. Backend abstraction allows swapping STT/TTS providers without app updates.
 Date/Author: 2026-09-06 / Phase 0 Audit

- Decision: Use Porcupine for wake-word detection, not openWakeWord.
 Rationale: Porcupine is commercial-grade, has better accuracy, supports custom keywords ("Hey NOVA"), and is used by DeVA (a reference repo). Hark's openWakeWord is open-source but less accurate.
 Date/Author: 2026-09-06 / Phase 0 Audit

- Decision: Proceed with phased migration, not big-bang.
 Rationale: Backend is partially unstable (typecheck failures). Phased migration allows parallel operation, reduces risk, and enables incremental testing.
 Date/Author: 2026-09-06 / Phase 0 Audit

- Decision: Create `apps/mobile-flutter/` alongside `apps/mobile/`, not replace it.
 Rationale: Allows parallel development, testing, and gradual migration. Expo app remains functional during Flutter development.
 Date/Author: 2026-09-06 / Phase 0 Audit

- Decision: Adapt Hark's platform bridge pattern (Pigeon-based MethodChannel/EventChannel).
 Rationale: Apache 2.0 license allows code reuse with attribution. Hark is the closest architectural match to NOVA's Flutter + Kotlin requirements.
 Date/Author: 2026-09-06 / Phase 0 Audit

## Outcomes & Retrospective

Summarize outcomes, gaps, and lessons learned at major milestones or at completion. Compare the result against the original purpose.

- (2026-09-06) Phase 0 documentation complete. Five documents written: NOVA_ARCHITECTURE_AUDIT.md, REPOSITORY_DECISIONS.md, AVATAR_REPOSITORY_ANALYSIS.md, VOICE_REPOSITORY_ANALYSIS.md, ANDROID_ASSISTANT_REPOSITORY_ANALYSIS.md, NOVA_RESEARCH_MATRIX.md, FLUTTER_MIGRATION_ANALYSIS.md. Gaps: backend tests not yet run, mobile build not yet verified, Jarvis/DeVA author permissions not yet obtained. Lesson: License checks must happen before any code study, not after.

## Context and Orientation

Describe the current state relevant to this task as if the reader knows nothing. Name the key files and modules by full path. Define any non-obvious term you will use. Do not refer to prior plans.

NOVA-Leadup is a pnpm/Turbo monorepo at `/Volumes/External/github-projects/NOVA-Leadup/`. It contains:
- `apps/mobile/` — an Expo/React Native app with Android/iOS native folders, Expo Router, and NativeWind styling.
- `apps/admin/` — a Next.js admin panel.
- `services/` — 10 backend services (api, auth, agent-orchestrator, voice-api, realtime-gateway, notification-service, integration-service, worker, workers, workflow-engine).
- `packages/` — 13 shared packages (ai-core, auth-types, avatar, config, database, memory, observability, policy, shared-types, tools, types, ui, utils, voice).
- `infrastructure/` — Docker Compose files, Kubernetes manifests, Terraform IaC, Nginx configs.
- `docs/` — API docs, architecture docs, security docs, operations runbooks.
- `tests/` — Playwright E2E tests with Page Object Models.

Key terms:
- "Phase 0" refers to the pre-migration audit phase defined in the master prompt.
- "Companion Loop" refers to the voice-first interaction cycle: wake → listen → STT → Claude → tool → TTS → avatar.
- "Rive" is a real-time interactive animation tool and runtime; "Rive Flutter" is the official Flutter package.
- "OACP" is the Open App Capability Protocol, used by Hark for app capability discovery.

## Plan of Work

Describe, in prose, the sequence of edits and additions. For each edit, name the file and location (function, module) and what to insert or change. Keep it concrete and minimal.

This ExecPlan produces documentation only. No source code changes are made in Phase 0. The work is:

1. Run backend verification commands and capture output.
2. Map the repository structure and identify key files.
3. Inspect the mobile app architecture and identify gaps.
4. Write `docs/NOVA_ARCHITECTURE_AUDIT.md` with findings.
5. Analyze six external repositories for license, architecture, and feature compatibility.
6. Write `docs/REPOSITORY_DECISIONS.md` with reuse decisions.
7. Write specialized analysis docs for avatar, voice, and Android assistant repositories.
8. Write `docs/NOVA_RESEARCH_MATRIX.md` with feature comparison.
9. Write `docs/FLUTTER_MIGRATION_ANALYSIS.md` with migration strategy.
10. Create this ExecPlan file.

## Concrete Steps

State the exact commands to run and where to run them (working directory). When a command generates output, show a short expected transcript so the reader can compare. This section must be updated as work proceeds.

```bash
# Step 1: Run backend typecheck
cd /Volumes/External/github-projects/NOVA-Leadup
pnpm run typecheck 2>&1 | tee /tmp/nova-typecheck.log

# Expected: 12 successful, 18 total; 2 failures in agent-orchestrator and integration-service

# Step 2: Run backend lint
pnpm run lint 2>&1 | tee /tmp/nova-lint.log

# Expected: 0 successful, 12 total; all fail due to missing ESLint flat config

# Step 3: Map directory structure
find . -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/pnpm-lock*' -not -path '*/.turbo/*' | sort > /tmp/nova-files.txt

# Step 4: Inspect mobile app
ls -la apps/mobile/
cat apps/mobile/package.json
cat apps/mobile/tsconfig.json

# Step 5: Create documentation files
# (Files created via write_file tool)

# Step 6: Verify docs created
ls -la docs/
```

## Validation and Acceptance

Describe how to start or exercise the system and what to observe. Phrase acceptance as behavior, with specific inputs and outputs. If tests are involved, say "run <project's test command> and expect <N> passed; the new test <name> fails before the change and passes after". State the exact test commands appropriate to the project's toolchain and how to interpret their results.

Phase 0 acceptance criteria:
- `docs/NOVA_ARCHITECTURE_AUDIT.md` exists and contains: directory layout, build results, backend inventory, mobile state, infrastructure gaps.
- `docs/REPOSITORY_DECISIONS.md` exists and contains: license classification for all 6 repos, recommended action for each, decision log.
- `docs/AVATAR_REPOSITORY_ANALYSIS.md` exists and contains: analysis of Rive Flutter and Prometheus Avatar.
- `docs/VOICE_REPOSITORY_ANALYSIS.md` exists and contains: analysis of voice capabilities across all 6 repos.
- `docs/ANDROID_ASSISTANT_REPOSITORY_ANALYSIS.md` exists and contains: analysis of Android assistant architectures.
- `docs/NOVA_RESEARCH_MATRIX.md` exists and contains: feature comparison matrix for all 6 repos.
- `docs/FLUTTER_MIGRATION_ANALYSIS.md` exists and contains: migration strategy, timeline, risk assessment.
- `execplan/phase0-audit.md` exists and is maintained per PLANS.md.
- All documentation is written in Markdown with verified facts and sources.
- No source code is modified during Phase 0.

Verification commands:
```bash
ls -la docs/NOVA_ARCHITECTURE_AUDIT.md docs/REPOSITORY_DECISIONS.md docs/AVATAR_REPOSITORY_ANALYSIS.md docs/VOICE_REPOSITORY_ANALYSIS.md docs/ANDROID_ASSISTANT_REPOSITORY_ANALYSIS.md docs/NOVA_RESEARCH_MATRIX.md docs/FLUTTER_MIGRATION_ANALYSIS.md
# Expected: All 7 files exist

wc -l docs/*.md
# Expected: Each file has substantial content (>100 lines minimum)

grep -r "All Rights Reserved\|Personal Use\|MIT\|Apache 2.0" docs/REPOSITORY_DECISIONS.md docs/repo-analysis.md
# Expected: All 6 licenses classified
```

## Idempotence and Recovery

If steps can be repeated safely, say so. If a step is risky, provide a safe retry or rollback path. Keep the environment clean after completion.

All steps in Phase 0 are read-only and idempotent:
- Running `pnpm run typecheck` / `pnpm run lint` multiple times produces the same output.
- Creating documentation files with `write_file` overwrites existing content; re-running updates in place.
- Directory listing and file inspection are non-destructive.
- No source code is modified.
- No dependencies are installed.
- No secrets are accessed.

If documentation becomes stale, re-run the audit steps and overwrite the files. No rollback is needed since no source changes are made.

## Artifacts and Notes

Include the most important transcripts, diffs, or snippets as indented examples. Keep them concise and focused on what proves success.

Typecheck output (excerpt):
 @nova/agent-orchestrator:typecheck: src/index.ts(17,9): error TS2769: No overload matches this call.
 @nova/agent-orchestrator:typecheck: src/routes/agents.ts(3,33): error TS2307: Cannot find module '@nova/auth'
 @nova/integration-service:typecheck: src/index.ts(17,9): error TS2769: No overload matches this call.
 @nova/integration-service:typecheck: src/routes/index.ts(2,33): error TS2307: Cannot find module '@nova/auth'

Lint output (excerpt):
 @nova/api:lint: ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
 @nova/agent-orchestrator:lint: ESLint couldn't find an eslint.config.(js|mjs|cjs) file.

License classifications:
 Jarvis-AI-Assistant: All Rights Reserved (RESTRICTED)
 DeVA: Personal Use License (RESTRICTED for commercial)
 Hark: Apache 2.0 (PERMISSIVE)
 SannaBot: MIT (PERMISSIVE)
 Rive Flutter: MIT (PERMISSIVE)
 Prometheus Avatar: MIT (PERMISSIVE)

## Interfaces and Dependencies

Be prescriptive. Name the libraries, modules, and services to use and why. Specify the types, traits/interfaces, and function signatures that must exist at the end of the milestone. Prefer stable names and paths such as `crate::module::function` or `package.submodule.Interface`. E.g.:

Phase 0 produces documentation only. No code interfaces are created. The following documentation artifacts must exist at the end of Phase 0:

- `docs/NOVA_ARCHITECTURE_AUDIT.md` — Current state of the repository, build health, infrastructure.
- `docs/REPOSITORY_DECISIONS.md` — License analysis and reuse decisions for all 6 external repos.
- `docs/AVATAR_REPOSITORY_ANALYSIS.md` — Avatar-specific analysis (Rive Flutter, Prometheus Avatar).
- `docs/VOICE_REPOSITORY_ANALYSIS.md` — Voice-specific analysis (all 6 repos).
- `docs/ANDROID_ASSISTANT_REPOSITORY_ANALYSIS.md` — Native Android architecture analysis.
- `docs/NOVA_RESEARCH_MATRIX.md` — Feature comparison matrix.
- `docs/FLUTTER_MIGRATION_ANALYSIS.md` — Phased migration plan with timeline and risk assessment.
- `execplan/phase0-audit.md` — This ExecPlan file.

Dependencies for Phase 0:
- `pnpm` (package manager) — for running build commands.
- `turbo` (build orchestrator) — invoked via pnpm scripts.
- `web_extract` tool — for fetching GitHub repository pages.
- `web_search` tool — for supplementary research.
- `read_file` / `write_file` tools — for creating documentation.

No external APIs, SDKs, or services are required for Phase 0.
