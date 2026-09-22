# Admin Login Flow — Auth Audit

**Date:** 2026-09-09 
**Scope:** `apps/admin` login flow vs `services/api` and `services/auth` backends 
**Auditor:** Security/Identity Engineering 
**Read-only audit — no code modified**

---

## 1. Client-Side Login Flow

### Files examined

| File | Role |
|---|---|
| `apps/admin/src/app/login/page.tsx` | Server component wrapper; renders `LoginForm` |
| `apps/admin/src/app/login/LoginForm.tsx` | Form; collects `email` + `password`; calls `adminLogin()` |
| `apps/admin/src/lib/api.ts` | API client; stores/reads token; attaches Bearer header |
| `apps/admin/src/lib/env.ts` | Reads `NEXT_PUBLIC_API_BASE` (defaults to `http://localhost:3000`) |

### Login flow step-by-step

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Admin Login Token Flow │
├──────────────┬──────────────────────────────────────────────────────────┤
│ 1. FORM │ LoginForm.handleSubmit() │
│ │ POST /auth/login │
│ │ Body: { email, password } │
│ │ Header: Content-Type: application/json │
├──────────────┼──────────────────────────────────────────────────────────┤
│ 2. STORE │ localStorage.setItem('admin_token', accessToken) │
│ │ Key: 'admin_token' │
│ │ No expiry metadata stored separately │
│ │ No refreshToken persisted │
├──────────────┼──────────────────────────────────────────────────────────┤
│ 3. USE │ Every API call reads token from localStorage │
│ │ Header: Authorization: Bearer <admin_token> │
│ │ (api.ts line 151) │
├──────────────┼──────────────────────────────────────────────────────────┤
│ 4. FAIL │ Non-2xx → throw Error() → show in UI │
│ │ No auto-redirect to login │
│ │ Token NOT cleared from localStorage │
└──────────────┴──────────────────────────────────────────────────────────┘
```

### Login endpoint contract

```typescript
// Client sends
POST /auth/login
Body: { email: string, password: string }

// Client expects response shape
{
 success: true,
 data: {
 user: { id, email, name, locale, timezone },
 accessToken: string,
 refreshToken: string // <-- received but NEVER stored or used
 }
}
```

**Source:** `apps/admin/src/lib/api.ts` lines 201-209 (`adminLogin`).

---

## 2. Backend Authentication Services — Two Systems

There are **two separate auth implementations** in this repository. They are NOT the same service.

### 2a. `services/api/src/routes/auth.ts` (port 3001)

| Property | Value |
|---|---|
| Algorithm | HS256 (symmetric, shared secret) |
| Secret source | `process.env.JWT_SECRET` (falls back to `'change-me-in-production'`) |
| Access token payload | `{ sub, email, sessionId, type: 'access' }` |
| Refresh token payload | `{ sub, sessionId, type: 'refresh' }` |
| Default TTL | 15 minutes |
| `/auth/login` response | `{ success, data: { user, accessToken, refreshToken } }` |
| `/auth/logout` | **Exists** — revokes session in DB |
| `/auth/refresh` | **Exists** — rotates access + refresh tokens |
| `/auth/session` | **Exists** — validates current session |

### 2b. `services/auth/src/routes/authRoutes.ts` (port 3003)

| Property | Value |
|---|---|
| Algorithm | RS256 (asymmetric, key pair at `services/auth/keys/`) |
| Key paths | `keys/private.pem` (sign), `keys/public.pem` (verify) |
| Access token payload | `{ sub, orgId, workspaceId, role, email }` |
| Refresh token | Opaque UUID (NOT a JWT) |
| Default TTL | 15 minutes |
| `/auth/login` response | `{ user, tokens: { accessToken, refreshToken, expiresIn } }` |
| `/auth/logout` | **Does NOT exist** |
| `/auth/refresh` | **Exists** — rotates opaque refresh token |

### 2c. Admin client's actual target — UNCERTAIN

| Factor | Value |
|---|---|
| `NEXT_PUBLIC_API_BASE` default | `http://localhost:3000` |
| `services/api` port | **3001** |
| `services/auth` port | **3003** |
| Neither service | runs on port 3000 |
| `services/api/index.ts` | does NOT mount `/auth` routes (commented out / omitted) |
| `services/auth/index.ts` | mounts `/auth` routes on port 3003 |

