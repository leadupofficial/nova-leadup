/**
 * Admin API client.
 *
 * - Reads NEXT_PUBLIC_API_BASE (defaults to http://localhost:3000) and falls
 * back to the validated value from env.ts.
 * - Adds the bearer token from localStorage('admin_token') to every request.
 * - Throws an Error whose message is the response body on any non-2xx status.
 *
 * Backend reality (audit, Sept 2026):
 * - /health/* — exists (services/api/src/routes/health.ts, services/api/src/index.ts)
 * - /auth/login, /auth/session — exists (services/api/src/routes/auth.ts)
 * - /admin/users, /admin/organizations, /admin/audit-logs, /admin/incidents,
 * /admin/usage/* — NOT IMPLEMENTED in services/api.
 * Pages that call these will receive 404s and surface an explicit error
 *  state with a retry button — they will NOT fabricate data.
 */
import { getPublicEnv } from './env';

export type AdminUser = {
 id: string;
 email: string;
 name?: string;
 phone?: string;
 role: string;
 status: string;
 disabled: boolean;
 emailVerified: boolean;
 createdAt: string;
};

export type AdminOrganization = {
 id: string;
 name: string;
 plan: string;
 members: number;
 slug?: string;
 createdAt?: string;
};

export type AdminAuditLog = {
 id: string;
 action: string;
 actor: string;
 actorType?: string;
 actorId?: string;
 outcome?: string;
 targetType?: string;
 targetId?: string;
 timestamp: string;
 occurredAt: string;
 data?: Record<string, unknown>;
};

export type AdminIncident = {
 id: string;
 severity: string;
 message: string;
 description?: string;
 title?: string;
 resolved: boolean;
 occurredAt: string;
};

export type AdminFeatureFlag = {
 id: string;
 key: string;
 value: boolean;
 enabled: boolean;
 rolloutPercent: number;
 description?: string;
 updatedAt: string;
};

export type UsageSummary = {
 totalCalls: number;
 totalTokens: number;
 totalCost: number;
 period: string;
};

export type UsageByUser = {
 userId: string;
 email: string;
 calls: number;
 tokens: number;
 cost: number;
};

export type HealthResponse = {
 status: string;
 service?: string;
 checks?: Record<string, string>;
 timestamp?: string;
};

export type ListParams = Record<string, string | number | undefined>;

/** Shape returned by every API helper — discriminated by ok. */
export type ApiResult<T> =
 | { ok: true; data: T }
 | { ok: false; error: string; status: number };

const TOKEN_KEY = 'admin_token';
const REFRESH_TOKEN_KEY = 'admin_refresh_token';

function readToken(): string | null {
 if (typeof window === 'undefined') return null;
 try {
 return window.localStorage.getItem(TOKEN_KEY);
 } catch {
 return null;
 }
}

function readRefreshToken(): string | null {
 if (typeof window === 'undefined') return null;
 try {
 return window.localStorage.getItem(REFRESH_TOKEN_KEY);
 } catch {
 return null;
 }
}

function writeTokens(accessToken: string, refreshToken?: string): void {
 if (typeof window === 'undefined') return;
 window.localStorage.setItem(TOKEN_KEY, accessToken);
 if (refreshToken) {
 window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
 }
 // Mirror into a cookie so the Next.js middleware can read it at the edge.
 document.cookie = `admin_token=${accessToken}; path=/; max-age=31536000; SameSite=Lax`;
}

export function clearTokens(): void {
 if (typeof window === 'undefined') return;
 window.localStorage.removeItem(TOKEN_KEY);
 window.localStorage.removeItem(REFRESH_TOKEN_KEY);
 // Expire the cookie immediately
 document.cookie = 'admin_token=; path=/; max-age=0; SameSite=Lax';
}

/**
 * Build a URL relative to NEXT_PUBLIC_API_BASE. Strips trailing slash from
 * the base and ensures a single leading slash on the path.
 */
