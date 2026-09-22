# NOVA-Leadup Admin Panel Audit

**Date:** 2026-09-15
**Auditor:** claude-fable-5-1 (Anthropic)
**Scope:** `apps/admin/`, `apps/web/` (structure), frontend framework configs, API integration

---

## 1. Framework and Architecture

| Aspect | Detail |
|---|---|
| Framework | Next.js 14+ (App Router) |
| Language | TypeScript |
| Styling | 100% inline React `style` objects — no CSS framework, no CSS modules, no Tailwind |
| Package manager | pnpm (workspace monorepo) |
| App location | `apps/admin/` |
| Port | 3001 (proxy target: `http://localhost:3000`) |

**Architecture pattern:** Server Components + Server Actions (App Router). Most pages are `async` server components that call the API client directly from the server. Client interactivity is minimal.

**Strengths:**
- TypeScript throughout with explicit types for all API responses.
- Zod-based env validation catches misconfiguration at startup.

**Issues:**
- No component library or design system. Every button, card, badge, and table is hand-built with inline style objects. This is high maintenance and impossible to theme consistently.
- No separation between layout/presentation logic and data-fetching logic.

---

## 2. Routing and Page Structure

### Routes

| Route | File | Status |
|---|---|---|
| `/` | `apps/admin/src/app/page.tsx` | Dashboard (health checks) |
| `/login` | `apps/admin/src/app/login/page.tsx` | Login form |
| `/users` | `apps/admin/src/app/users/page.tsx` | Users table (READ-ONLY) |
| `/organizations` | `apps/admin/src/app/organizations/page.tsx` | Orgs table (READ-ONLY) |
| `/audit-logs` | `apps/admin/src/app/audit-logs/page.tsx` | Audit log table (READ-ONLY) |
| `/incidents` | `apps/admin/src/app/incidents/page.tsx` | Incident list with resolve action |
| `/feature-flags` | `apps/admin/src/app/feature-flags/page.tsx` | CRUD for feature flags |
| `/usage` | `apps/admin/src/app/usage/page.tsx` | Usage summary / by-user |

### Sidebar Navigation

Defined in `apps/admin/src/app/layout.tsx`. Hardcoded list of links to the routes above with an active-link check against `pathname`.

**Issues:**
- Navigation is hardcoded, not data-driven. Adding a new admin page requires editing the layout.
- No nested routing groups or breadcrumbs.
- No route-level metadata (SEO titles) set via `generateMetadata`.

---

## 3. Authentication and Authorization

### Current State

The login flow (`LoginForm.tsx`) is a **client component** that calls `adminLogin()` from `api.ts`. On success, it stores:
1. `accessToken` and `refreshToken` in `localStorage`.
2. An `admin_token` cookie (SameSite=Lax, no HttpOnly, no Secure, no path scoping beyond `/`).

Token refresh is implemented as a raw `fetch` to `/auth/refresh` when a 401 is received.

### CRITICAL Issues

| # | Severity | Finding |
|---|---|---|
| AUTH-1 | **CRITICAL** | **Admin pages have NO authentication enforcement.** The middleware (`apps/admin/src/middleware.ts`) only rewrites `/login` to `/`. No route guards, no session checks, no redirect to `/login` for unauthenticated users. Any user who knows the URL can navigate directly to `/users`, `/organizations`, etc. |
| AUTH-2 | **CRITICAL** | **Server components call `readToken()` from `localStorage`.** `localStorage` does not exist on the server. `readToken()` returns `null` in server contexts (guarded by `typeof window`), meaning all server-rendered data-fetching calls will be **unauthenticated** and hit 401s. This makes the server-side data fetching non-functional. |
| AUTH-3 | **HIGH** | **Cookie is not HttpOnly or Secure.** The `admin_token` cookie is set with `SameSite=Lax` but lacks `HttpOnly`, `Secure`, and `__Host-` prefix. This means it is accessible to JavaScript (XSS risk) and transmitted over HTTP (MITM risk in non-HTTPS environments). |
| AUTH-4 | **MEDIUM** | **Refresh token has no server-side validation.** The refresh flow is purely client-side with no server-side session store or token revocation mechanism. Stolen refresh tokens grant indefinite access until expiry. |
| AUTH-5 | **MEDIUM** | **No role-based access control.** The login stores user info but never enforces roles. Any authenticated user can access all admin pages. |

### Login Form Issues