**Conclusion:** By default, the admin client points at port 3000 where no auth service runs. If `NEXT_PUBLIC_API_BASE` is configured to hit `services/auth` (port 3003), the response shape from `services/auth/login` is:

```json
{ "user": {...}, "tokens": { "accessToken": "...", "refreshToken": "...", "expiresIn": 900 } }
```

But `adminLogin()` reads `raw.data.user`, `raw.data.accessToken`, `raw.data.refreshToken` — those are at `raw.data.tokens.accessToken` in the `services/auth` response. **This is a response-shape mismatch.**

If pointed at `services/api` (port 3001), the shape matches, but that service's auth is not mounted in its `index.ts`.

---

## 3. Backend JWT Middleware Expectations

### File: `services/auth/src/middleware.ts` — `authenticateJwt`

```typescript
// Required header format:
Authorization: Bearer <RS256 JWT>

// Extracts token from header (line 48):
const token = authHeader.slice(7); // strips "Bearer "

// Verifies token (line 49):
const payload = verifyAccessToken(token); // RS256 by default

// Expects these claims in the JWT payload:
{
 sub: string, // user ID
 orgId: string, // organization ID
 workspaceId: string, // workspace ID
 role: string, // e.g. 'member', 'owner'
 email: string
}

// Then does session look-up:
const session = await findSessionByToken(token); // token must be in DB
```

**** The middleware expects RS256-signed JWTs with `orgId`, `workspaceId`, and `role` claims. It also cross-checks the token against the sessions table.

---

## 4. Endpoint-by-Endpoint Comparison

### 4.1 `POST /auth/login`

| Aspect | Admin Client | `services/api` (port 3001) | `services/auth` (port 3003) |
|---|---|---|---|
| **Request body** | `{ email, password }` | `{ email, password }` ✅ | `{ email, password }` ✅ |
| **Response shape** | `{ success, data: { user, accessToken, refreshToken } }` | `{ success, data: { user, accessToken, refreshToken } }` ✅ | `{ user, tokens: { accessToken, refreshToken, expiresIn } }` ❌ |
| **Token algorithm** | — | HS256 | RS256 |
| **Token claims** | — | `{ sub, email, sessionId, type }` | `{ sub, orgId, workspaceId, role, email }` |
| **Mounted?** | — | ❌ (not in `services/api/index.ts`) | ✅ |
| **Login routes mounted?** | — | ❌ | ✅ |

### 4.2 `POST /auth/refresh`

| Aspect | Admin Client | `services/api` | `services/auth` |
|---|---|---|---|
| **Sends request?** | ❌ No — refreshToken is received but never stored or used | ✅ | ✅ |
| **Body** | — | `{ refreshToken }` | `{ refreshToken }` |
| **Response** | — | `{ success, data: { accessToken, refreshToken } }` | `{ accessToken, refreshToken, expiresIn }` |

### 4.3 `POST /auth/logout`

| Aspect | Admin Client | `services/api` | `services/auth` |
|---|---|---|---|
| **Sends request?** | ❌ No logout button/handler exists anywhere in admin app | ✅ Exists | ❌ Does not exist |
| **Effect** | — | Revokes session in DB | — |

### 4.4 Token in `Authorization` header

| Aspect | Admin Client | `services/api` middleware | `services/auth` middleware |
|---|---|---|---|
| **Header format** | `Authorization: Bearer <token>` ✅ | ✅ | ✅ |
| **Algorithm accepted** | — | HS256 only | RS256 only (default) |
| **Required claims** | — | `{ sub, email, sessionId, type: 'access' }` | `{ sub, orgId, workspaceId, role, email }` |
| **Session DB check** | — | ✅ (`sessions` table) | ✅ (`sessions` table) |

---

## 5. Token Flow Diagram (Text)

