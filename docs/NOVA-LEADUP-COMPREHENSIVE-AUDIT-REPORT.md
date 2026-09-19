# NOVA Leadup — Comprehensive Audit Report

**This file was a 41-byte stub.** It held nothing but this title, while being cited
elsewhere as a primary audit source. Rather than leave a filename that promises an
audit and delivers a heading, it now says what is actually true.

## Where the real audits are

| Document | What it covers |
|---|---|
| [`REQUIREMENTS_VERIFICATION.md`](./REQUIREMENTS_VERIFICATION.md) | Every requirement in the owner's brief and the master document, verified against the running system, with the evidence for each and the gaps stated plainly. **Start here.** |
| `../AUDIT_REPORT.md`, `../AUDIT-REPORT.md`, `../SYNTHESIZED_AUDIT_REPORT.md` | Earlier static audits. They predate the work that made the repository build and are of historical interest only. |
| `../PRODUCTION_READINESS.md`, `../PRODUCTION_READINESS_PLAN.md` | Readiness checklists. |
| [`security/threat-model.md`](./security/threat-model.md) | Threat model. |

## What a genuine audit of this repository found

Recorded here because a stub is not an audit, and so these do not have to be
re-derived:

**Security**
- The production server accepted root SSH by password with no brute-force protection
  and had absorbed **63,475 failed root password attempts in seven days**. Key auth
  was already configured. Now key-only, fail2ban active, password file shredded.
- `packages/memory/src/search.ts` built a pgvector query with `sql.raw()` — an
  unescaped interpolation that would have become an injection point the moment the
  placeholder vector was replaced by a real embedding. Now a bound parameter.
- `drizzle-orm` 0.39.3 carries a high-severity advisory. The exploitable pattern in
  our code is gone and every remaining query is parameterised, so it is not
  reachable; the library upgrade needs a repository-layer migration and is
  deliberately deferred rather than forced.
- `serve-static` decoded percent-escapes once, so double-encoded traversal resolved
  to a literal filename rather than `../`. Now decoded to a fixed point.

**Correctness**
- The repository did not build: 2 of 14 tasks. `tsconfig.base.json` set `noEmit`, so
  nothing was emitted and 17 packages failed. Now 27/27.
- **Every admin route under `/settings` returned 403 for everyone, including the
  owner** — `requireAdmin` was mounted without `authenticate`, so `req.user` was
  never populated.
- `tasks.priority` and `tasks.assigneeId` were required by the API, sent by the
  client, validated, and silently discarded because no columns existed.
- `PATCH /feature-flags/:id` compared a uuid column against `parseInt()` and could
  never succeed for any input.
- 21 tests asserted contracts the product never had; correcting them surfaced five
  further defects.
- Six endpoints reported success while doing nothing, and now answer 501 instead.

**Architecture**
- `@nova/auth`'s entry point called `app.listen()` at module scope. Seventeen files
  across six services import that package, so each import booted a second auth
  server on whatever `PORT` was set.
- Five services in `services/` are dead code, referenced only by a compose file that
  does not run them. The tree also held duplicates: `worker`/`workers`,
  `notifications`/`notification-service`, `api`/`api_disabled`.

## What is still open

- **Cross-platform sync** is not implemented. It needs OAuth client credentials
  registered with Google and Microsoft, which is a business action. The service
  reports `not_configured` honestly rather than pretending.
- **No payment gateway.** The entitlement layer is real and enforced; billing is not.
- **No device verification** for the Android-only features (notification listener,
  device control, call-recording folder). They are compile-verified and unit-tested,
  not exercised on hardware.
- **Weather, evening recap and traffic nudges** are not built and not stubbed — no
  provider exists and the master document does not define them.