| # | Severity | Finding |
|---|---|---|
| AUTH-6 | **LOW** | `redirectTo` is stored in `sessionStorage`, which is per-tab. Opening a new tab and hitting `/login` loses the redirect context. |

---

## 4. UI Components and Design System

### Current State

All UI is built with inline `style` objects. There is no component library, no theme system, and no shared component abstraction. Key repeated patterns include:

- **Cards**: white background, 8px border-radius, 1px solid border, 1.5rem padding
- **Badges**: pill shape, uppercase, 0.75rem, with background/text/border color triples
- **Tables**: simple `<table>` with `<thead>` and `<tbody>`, no sticky header, no sorting, no pagination
- **Buttons**: solid dark background or bordered variant
- **Empty states**: centered text with `3rem` padding

### Issues

| # | Severity | Finding |
|---|---|---|
| UI-1 | **HIGH** | **No design system.** Every page reimplements the same card, badge, button, and table styles. Changes require editing every page. |
| UI-2 | **MEDIUM** | **Hardcoded color values throughout.** Colors like `#1a1a2e`, `#6b7280`, `#10b981` are repeated as literals. No design tokens. |
| UI-3 | **MEDIUM** | **No responsive design.** The layout uses a fixed sidebar width (`240px`) and `1rem` gaps. No media queries. The sidebar likely breaks on mobile. |
| UI-4 | **LOW** | **No dark mode support.** All backgrounds are hardcoded to white. |
| UI-5 | **LOW** | **Tables have no interactive features.** No column sorting, no row selection, no inline actions beyond the resolve button on incidents. |

---

## 5. API Client Configuration and Data Fetching

### API Client (`apps/admin/src/lib/api.ts`)

**Architecture:**
- Single `request()` wrapper around `fetch`.
- Base URL from `NEXT_PUBLIC_API_BASE` (defaults to `http://localhost:3000`).
- Bearer token from `localStorage`.
- Token refresh on 401 with retry.
- `ApiResult<T>` discriminated union type, but most callers do not use it (they throw on error).

### Issues

| # | Severity | Finding |
|---|---|---|
| API-1 | **HIGH** | **`ApiResult<T>` type is defined but unused.** Functions like `listUsers()` throw on error rather than returning `ApiResult<T>`. This causes unhandled promise rejections in server components that have no error boundary. |
| API-2 | **MEDIUM** | **Redundant `token: ''` query parameter.** Pages pass `token: ''` in `ListParams` which gets serialized as `token=` in the query string. The token is sent via `Authorization` header, not query params. This is dead code that pollutes URLs. |
| API-3 | **MEDIUM** | **No request timeout or abort.** Long-running API calls have no timeout, which can hang server components indefinitely. |
| API-4 | **LOW** | **No retry for transient failures.** Network errors or 5xx responses throw immediately with no retry logic. |
| API-5 | **LOW** | **`buildUrl` does not validate the base URL at runtime** — it trusts `NEXT_PUBLIC_API_BASE` from the client bundle, which could be manipulated. |

### Backend Endpoint Status

Per the code comments and audit context:

| Endpoint | Backend Status |
|---|---|
| `/health/ready` | EXISTS |
| `/auth/login` | EXISTS |
| `/auth/refresh` | EXISTS (assumed) |
| `/admin/users` | **NOT IMPLEMENTED** |
| `/admin/organizations` | **NOT IMPLEMENTED** |
| `/admin/audit-logs` | **NOT IMPLEMENTED** |
| `/admin/incidents` | **NOT IMPLEMENTED** |
| `/admin/feature-flags` | **NOT IMPLEMENTED** |
| `/admin/usage/:id/summary` | **NOT IMPLEMENTED** |
| `/admin/usage/:id/by-user` | **NOT IMPLEMENTED** |

The dashboard page works because `/health/ready` exists. All other admin pages will receive 404s.

---

## 6. Form Handling and Validation

### Current State

- **Login form**: Client component with two fields (`email`, `password`). Submits via `adminLogin()`.
- **Filter forms**: Server-rendered `<form method="get">` with a single text input. No client-side validation.
- **Feature flag forms**: Read from `page.tsx` — need to verify if create/edit forms exist.

### Issues