```
┌──────────────┐ 1. POST {email,pwd} ┌───────────────────┐
│ LoginForm │ ───────────────────────────► │ /auth/login │
│ (client) │ │ (backend) │
└──────┬───────┘ └────────┬──────────┘
 │ │
 │ 2. { user, accessToken, refreshToken } │
 │ ◄──────────────────────────────────────────────┘
 │
 │ 3. localStorage.setItem('admin_token', accessToken)
 │ (refreshToken is DISCARDED)
 │
 ▼
┌──────────────┐ 4. GET /admin/users ┌────────────┐
│ Any admin │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►│ Backend │
│ page │ Authorization: Bearer <token> │ │
│ │ └─────┬──────┘
└──────────────┘ │
 ▲ │
 │ 5. 401 if token expired (15 min) │
 │ ERROR: adminLogin() throws ←─── 401 │
 │ Token stays in localStorage │
 │ User stays on broken page │
 │ (no redirect to login) │
 │ │
 │ 6. NEVER CALLED: │
 │ POST /auth/refresh ←─ refreshToken lost │
 │ POST /auth/logout ←─ no handler exists │
 ▼ ▼
 ┌──────────────┐ (token leaked
 │ Stale │ in localStorage
 │ localStorage │ until browser
 │ forever │ close/clear)
 └──────────────┘
```

---

## 6. Gaps Found

### 🔴 CRITICAL — G1: Response shape mismatch between admin client and `services/auth`

| Field | Detail |
|---|---|
| **Severity** | CRITICAL |
| **Files** | `apps/admin/src/lib/api.ts:201-209` vs `services/auth/src/routes/authRoutes.ts:128-131` |
| **What** | The admin client's `adminLogin()` reads `raw.data.user` and `raw.data.accessToken`. The `services/auth` login endpoint returns `{ user, tokens: { accessToken, refreshToken, expiresIn } }` — the access token is nested under `data.tokens`, not `data.accessToken`. If `NEXT_PUBLIC_API_BASE` points at `services/auth` (port 3003), the login will fail with `'Login failed: unexpected response from server'`. |
| **Impact** | Admin login is broken when targeting the auth service that actually has the RS256 login routes mounted. |
| **Fix** | Update `adminLogin()` to unwrap the correct path: `raw.data.tokens.accessToken` and `raw.data.tokens.refreshToken`. Or, make the backend return a uniform shape across both auth services. |

### 🔴 CRITICAL — G2: No token expiry / refresh handling in admin app

| Field | Detail |
|---|---|
| **Severity** | CRITICAL |
| **Files** | `apps/admin/src/lib/api.ts:149-152`, `apps/admin/src/app/login/LoginForm.tsx:14-30` |
| **What** | Access tokens expire after 15 minutes (both services). The admin app: (a) receives `refreshToken` but never stores it, (b) never calls `POST /auth/refresh`, (c) on 401 throws an error but does not clear `localStorage` or redirect to `/login`, (d) no token expiry check before API calls. |
| **Impact** | Admin session silently dies after 15 minutes. User is stuck on a broken page with a stale token. No automatic re-authentication. |
| **Fix** | (1) Store `refreshToken` alongside `accessToken` in localStorage. (2) Implement a token expiry check: parse the JWT `exp` claim and refresh proactively before expiry. (3) On 401/403 responses, clear `admin_token` and redirect to `/login`. (4) Add a React context/provider that wraps authenticated API calls with auto-refresh. |

### 🔴 CRITICAL — G3: No logout endpoint call — token lives forever in localStorage

| Field | Detail |
|---|---|
| **Severity** | CRITICAL |
| **Files** | `apps/admin/src/` (no logout UI exists), `services/auth/src/routes/authRoutes.ts` (no `/auth/logout`), `services/api/src/routes/auth.ts:188-209` (`/auth/logout` exists only here) |
| **What** | The admin app has no logout button, no logout handler, no logout page. The RS256 auth service (`services/auth`) has no `/auth/logout` endpoint at all. If the admin targets the HS256 service (`services/api`), logout exists in the backend but is never called. The token persists in `localStorage` indefinitely — surviving tab close, browser restart, and session timeout. |
| **Impact** | Shared-terminal / kiosk / XSS risk: any subsequent browser session reuses the stale token. Server-side session is never invalidated. |
| **Fix** | (1) Add a logout button in the admin sidebar/layout. (2) Add `POST /auth/logout` to `services/auth` (RS256) to revoke the session by token. (3) On logout: call the endpoint, then `localStorage.removeItem('admin_token')`, then redirect to `/login`. (4) Consider httpOnly cookies with `SameSite` instead of localStorage for reduced XSS exposure. |

### 🟠 HIGH — G4: `NEXT_PUBLIC_API_BASE` defaults to port 3000 — no service runs there