function buildUrl(path: string, params?: ListParams): string {
 const base = (getPublicEnv().NEXT_PUBLIC_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
 const normalized = path.startsWith('/') ? path : `/${path}`;
 let url = `${base}${normalized}`;
 if (params) {
 const qs = Object.entries(params)
 .filter(([, v]) => v !== undefined && v !== null && v !== '')
 .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
 .join('&');
 if (qs) url += (url.includes('?') ? '&' : '?') + qs;
 }
 return url;
}

/**
 * Core fetch wrapper. Adds the bearer token (server contexts won't have one
 * — that's expected; the request simply won't include Authorization).
 */
async function request<T>(
 path: string,
 init: RequestInit & { params?: ListParams } = {},
): Promise<T> {
 const { params, ...rest } = init;
 const url = buildUrl(path, params);

 const headers = new Headers(rest.headers);
 headers.set('Accept', 'application/json');
 if (rest.body && !headers.has('Content-Type')) {
 headers.set('Content-Type', 'application/json');
 }

 const token = readToken();
 if (token && !headers.has('Authorization')) {
 headers.set('Authorization', `Bearer ${token}`);
 }

 let res = await fetch(url, {
 ...rest,
 headers,
 cache: rest.cache ?? 'no-store',
 });

 // If we got a 401 and there's a refresh token, try refreshing once
 if (res.status === 401 && readRefreshToken()) {
 const newToken = await refreshAccessToken();
 if (newToken) {
 headers.set('Authorization', `Bearer ${newToken}`);
 res = await fetch(url, {
 ...rest,
 headers,
 cache: rest.cache ?? 'no-store',
 });
 }
 }

 if (!res.ok) {
 const body = await res.text().catch(() => '');
 throw new Error(
 `Admin API ${res.status} ${res.statusText} on ${path}${body ? `: ${body}` : ''}`,
 );
 }

 const contentType = res.headers.get('content-type') ?? '';
 if (contentType.includes('application/json')) {
 return (await res.json()) as T;
 }
 return undefined as T;
}

/** Unwrap a { data: ... } envelope, or return the raw response. */
function unwrap<T>(raw: unknown): T {
 if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
 return (raw as { data: T }).data;
 }
 return raw as T;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<HealthResponse> {
 return unwrap<HealthResponse>(await request<unknown>('/health/ready'));
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AdminLoginPayload = { email: string; password: string };
export type AdminLoginResult = {
 user: { id: string; email: string; name?: string };
 accessToken: string;
 refreshToken?: string;
};

export async function adminLogin(payload: AdminLoginPayload): Promise<AdminLoginResult> {
 const raw = await request<{ success: boolean; data: AdminLoginResult }>(
 '/auth/login',
 { method: 'POST', body: JSON.stringify(payload) },
 );
 if (!raw?.success || !raw?.data) {
 throw new Error('Login failed: unexpected response from server');
 }
 // Persist both tokens and mirror the access token into a cookie for middleware
 writeTokens(raw.data.accessToken, raw.data.refreshToken);
 return raw.data;
}

/**
 * Attempts to refresh the access token using the stored refresh token.
 * Returns the new access token on success, null on failure.
 *
 * IMPORTANT: this function does NOT call request() to avoid circular
 * recursion. It makes a raw fetch so the core request() wrapper can safely
 * call this on 401.
 */
export async function refreshAccessToken(): Promise<string | null> {
 const refreshToken = readRefreshToken();
 if (!refreshToken) return null;

 try {
 const base = (getPublicEnv().NEXT_PUBLIC_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
 const url = `${base}/auth/refresh`;
 const res = await fetch(url, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Accept: 'application/json',
 },
 body: JSON.stringify({ refreshToken }),
 cache: 'no-store',
 });

 if (!res.ok) return null;

 const data = await res.json();
 const newToken = data?.data?.accessToken || data?.accessToken;
 if (!newToken) return null;

 // Persist tokens (same writeTokens helper as login)
 if (typeof window !== 'undefined') {
 window.localStorage.setItem(TOKEN_KEY, newToken);
 const newRefresh = data?.data?.refreshToken || data?.refreshToken;
 if (newRefresh) {
 window.localStorage.setItem(REFRESH_TOKEN_KEY, newRefresh);
 }
 document.cookie = `admin_token=${newToken}; path=/; max-age=31536000; SameSite=Lax`;
 }
 return newToken;
 } catch {
 return null;
 }
}

// ---------------------------------------------------------------------------
// Admin CRUD — these endpoints do NOT yet exist in services/api.
// Pages will surface the explicit 404 error with a retry button.
// ---------------------------------------------------------------------------

export async function listUsers(params: ListParams = {}): Promise<AdminUser[]> {
 return unwrap<AdminUser[]>(await request<unknown>('/admin/users', { params }));
}

export async function listOrganizations(params: ListParams = {}): Promise<AdminOrganization[]> {
 return unwrap<AdminOrganization[]>(await request<unknown>('/admin/organizations', { params }));
}

export async function listAuditLogs(params: ListParams = {}): Promise<AdminAuditLog[]> {
 return unwrap<AdminAuditLog[]>(await request<unknown>('/admin/audit-logs', { params }));
}

export async function listIncidents(params: ListParams = {}): Promise<AdminIncident[]> {
 return unwrap<AdminIncident[]>(await request<unknown>('/admin/incidents', { params }));
}

export async function resolveIncident(id: string): Promise<AdminIncident> {
 return unwrap<AdminIncident>(
 await request<unknown>(`/admin/incidents/${encodeURIComponent(id)}/resolve`, {
 method: 'POST',
 }),
 );
}

export async function listFeatureFlags(): Promise<AdminFeatureFlag[]> {
 return unwrap<AdminFeatureFlag[]>(await request<unknown>('/admin/feature-flags'));
}

export async function createFeatureFlag(data: Partial<AdminFeatureFlag>): Promise<AdminFeatureFlag> {
 return unwrap<AdminFeatureFlag>(
 await request<unknown>('/admin/feature-flags', {
 method: 'POST',
 body: JSON.stringify(data),
 }),
 );
}

export async function updateFeatureFlag(id: string, data: Partial<AdminFeatureFlag>): Promise<AdminFeatureFlag> {
 return unwrap<AdminFeatureFlag>(
 await request<unknown>(`/admin/feature-flags/${encodeURIComponent(id)}`, {
 method: 'PATCH',
 body: JSON.stringify(data),
 }),
 );
}

export async function deleteFeatureFlag(id: string): Promise<void> {
 await request<unknown>(`/admin/feature-flags/${encodeURIComponent(id)}`, {
 method: 'DELETE',
 });
}

export async function getUsageSummary(tenantId: string, _opts: ListParams = {}): Promise<UsageSummary> {
 return unwrap<UsageSummary>(
 await request<unknown>(`/admin/usage/${encodeURIComponent(tenantId)}/summary`),
 );
}

export async function getUsageByUser(tenantId: string, _opts: ListParams = {}): Promise<UsageByUser[]> {
 return unwrap<UsageByUser[]>(
 await request<unknown>(`/admin/usage/${encodeURIComponent(tenantId)}/by-user`),
 );
}