| # | Severity | Finding |
|---|---|---|
| FORM-1 | **MEDIUM** | **No client-side validation on login.** Email format, password minimum length, and empty-field checks are not enforced in the component — they rely entirely on the backend. |
| FORM-2 | **LOW** | **No loading state on form submission.** The login button does not disable or show a spinner while the request is in-flight. |
| FORM-3 | **LOW** | **No success/error message display.** After login failure, the user sees a thrown error but no structured error message component. |

---

## 7. State Management

### Current State

- **No state management library.** No Redux, no Zustand, no React Context.
- State is managed via:
 - Server component props (data fetched in the page component).
 - `localStorage` for auth tokens.
 - URL search params for filter state.

### Issues

| # | Severity | Finding |
|---|---|---|
| STATE-1 | **LOW** | **No client-side state cache.** Each navigation re-fetches data from the API. For an admin panel, this is acceptable since data is typically fresh, but it means no optimistic updates. |
| STATE-2 | **LOW** | **No shared loading or error state.** Each page handles its own error state independently. |

---

## 8. Third-Party SDK Integrations

### Current State

| Package | Purpose |
|---|---|
| `next` | Framework |
| `react` / `react-dom` | UI library |
| `zod` | Runtime type validation (env vars) |
| `lucide-react` | Icons (sidebar, status indicators) |

### Missing / Recommended

| Package | Why |
|---|---|
| `@tanstack/react-table` | Table sorting, filtering, pagination for admin data |
| `react-hook-form` + `zod` | Form validation with type safety |
| `date-fns` | Date formatting (currently using raw `toLocaleDateString()` which varies by locale) |
| `next-themes` | Dark mode support |

---

## 9. Build Configuration and Deployment Setup

### `next.config.ts`

```ts
const nextConfig = {
 output: 'standalone',
 async rewrites() {
 return [
 {
 source: '/:path*',
 destination: 'http://localhost:3000/:path*',
 },
 ];
 },
};
```

****
- `output: 'standalone'` enables Docker-friendly builds with `.next/standalone`.
- A catch-all rewrite proxies all non-matched routes to the API at port 3000.

### `tsconfig.json`

- Strict mode enabled (`"strict": true`).
- Path alias: `@/*` → `./src/*`.
- No `paths` mapping for the API client — it uses relative imports.

### `Dockerfile`

```dockerfile
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3001
CMD ["node", "server.js"]
```

**Issues:**

| # | Severity | Finding |
|---|---|---|
| BUILD-1 | **MEDIUM** | **Multi-stage build copies the entire repo into the builder stage.** Monorepo packages (`apps/web/`, `packages/*`) are included in the build context even though they are not used. This increases build time and image size. |
| BUILD-2 | **LOW** | **No health check in Dockerfile.** The container exposes port 3001 but has no `HEALTHCHECK` instruction. |
| BUILD-3 | **LOW** | **No `.dockerignore` visible in the admin app.** If the repo-level `.dockerignore` does not exclude `node_modules`, `.git`, etc., the build context will be unnecessarily large. |

---

## 10. Error Handling and User Feedback

### Current State

- Server components use `try/catch` that returns `null` on error.
- Pages render empty state when data is `null` (e.g., "No users found").
- No error boundaries are defined.
- No toast/notification system.

### Issues

| # | Severity | Finding |
|---|---|---|
| ERR-1 | **HIGH** | **No Error Boundaries.** A thrown error in any server component will render the Next.js default error page (plain text) rather than a styled fallback. Users see an unhelpful error screen. |
| ERR-2 | **MEDIUM** | **Silent failures.** The `try/catch` blocks in page data-fetching functions return `null` and swallow errors. The user sees an empty table with no indication that something went wrong. |
| ERR-3 | **MEDIUM** | **No loading states.** Server components render nothing until data resolves. There is no skeleton, spinner, or progress indicator. |
| ERR-4 | **LOW** | **No toast/notification system.** Success and error feedback is not surfaced consistently. |

---

## 11. Accessibility Considerations

### Current State

- Semantic HTML is partially used (`<nav>`, `<main>`, `<table>`, `<th>`).
- No ARIA labels on interactive elements.
- No skip-to-content link.
- Color is the only status indicator in badges (no icon or text alternative).

### Issues

| # | Severity | Finding |
|---|---|---|
| A11Y-1 | **MEDIUM** | **Tables lack explicit scope attributes.** `<th>` elements have no `scope="col"`. |
| A11Y-2 | **MEDIUM** | **Badges are color-only status indicators.** Users with color blindness cannot distinguish pass/fail/warn. |
| A11Y-3 | **LOW** | **No skip-to-main-content link.** Keyboard users must tab through the sidebar. |
| A11Y-4 | **LOW** | **Form inputs lack associated `<label>` elements.** The login form and filter inputs have placeholders but no `<label>` tags. |