| Field | Detail |
|---|---|
| **Severity** | HIGH |
| **Files** | `apps/admin/src/lib/env.ts:11-14`, `apps/admin/src/lib/api.ts:119` |
| **What** | The default API base is `http://localhost:3000`. `services/auth` runs on 3003, `services/api` runs on 3001. Port 3000 has no auth service. Unless an explicit `NEXT_PUBLIC_API_BASE` env var is set, all admin API calls hit a dead endpoint. |
| **Impact** | Admin login and all API calls fail with connection errors in any fresh deployment. |
| **Fix** | Set `NEXT_PUBLIC_API_BASE=http://localhost:3003` (or the correct auth service port) in the admin app's `.env.local` / deployment config. Document the required value. |

### 🟠 HIGH — G5: Dual auth systems with incompatible token formats

| Field | Detail |
|---|---|
| **Severity** | HIGH |
| **Files** | `services/api/src/routes/auth.ts` (HS256) vs `services/auth/src/routes/authRoutes.ts` (RS256) |
| **What** | Two independent auth services exist. `services/api` uses HS256 with payload `{ sub, email, sessionId, type }`. `services/auth` uses RS256 with payload `{ sub, orgId, workspaceId, role, email }`. The admin `authenticateJwt` middleware in `services/auth` expects RS256 tokens with `orgId`/`workspaceId`/`role` claims. If an HS256 token from `services/api` is presented to the RS256 middleware, verification fails. The admin client has no way to know which service to target. |
| **Impact** | If admin is pointed at `services/api` (HS256) but protected routes are in `services/auth` (RS256), every authenticated request fails with 401. Cross-service token portability is impossible. |
| **Fix** | Consolidate to a single auth service. If both must coexist: (1) make the token format interoperable (shared claim set), (2) document the canonical auth endpoint the admin client must target, (3) update `NEXT_PUBLIC_API_BASE` to point unambiguously. |

### 🟠 HIGH — G6: `services/api` login not mounted in its own server

| Field | Detail |
|---|---|
| **Severity** | HIGH |
| **Files** | `services/api/src/index.ts` |
| **What** | `services/api/src/routes/auth.ts` defines `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/session` — but `services/api/src/index.ts` never mounts `authRoutes`. These routes exist only as dead code. |
| **Impact** | If `NEXT_PUBLIC_API_BASE` is set to `services/api` (port 3001), login returns 404. |
| **Fix** | Either mount `authRoutes` in `services/api/src/index.ts` or remove the dead routes. |

### 🟡 MEDIUM — G7: Token stored in plain `localStorage` (XSS risk)

| Field | Detail |
|---|---|
| **Severity** | MEDIUM |
| **Files** | `apps/admin/src/app/login/LoginForm.tsx:21`, `apps/admin/src/lib/api.ts:103-112` |
| **What** | The JWT access token is stored in `window.localStorage` under the key `admin_token`. Any XSS vulnerability in the admin panel (e.g., via a future admin API that returns unsanitized HTML) would allow an attacker to exfiltrate the token. |
| **Impact** | Token theft → full admin access until expiry (15 min) or manual logout. |
| **Fix** | Use httpOnly, Secure, SameSite cookies for token storage. If localStorage is required, implement short-lived access tokens (5 min) + aggressive refresh, and add a Content-Security-Policy header. |

### 🟡 MEDIUM — G8: No role-based access control in admin client

| Field | Detail |
|---|---|
| **Severity** | MEDIUM |
| **Files** | `apps/admin/src/app/layout.tsx`, `apps/admin/src/app/page.tsx` |
| **What** | The admin app has `AdminUser.role` in its types, but there is no auth guard on any admin page or route. The layout does not check `admin_token` before rendering admin content. Anyone who obtains a valid token (even a regular `member` role) gets full admin UI access. The admin API endpoints (`/admin/users`, `/admin/organizations`, etc.) are also not implemented in either backend. |
| **Impact** | No enforcement of admin-only access. Role is passed in the JWT but never checked client-side or server-side. |
| **Fix** | (1) Add a layout guard that checks for `admin_token` and redirects to `/login` if missing. (2) After login, verify the user's role is `admin` or `owner` before rendering admin pages. (3) Implement backend admin routes with `requireRole('owner')` middleware. |

### 🟡 MEDIUM — G9: OTP codes logged to console (credential leak)

| Field | Detail |
|---|---|
| **Severity** | MEDIUM |
| **Files** | `services/auth/src/routes/authRoutes.ts:163` |
| **What** | `console.log(\`[OTP] SMS to ${parsed.phoneNumber}: ${otp}\`)` — the plaintext OTP is logged to stdout. In production, this leaks to log aggregation systems (Datadog, CloudWatch, etc.). |
| **Fix** | Remove the `console.log`. OTPs should never appear in logs. |

### 🟡 MEDIUM — G10: Password reset tokens logged to console

| Field | Detail |
|---|---|
| **Severity** | MEDIUM |
| **Files** | `services/auth/src/routes/authRoutes.ts:243` |
| **What** | `console.log(\`[PASSWORD_RESET] Token for ${user.email}: ${resetToken}\`)` — plaintext password reset tokens in logs. |
| **Fix** | Remove the `console.log`. |

### 🟡 MEDIUM — G11: `services/api` default JWT secret is a placeholder

| Field | Detail |
|---|---|
| **Severity** | MEDIUM |
| **Files** | `services/api/src/routes/auth.ts:31` |
| **What** | `const accessSecret = process.env.JWT_SECRET || 'change-me-in-production'` — if `JWT_SECRET` is unset, the app signs tokens with a well-known hardcoded secret. Any attacker can forge valid access tokens. |
| **Fix** | Fail at startup if `JWT_SECRET` is missing, instead of falling back to a known value. |

### 🟢 LOW — G12: `expiresIn` returned by login but never used by admin client

| Field | Detail |
|---|---|
| **Severity** | LOW |
| **Files** | `apps/admin/src/lib/api.ts:198`, `services/auth/src/routes/authRoutes.ts:130` |
| **What** | `services/auth` login returns `expiresIn: 900` (15 minutes). The admin client's `AdminLoginResult` type includes `expiresIn?` but never reads it. Combined with no refresh logic, this means the client has no timing information for token renewal. |
| **Fix** | Store `expiresIn` alongside the token and use it to schedule pre-emptive refresh. |

---

## 7. Summary Table

| # | Gap | Severity | Location |
|---|---|---|---|
| G1 | Response shape mismatch (admin client vs `services/auth` login response) | 🔴 CRITICAL | `api.ts:206` vs `authRoutes.ts:128` |
| G2 | No token expiry / refresh handling | 🔴 CRITICAL | `api.ts`, `LoginForm.tsx` |
| G3 | No logout — token persists in localStorage forever | 🔴 CRITICAL | `services/auth` (no route), `apps/admin` (no handler) |
| G4 | `NEXT_PUBLIC_API_BASE` defaults to port 3000 (no service there) | 🟠 HIGH | `env.ts:12-14` |
| G5 | Dual auth systems with incompatible token formats | 🟠 HIGH | `services/api/auth.ts` vs `services/auth/authRoutes.ts` |
| G6 | `services/api` auth routes defined but not mounted | 🟠 HIGH | `services/api/src/index.ts` |
| G7 | Token in plain localStorage (XSS exposure) | 🟡 MEDIUM | `LoginForm.tsx:21`, `api.ts:108` |
| G8 | No RBAC enforcement in admin client | 🟡 MEDIUM | Admin layout/pages |
| G9 | OTP code logged to console | 🟡 MEDIUM | `authRoutes.ts:163` |
| G10 | Password reset token logged to console | 🟡 MEDIUM | `authRoutes.ts:243` |
| G11 | `services/api` falls back to placeholder JWT secret | 🟡 MEDIUM | `services/api/src/routes/auth.ts:31` |
| G12 | `expiresIn` returned but never consumed | 🟢 LOW | `api.ts:198` |

---

## 8. Recommended Fix Priority Order

1. **Fix G1** (response shape) — unblocks login entirely.
2. **Fix G2** (token expiry/refresh) — prevents silent session death.
3. **Fix G3** (logout) — prevents indefinite token persistence.
4. **Fix G4** (API base default) — required for any deployment.
5. **Fix G5 + G6** (consolidate auth) — architectural cleanup to eliminate dual-system confusion.
6. **Fix G7** (localStorage → httpOnly cookies) — production hardening.
7. **Fix G8** (RBAC in admin UI) — access control.
8. **Fix G9 + G10** (remove console.log of secrets) — quick win.
9. **Fix G11** (fail on missing JWT_SECRET) — quick win.
10. **Fix G12** (use expiresIn) — polish.