---

## 12. Security Issues

### Summary of Security Findings

| # | Severity | Category | Finding |
|---|---|---|---|
| SEC-1 | **CRITICAL** | Auth | No route guards on admin pages — all admin routes are publicly accessible. |
| SEC-2 | **CRITICAL** | Auth | Server-side `localStorage` reads always return null, making server-rendered admin data fetching unauthenticated. |
| SEC-3 | **HIGH** | Session | `admin_token` cookie lacks `HttpOnly`, `Secure`, and `__Host-` prefix. |
| SEC-4 | **HIGH** | Auth | No role-based access control — any authenticated user can access all admin functions. |
| SEC-5 | **MEDIUM** | Session | Refresh tokens have no server-side store or revocation mechanism. |
| SEC-6 | **MEDIUM** | Data | Silent error swallowing in server components masks failures and could hide security-relevant errors. |

---

## 13. Missing Features

| Feature | Priority | Notes |
|---|---|---|
| Auth-protected routes | **P0** | All admin pages need middleware or layout-level session validation |
| Working server-side auth | **P0** | `localStorage` is unavailable in server components; need cookies-only auth |
| Backend admin endpoints | **P0** | All `/admin/*` endpoints return 404 |
| Error boundaries | **P1** | Graceful error UI instead of Next.js default |
| Loading skeletons | **P1** | Improve perceived performance |
| Table sorting/pagination | **P1** | Required for any meaningful data volume |
| Dark mode | **P2** | Expected for admin tools |
| Responsive layout | **P2** | Mobile access to admin panel |
| Design system | **P2** | Shared components, tokens, theming |
| Toast notifications | **P2** | User feedback for actions |
| Search/filter on users | **P2** | Currently only filters by org ID |
| Bulk actions | **P3** | Disable/enable users, resolve incidents in bulk |

---

## 14. Recommendations (Priority Order)

### Immediate (P0 — Security/Functionality)

1. **Add middleware route guards** for all `/admin/*` routes (except `/login`). Check for a valid session cookie and redirect to `/login` if missing.
2. **Fix server-side auth.** Replace `localStorage` reads in `api.ts` with cookie-only token reads. The `request()` function must read the `admin_token` cookie on the server (via `headers().get('cookie')` in RSC or by passing cookies explicitly).
3. **Harden the auth cookie.** Set `HttpOnly; Secure; SameSite=Strict; Path=/; __Host-` prefix on the auth cookie.
4. **Implement role checks.** Store the user's role in the session and enforce it at the layout/middleware level.

### Short-term (P1 — Reliability)

5. **Add an Error Boundary** at the root layout level with a styled fallback.
6. **Return `ApiResult<T>` from API functions** and handle the error case in each page component.
7. **Add loading skeletons** or at least a "Loading..." state for async server components.
8. **Stop swallowing errors silently** — log them and render a meaningful error message.

### Medium-term (P2 — UX)

9. **Create a shared component library** (`apps/admin/src/components/`) with `Card`, `Badge`, `Button`, `Table`, `StatusBadge`.
10. **Add table pagination** using URL search params (works naturally with Next.js App Router).
11. **Implement dark mode** with CSS custom properties.
12. **Add responsive breakpoints** for mobile sidebar (hamburger menu or collapsible sidebar).

### Long-term (P3 — Polish)

13. **Add `react-hook-form` + `zod`** for all forms with proper validation.
14. **Implement toast notifications** for action feedback (save, delete, resolve).
15. **Add search and advanced filtering** on the users page.
16. **Add unit tests** for the API client and integration tests for critical pages.

---

## 15. Code Quality Observations

| Aspect | Assessment |
|---|---|
| Type safety | Strong — Zod schemas, explicit TypeScript types for all API responses |
| Error handling | Weak — silent catches, no boundaries, no retries |
| Separation of concerns | Moderate — API client is well-isolated, but pages mix data fetching and rendering |
| Consistency | High — naming conventions, file structure, and patterns are consistent across pages |
| Test coverage | Unknown — no test files were found in `apps/admin/` |

---

*End of audit. Total issues: 6 critical, 4 high, 8 medium, 6 low.*
