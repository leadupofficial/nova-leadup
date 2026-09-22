/**
 * Admin API client.
 *
 * - Reads NEXT_PUBLIC_API_BASE through `env.ts` (validated; the default already
 * carries the `/api/v1` prefix, which every helper here relies on).
 * - Adds the bearer token from localStorage('admin_token') to every request.
 * - Throws an Error whose message is the response body on any non-2xx status.
 *
 * Backend reality (re-checked 2026-09-20): every endpoint this client calls IS
 * implemented and mounted under `/api/v1` by `services/api`:
 *   /auth/login, /auth/refresh, /admin/users, /admin/organizations,
 *   /admin/audit-logs, /admin/incidents, /admin/incidents/:id/resolve,
 *   /admin/feature-flags (GET/POST/PATCH/DELETE),
 *   /admin/usage/:tenantId/summary, /admin/usage/:tenantId/by-user,
 *   /account/deletion-request, and root-mounted /health/ready.
 *
 * An earlier version of this comment claimed the `/admin/*` routes were "NOT
 * IMPLEMENTED" and that pages would 404. That stopped being true and was actively
 * misleading: a console page that renders correctly was being read as broken.
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

/**
 * Reads the admin access token.
 *
 * In the browser this is localStorage. During server rendering the pages in
 * `src/app/**` are server components, so there is no localStorage — the access
 * token the client mirrors into the `admin_token` cookie (see `writeTokens`) is
 * read back through `next/headers` instead. Without this every server-rendered
 * table silently rendered empty, because the API answered 401 and each page
 * swallowed the error.
 *
 * `next/headers` is imported dynamically and only on the server so this module
 * stays importable from client components (e.g. `LoginForm`).
 */
async function readToken(): Promise<string | null> {
 if (typeof window !== 'undefined') {
 try {
 return window.localStorage.getItem(TOKEN_KEY);
 } catch {
 return null;
 }
 }
 try {
 const { cookies } = await import('next/headers');
 const store = await cookies();
 return store.get(TOKEN_KEY)?.value ?? null;
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

/**
 * The only place the `admin_token` cookie is **written or renewed**. `clearTokens` below
 * expires it, which is the one other assignment and deliberately not a write.
 *
 * It was previously duplicated in two other files (`app/login/LoginForm.tsx` and the
 * refresh path below), and both copies had reverted to `max-age=31536000` with no
 * `Secure` — a year-long, world-readable mirror of a 15-minute credential. One
 * exported writer is the only way that regression cannot return in one of the copies,
 * so anything that obtains tokens must call this rather than assigning
 * `document.cookie` directly.
 */
export function writeTokens(accessToken: string, refreshToken?: string): void {
 if (typeof window === 'undefined') return;
 window.localStorage.setItem(TOKEN_KEY, accessToken);
 if (refreshToken) {
 window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
 }
 // Mirror into a cookie so the Next.js middleware can read it at the edge.
 //
 // The mirror used to live for a year with no `Secure` flag while the access token
 // itself expires in 15 minutes — a year-long, world-readable copy of a credential that
 // had been dead for 364 days. An hour is longer than any admin session needs and
 // short enough that a leaked browser profile stops being useful.
 const secure = window.location.protocol === 'https:' ? '; Secure' : '';
 document.cookie =
 `admin_token=${accessToken}; path=/; max-age=3600; SameSite=Lax${secure}`;
}

export function clearTokens(): void {
 if (typeof window === 'undefined') return;
 window.localStorage.removeItem(TOKEN_KEY);
 window.localStorage.removeItem(REFRESH_TOKEN_KEY);
 // Expire the cookie immediately
 document.cookie = 'admin_token=; path=/; max-age=0; SameSite=Lax';
}

/**
 * Resolves the API base URL for the current runtime.
 *
 * The browser must use the public origin. Server components instead prefer
 * `API_INTERNAL_URL` (e.g. http://127.0.0.1:3001/api/v1) so rendering does not
 * hairpin out through the public hostname, which would fail while DNS still
 * points elsewhere and would add a needless TLS round trip afterwards.
 */
async function resolveApiBase(): Promise<string> {
 if (typeof window === 'undefined') {
 const internal = process.env.API_INTERNAL_URL;
 if (internal) return internal.replace(/\/+$/, '');
 }
 return (getPublicEnv().NEXT_PUBLIC_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Origin (scheme://host[:port]) of the API, for endpoints mounted at the root
 * rather than under the API prefix — notably `/health/ready`, which the API
 * services expose at the origin and not under `/api/v1`.
 */
async function resolveApiOrigin(): Promise<string> {
 if (typeof window === 'undefined') {
 const internal = process.env.API_ORIGIN_URL;
 if (internal) return internal.replace(/\/+$/, '');
 }
 const base = await resolveApiBase();
 try {
 return new URL(base).origin;
 } catch {
 return base;
 }
}

/**
 * Build a URL relative to the resolved API base. Strips trailing slash from
 * the base and ensures a single leading slash on the path.
 */
async function buildUrl(
 path: string,
 params?: ListParams,
 baseOverride?: string,
): Promise<string> {
 const base = (baseOverride ?? (await resolveApiBase()));
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
 * Core fetch wrapper. Adds the bearer token from localStorage in the browser or
 * from the `admin_token` cookie during server rendering.
 */
async function request<T>(
 path: string,
 init: RequestInit & { params?: ListParams; baseOverride?: string } = {},
): Promise<T> {
 const { params, baseOverride, ...rest } = init;
 const url = await buildUrl(path, params, baseOverride);

 const headers = new Headers(rest.headers);
 headers.set('Accept', 'application/json');
 if (rest.body && !headers.has('Content-Type')) {
 headers.set('Content-Type', 'application/json');
 }

 const token = await readToken();
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
 // The status is part of the error, not just its text. `page-data.ts` maps 401 to
 // "your session has expired" and 503 to "the API is not ready", and `PageError`
 // shows a "Sign in again" link for 401/403 — all of which were dead because this
 // threw a plain `Error` with the status only baked into the message string.
 const error = new Error(
 `Admin API ${res.status} ${res.statusText} on ${path}${body ? `: ${body}` : ''}`,
 ) as Error & { status?: number };
 error.status = res.status;
 throw error;
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

/**
 * Unwraps a list endpoint.
 *
 * List routes answer with a *paginated* envelope —
 * `{ success, data: { data: [...], page, pageSize, totalItems, totalPages } }` —
 * so a single `unwrap` yields that wrapper object, not the rows. Accepts a bare
 * array too, so plain endpoints keep working.
 */
function unwrapList<T>(raw: unknown): T[] {
 const data: unknown = unwrap<unknown>(raw);
 if (Array.isArray(data)) return data as T[];
 if (data && typeof data === 'object') {
 const inner = (data as { data?: unknown }).data;
 if (Array.isArray(inner)) return inner as T[];
 }
 return [];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<HealthResponse> {
 // /health/ready is mounted at the origin, not under the /api/v1 prefix.
 return unwrap<HealthResponse>(
 await request<unknown>('/health/ready', { baseOverride: await resolveApiOrigin() }),
 );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AdminLoginPayload = {
	email: string;
	password: string;
	/**
	 * The second factor, when the account has one confirmed.
	 *
	 * Sent both as `mfaCode` and `mfa_code` — the API accepts either, and sending both means the
	 * console does not have to know which spelling that build expects.
	 */
	mfaCode?: string;
};

/**
 * The API refused the credentials because a second factor is required.
 *
 * A distinct error type rather than a message match at the call site: the login form has to *show a
 * different field* for this case, and string-matching the error text is how the form ends up
 * presenting a wrong code as a wrong password.
 */
export class MfaRequiredError extends Error {
	readonly code = 'MFA_REQUIRED';
	constructor() {
		super('This account has two-factor authentication enabled. Enter the current 6-digit code from your authenticator app, or one of your recovery codes.');
		this.name = 'MfaRequiredError';
	}
}

/** The API refused the supplied second factor. */
export class MfaInvalidError extends Error {
	readonly code = 'MFA_INVALID';
	constructor() {
		super('That verification code is not valid. Codes are valid for one 30-second step, so wait for the next one and try again.');
		this.name = 'MfaInvalidError';
	}
}
export type AdminLoginResult = {
 user: { id: string; email: string; name?: string };
 accessToken: string;
 refreshToken?: string;
};

/**
 * The API's auth routes answer with snake_case (`access_token`, `refresh_token`) —
 * the shape the Flutter client consumes. The console was written against camelCase,
 * so both spellings are accepted and normalised here, once, at the boundary.
 */
type RawTokenPair = {
 access_token?: string;
 refresh_token?: string;
 accessToken?: string;
 refreshToken?: string;
 user?: AdminLoginResult['user'];
};

function normalizeTokens(data: RawTokenPair | undefined): {
 accessToken: string | null;
 refreshToken?: string;
 user?: AdminLoginResult['user'];
} {
 return {
 accessToken: data?.access_token ?? data?.accessToken ?? null,
 refreshToken: data?.refresh_token ?? data?.refreshToken,
 user: data?.user,
 };
}

export async function adminLogin(payload: AdminLoginPayload): Promise<AdminLoginResult> {
 let raw: { success: boolean; data: RawTokenPair };
 try {
 raw = await request<{ success: boolean; data: RawTokenPair }>(
 '/auth/login',
 { method: 'POST', body: JSON.stringify(payload) },
 );
 } catch (error) {
 // The API answers a distinct code for a missing or wrong second factor so the form can prompt
 // instead of telling the operator their password is wrong when it is not. `request()` appends the
 // response body to its message, so the code is read from there — and only the code decides the
 // branch; the body itself is never shown to the operator.
 const message = error instanceof Error ? error.message : '';
 if (message.includes('MFA_REQUIRED')) throw new MfaRequiredError();
 if (message.includes('MFA_INVALID')) throw new MfaInvalidError();
 throw error;
 }
 const tokens = normalizeTokens(raw?.data);
 if (!raw?.success || !tokens.accessToken) {
 throw new Error('Login failed: unexpected response from server');
 }
 const result: AdminLoginResult = {
 accessToken: tokens.accessToken,
 refreshToken: tokens.refreshToken,
 user: tokens.user ?? { id: '', email: payload.email },
 };
 // Persist both tokens and mirror the access token into a cookie for middleware
 writeTokens(result.accessToken, result.refreshToken);
 return result;
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
 const tokens = normalizeTokens(data?.data ?? data);
 if (!tokens.accessToken) return null;

	// Renew through the shared writer. This block used to duplicate the cookie
	// assignment with a one-year `max-age` and no `Secure`, so a refresh silently
	// replaced the correct 1-hour mirror with a year-long one — and, because the
	// guard never re-mirrored the cookie at all, the middleware then disagreed with
	// localStorage about whether the session was still valid.
	writeTokens(tokens.accessToken, tokens.refreshToken);
	return tokens.accessToken;
 } catch {
 return null;
 }
}

// ---------------------------------------------------------------------------
// Admin CRUD — served by services/api under /api/v1/admin (see routes/admin.ts).
// Every one of these is live. If one starts failing, the page renders the explicit
// error card from `page-data.ts` rather than an empty table, so a failure never reads
// as "you have no data".
// ---------------------------------------------------------------------------

/**
 * A paginated list response, with the pagination the API actually returned.
 *
 * `listX` helpers below drop the envelope (they return `T[]`), which is how the
 * console ended up printing the *page length* as the total. Pages that need real
 * counts use this instead.
 *
 * `pageSize` is the parameter the API's query schema accepts (`services/api`'s
 * `ListQuerySchema`). This console used to send `limit: 50`, which the schema
 * silently strips, so it asked for 50 rows and got the default 20 — while printing
 * "20 total users".
 */
export interface ListPage<T> {
	rows: T[];
	totalItems: number | null;
	totalPages: number | null;
}

export async function requestListPage<T>(
	path: string,
	params: ListParams = {},
): Promise<ListPage<T>> {
	const raw = await request<unknown>(path, { params });
	const data: unknown = unwrap<unknown>(raw);

	if (Array.isArray(data)) {
		return { rows: data as T[], totalItems: data.length, totalPages: 1 };
	}

	const envelope = (data ?? {}) as { data?: unknown; totalItems?: unknown; totalPages?: unknown };
	const rows = Array.isArray(envelope.data) ? (envelope.data as T[]) : [];
	return {
		rows,
		totalItems: typeof envelope.totalItems === 'number' ? envelope.totalItems : null,
		totalPages: typeof envelope.totalPages === 'number' ? envelope.totalPages : null,
	};
}

export async function listUsers(params: ListParams = {}): Promise<AdminUser[]> {
	return unwrapList<AdminUser>(await request<unknown>('/admin/users', { params }));
}

export async function listOrganizations(params: ListParams = {}): Promise<AdminOrganization[]> {
 return unwrapList<AdminOrganization>(await request<unknown>('/admin/organizations', { params }));
}

export async function listAuditLogs(params: ListParams = {}): Promise<AdminAuditLog[]> {
 return unwrapList<AdminAuditLog>(await request<unknown>('/admin/audit-logs', { params }));
}

export async function listIncidents(params: ListParams = {}): Promise<AdminIncident[]> {
 return unwrapList<AdminIncident>(await request<unknown>('/admin/incidents', { params }));
}

export async function resolveIncident(id: string): Promise<AdminIncident> {
 return unwrap<AdminIncident>(
 await request<unknown>(`/admin/incidents/${encodeURIComponent(id)}/resolve`, {
 method: 'POST',
 }),
 );
}

export async function listFeatureFlags(): Promise<AdminFeatureFlag[]> {
 return unwrapList<AdminFeatureFlag>(await request<unknown>('/admin/feature-flags'));
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
 return unwrapList<UsageByUser>(
 await request<unknown>(`/admin/usage/${encodeURIComponent(tenantId)}/by-user`),
 );
}

// ---------------------------------------------------------------------------
// Account-deletion requests (services/api routes/account.ts)
// ---------------------------------------------------------------------------

/**
 * A web-filed request to delete an account.
 *
 * `POST /api/v1/account/deletion-request` is public and takes any email address, so a
 * row here is an **unverified claim**, not an instruction. Completing one is a
 * deliberate owner action; the policy on `/delete-account` promises the request is
 * verified and completed within 30 days, and this is the queue where that happens.
 */
export type AccountDeletionRequest = {
	id: string;
	userId: string;
	email: string | null;
	status: string;
	reason: string | null;
	scheduledFor: string | null;
	createdAt: string;
};

export async function listAccountDeletionRequests(): Promise<AccountDeletionRequest[]> {
	const data = await request<unknown>(`/account/deletion-requests`);
	const payload = unwrap<{ requests?: AccountDeletionRequest[] }>(data);
	return payload.requests ?? [];
}

export async function completeAccountDeletionRequest(id: string): Promise<void> {
	await request<unknown>(`/account/deletion-requests/${encodeURIComponent(id)}/complete`, {
		method: 'POST',
		// The API requires the literal, the same guard as the in-app path, so a stray
		// call cannot destroy an account.
		body: JSON.stringify({ confirm: 'DELETE' }),
	});
}

// ---------------------------------------------------------------------------
// Admin Control Center
//
// Everything below targets routers mounted under `/api/v1/admin` by
// `services/api/src/server.ts`: metrics.ts, users.ts, operations.ts, system.ts and
// ai.ts. They share one gate (`adminGate` = authenticate + resolveAdmin) and each
// route names the permission it needs, so a 403 here is a real authorisation answer
// rather than a missing endpoint.
// ---------------------------------------------------------------------------

/** A metric that may be unavailable, with the reason and the fix. */
export type MetricAvailability = {
	value: number | null;
	caveat: string | null;
	unavailableReason: string | null;
	instrumentationNeeded: string | null;
};

export type PlatformMetrics = {
	totalUsers: number;
	disabledUsers: number;
	verifiedUsers: number;
	newUsersToday: number;
	newUsersThisWeek: number;
	newUsersThisMonth: number;
	totalOrganizations: number;
	activeSessions: number;
	distinctSessionUsers: number;
	devices: MetricAvailability;
	dau: MetricAvailability;
	wau: MetricAvailability;
	mau: MetricAvailability;
	platforms: Array<{ platform: string; count: number }>;
	appVersions: Array<{ version: string; count: number }>;
	platformVersions: Array<{ version: string; count: number }>;
	deviceModels: Array<{ model: string; count: number }>;
	locales: Array<{ locale: string; count: number }>;
	timezones: Array<{ timezone: string; count: number }>;
};

export type ActivityMetrics = {
	conversationsToday: number;
	conversationsThisWeek: number;
	conversationsTotal: number;
	voiceConversations: number;
	textConversations: number;
	messagesTotal: number;
	userMessagesTotal: number;
	assistantMessagesTotal: number;
	aiRequests: number;
	aiInputTokens: number;
	aiOutputTokens: number;
	aiTotalTokens: number;
	aiLatency: MetricAvailability;
	sttRequests: MetricAvailability;
	ttsRequests: MetricAvailability;
	voiceSeconds: number;
	recordingSeconds: number;
	sttSeconds: number;
	ttsCharacters: number;
	tasksTotal: number;
	tasksCreatedToday: number;
	tasksCompleted: number;
	tasksPending: number;
	tasksOverdue: number;
	remindersTotal: number;
	remindersUpcoming: number;
	remindersOverdue: number;
	remindersDismissed: number;
	remindersTriggered: MetricAvailability;
	notificationsTotal: number;
	notificationsUnread: number;
	memoriesTotal: number;
	toolExecutionsTotal: number;
};

export type ModelUsage = {
	model: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	estimatedCostUsd: number;
	pricingKnown: boolean;
	avgLatencyMs: number | null;
	latencySamples: number;
};

export type AiMetrics = {
	requestsToday: number;
	requestsThisWeek: number;
	requestsThisMonth: number;
	totalRequests: number;
	totalTokens: number;
	estimatedCostUsd: number;
	byModel: ModelUsage[];
	byDay: Array<{ day: string; requests: number; tokens: number; estimatedCostUsd: number }>;
	unattributedRequests: number;
	latency: MetricAvailability;
	latencyP95Ms: number | null;
};

export type ReliabilityMetrics = {
	incidentsTotal: number;
	incidentsOpen: number;
	incidentsBySeverity: Array<{ severity: string; count: number }>;
	toolExecutionsTotal: number;
	toolFailures: number;
	toolFailureRate: number | null;
	jobExecutionsTotal: number;
	jobFailures: number;
	jobFailureRate: number | null;
	deadLetterCount: number;
	auditActionsToday: number;
	auditDenialsToday: number;
	adminActionsToday: number;
};

export type ProviderTestResult = {
	provider: string;
	kind: string;
	status: 'pass' | 'fail' | 'degraded' | 'not_configured';
	latencyMs: number | null;
	message: string;
	method: string;
	checkedAt: string;
	trigger?: string;
	checkedBy?: string | null;
};

export type RuntimeControls = {
	maintenanceMode: boolean;
	maintenanceMessage: string;
	aiEnabled: boolean;
	voiceEnabled: boolean;
	sttEnabled: boolean;
	ttsEnabled: boolean;
	backgroundJobsEnabled: boolean;
	proactiveEnabled: boolean;
	notificationsEnabled: boolean;
	realtimeEnabled: boolean;
	operatorNote: string;
	anyDisabled: boolean;
};

export type DashboardPayload = {
	platform: PlatformMetrics;
	activity: ActivityMetrics;
	ai: AiMetrics;
	reliability: ReliabilityMetrics;
	providers: ProviderTestResult[];
	controls: RuntimeControls;
	generatedAt: string;
};

/**
 * `GET /admin/overview` — the landing page's single call.
 *
 * Not `/control/dashboard`: that path belongs to the legacy router that serves the admin
 * screen bundled in the Flutter app, and it returns a different shape. See the route's
 * own comment in `services/api/src/routes/admin/metrics.ts`.
 */
export async function getDashboard(): Promise<DashboardPayload> {
	return unwrap<DashboardPayload>(await request<unknown>('/control/overview'));
}

export async function getPlatformMetrics(): Promise<PlatformMetrics> {
	return unwrap<PlatformMetrics>(await request<unknown>('/control/metrics/platform'));
}

export async function getActivityMetrics(): Promise<ActivityMetrics> {
	return unwrap<ActivityMetrics>(await request<unknown>('/control/metrics/activity'));
}

export async function getAiMetrics(days = 30): Promise<AiMetrics> {
	return unwrap<AiMetrics>(await request<unknown>('/control/metrics/ai', { params: { days } }));
}

export async function getReliabilityMetrics(): Promise<ReliabilityMetrics> {
	return unwrap<ReliabilityMetrics>(await request<unknown>('/control/metrics/reliability'));
}

export type CostBreakdown = {
	ai: number;
	voice: number;
	storage: number;
	database: number;
	infrastructure: number;
	notifications: number;
	other: number;
	total: number;
	monthlyProjectionUsd: number;
	notes: string[];
};

export async function getCostBreakdown(days = 30): Promise<CostBreakdown> {
	return unwrap<CostBreakdown>(await request<unknown>('/control/cost', { params: { days } }));
}

export type ServiceHealthEntry = {
	name: string;
	kind: 'service' | 'dependency';
	status: 'healthy' | 'degraded' | 'down' | 'unknown' | 'not_configured';
	latencyMs: number | null;
	detail: string;
	method: string;
	version: string | null;
	uptimeSeconds: number | null;
	unavailable: string[];
	target: string | null;
};

export type ServiceHealthReport = {
	services: ServiceHealthEntry[];
	dependencies: ServiceHealthEntry[];
	generatedAt: string;
	notes: string[];
};

export async function getServiceHealth(options: { runTests?: boolean } = {}): Promise<ServiceHealthReport> {
	return unwrap<ServiceHealthReport>(
		await request<unknown>('/control/services', {
			params: options.runTests ? { runTests: 'true' } : undefined,
		}),
	);
}

export async function testAllProviders(): Promise<ProviderTestResult[]> {
	return unwrap<ProviderTestResult[]>(
		await request<unknown>('/control/providers/test-all', { method: 'POST' }),
	);
}

// ─── Users ───────────────────────────────────────────────────────────────────

export type UserCounts = {
	conversations: number;
	messages: number;
	tasks: number;
	tasksCompleted: number;
	reminders: number;
	memories: number;
	notifications: number;
	activeSessions: number;
	devices: number;
};

export type AdminUserSummary = {
	id: string;
	email: string | null;
	name: string;
	phone: string | null;
	organizationId: string | null;
	emailVerified: boolean;
	phoneVerified: boolean;
	disabled: boolean;
	status: string;
	locale: string | null;
	timezone: string | null;
	lastLoginAt: string | null;
	createdAt: string;
	updatedAt: string;
	counts?: UserCounts | null;
};

export type UserDetail = {
	user: AdminUserSummary;
	counts: UserCounts | null;
	capabilities: Record<string, unknown> & { notes: string[] };
	featureFlags: Array<{
		key: string;
		enabled: boolean;
		source: string;
		rolloutPercent: number | null;
		reason: string;
	}>;
	sessions: Array<{
		id: string;
		deviceId: string | null;
		ipAddress: string | null;
		userAgent: string | null;
		expiresAt: string;
		revokedAt: string | null;
		createdAt: string;
		active: boolean;
	}>;
	devices: Array<{
		id: string;
		name: string | null;
		platform: string | null;
		hasPushToken: boolean;
		lastSeenAt: string | null;
		createdAt: string;
	}>;
	profile: Record<string, unknown> | null;
	persona: Record<string, unknown> | null;
	avatar: Record<string, unknown> | null;
	organization: { id: string; name: string; slug: string; plan: string } | null;
	subscription: Record<string, unknown> | null;
	conversations: Array<Record<string, unknown>>;
	tasks: Array<Record<string, unknown>>;
	reminders: Array<Record<string, unknown>>;
	memories: Array<Record<string, unknown>>;
	usage: Array<{ metric: string; total: string | number; rows: number }>;
	notifications: Array<Record<string, unknown>>;
	auditLog: Array<Record<string, unknown>>;
	lastActivityAt: string | null;
};

export async function getUser(id: string): Promise<UserDetail> {
	return unwrap<UserDetail>(await request<unknown>(`/control/users/${encodeURIComponent(id)}`));
}

export type UserListPage = {
	rows: AdminUserSummary[];
	totalItems: number | null;
	totalPages: number | null;
};

export async function listUserPage(params: ListParams = {}): Promise<UserListPage> {
	const raw = await request<unknown>('/control/users', { params });
	const data = unwrap<unknown>(raw);
	if (Array.isArray(data)) return { rows: data as AdminUserSummary[], totalItems: data.length, totalPages: 1 };
	const envelope = (data ?? {}) as { data?: unknown; totalItems?: unknown; totalPages?: unknown };
	return {
		rows: Array.isArray(envelope.data) ? (envelope.data as AdminUserSummary[]) : [],
		totalItems: typeof envelope.totalItems === 'number' ? envelope.totalItems : null,
		totalPages: typeof envelope.totalPages === 'number' ? envelope.totalPages : null,
	};
}

export type UserMutationResult = {
	disabled?: boolean;
	revokedSessions?: number;
	revoked?: number;
	propagation?: string;
	memoriesCleared?: number;
	remindersCancelled?: number;
};

export async function setUserSuspended(
	id: string,
	body: { disabled: boolean; reason?: string; revokeSessions?: boolean },
): Promise<UserMutationResult> {
	return unwrap<UserMutationResult>(
		await request<unknown>(`/control/users/${encodeURIComponent(id)}/suspend`, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	);
}

/**
 * `PATCH /control/users/:id` — the safe per-account fields.
 *
 * This route existed with a permission and an audit record and no caller: the console could
 * suspend an account but not correct a misspelled name or a wrong timezone. Email is
 * deliberately absent from the contract, because changing the address an account signs in with
 * is an identity change, not a support action.
 */
export async function updateUser(
	id: string,
	body: {
		name?: string;
		emailVerified?: boolean;
		phoneVerified?: boolean;
		locale?: string;
		timezone?: string;
		reason?: string;
	},
): Promise<UserMutationResult> {
	return unwrap<UserMutationResult>(
		await request<unknown>(`/control/users/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		}),
	);
}

/**
 * `POST /control/users/:id/reset-state` — clear stored memory and/or cancel pending reminders.
 *
 * Both are destructive to user-visible state, so the route requires an explicit reason and
 * reports what it actually touched; this helper passes that through unchanged.
 */
export async function resetUserState(
	id: string,
	body: { reason: string; clearMemories?: boolean; cancelReminders?: boolean },
): Promise<UserMutationResult> {
	return unwrap<UserMutationResult>(
		await request<unknown>(`/control/users/${encodeURIComponent(id)}/reset-state`, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	);
}

export async function revokeUserSessions(
	id: string,
	body: { reason?: string; deviceId?: string },
): Promise<UserMutationResult> {
	return unwrap<UserMutationResult>(
		await request<unknown>(`/control/users/${encodeURIComponent(id)}/revoke-sessions`, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/**
 * One refresh session, as the platform-wide inventory reports it.
 *
 * `state` is the server's decision, not the client's: `active` means unrevoked *and*
 * unexpired, and the console must not re-derive it from `revokedAt` alone. Doing that
 * client-side is how a three-week-old expiry would be counted as a live session.
 */
export type AdminSession = {
	id: string;
	user: { id: string; email: string | null; name: string | null; disabled: boolean };
	device: { id: string; name: string | null; platform: string | null } | null;
	ipAddress: string | null;
	userAgent: string | null;
	expiresAt: string;
	revokedAt: string | null;
	createdAt: string;
	state: 'active' | 'expired' | 'revoked';
	active: boolean;
};

export type SessionListPage = {
	rows: AdminSession[];
	totalItems: number | null;
	totalPages: number | null;
	counts: { active: number; revoked: number; expired: number } | null;
	notes: string[];
};

export async function listSessionPage(params: ListParams = {}): Promise<SessionListPage> {
	const raw = await request<unknown>('/control/sessions', { params });
	const data = unwrap<unknown>(raw);
	const envelope = (data ?? {}) as {
		data?: unknown;
		totalItems?: unknown;
		totalPages?: unknown;
		counts?: unknown;
		notes?: unknown;
	};
	return {
		rows: Array.isArray(envelope.data) ? (envelope.data as AdminSession[]) : [],
		totalItems: typeof envelope.totalItems === 'number' ? envelope.totalItems : null,
		totalPages: typeof envelope.totalPages === 'number' ? envelope.totalPages : null,
		counts:
			envelope.counts && typeof envelope.counts === 'object'
				? (envelope.counts as SessionListPage['counts'])
				: null,
		notes: Array.isArray(envelope.notes) ? (envelope.notes as string[]) : [],
	};
}

export async function revokeSession(
	id: string,
	body: { reason: string },
): Promise<{ revoked: number; userId: string; alreadyRevoked: boolean; propagation: string }> {
	return unwrap(
		await request<unknown>(`/control/sessions/${encodeURIComponent(id)}/revoke`, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	);
}

// ─── Configuration ───────────────────────────────────────────────────────────

export type ConfigView = {
	key: string;
	scope: 'public' | 'private' | 'secret';
	category: string;
	valueType: string;
	description: string;
	usedBy: string[];
	restartRequired: boolean;
	envOnly: boolean;
	allowedValues?: readonly string[];
	effectiveSource: 'secret' | 'environment' | 'database' | 'default' | 'unset';
	/** Whether editing this key changes running behaviour, and how. */
	readByRuntime: boolean;
	runtimeWiringNote: string;
	value: string | null;
	envKeyPresent: boolean;
	secretHint: string | null;
	secretFingerprint: string | null;
	/** True when the recorded test ran against a different value than the one stored now. */
	testStale: boolean;
	/** Fingerprint of the value the recorded test exercised. */
	lastTestedFingerprint: string | null;
	updatedAt: string | null;
	updatedBy: string | null;
	lastTestedAt: string | null;
	lastTestStatus: string | null;
	lastTestMessage: string | null;
	/**
	 * Provider connectivity tests that cover this key, by provider id.
	 *
	 * Sourced from the API's own provider→key map, so a key with no test is distinguishable from a
	 * key whose test has not run yet. `usedBy` answers a different question (which services read
	 * it) and the two must not be conflated on screen.
	 */
	testedBy: string[];
};

export type ConfigResponse = {
	views?: ConfigView[];
	/** The API groups entries by category under `configs`. */
	categories?: Array<{ category: string; configs?: ConfigView[]; entries?: ConfigView[] }>;
	secretStore?: { ready: boolean; note: string | null };
};

/**
 * `GET /control/config`.
 *
 * The real response shape is `{ environment, categories: [{ category, configs: [...] }],
 * configs, secretStore, notes }`. This reader accepted `views` and `entries` — two keys
 * the route does not use — so the flattened list came back empty and the Configuration
 * page threw `Cannot read properties of undefined (reading 'category')` on every render.
 *
 * It compiled because the response object is typed loosely at the boundary. The lesson
 * recorded here: when a route's shape is not generated from a shared type, read the key
 * the route actually returns and keep a fallback only for shapes that have existed.
 */
export async function getConfig(): Promise<{
	entries: ConfigView[];
	secretStoreReady: boolean;
	secretStoreNote: string | null;
	categories: Array<{ category: string; configs: ConfigView[] }>;
}> {
	const data = unwrap<ConfigResponse>(await request<unknown>('/control/config'));
	const fromViews = Array.isArray(data.views) ? data.views : [];
	const categories = Array.isArray(data.categories)
		? data.categories.map((group) => ({
				category: group.category,
				configs: Array.isArray(group.configs) ? group.configs : Array.isArray(group.entries) ? group.entries : [],
			}))
		: [];
	const entries = fromViews.length > 0 ? fromViews : categories.flatMap((group) => group.configs);
	return {
		entries,
		categories,
		secretStoreReady: data.secretStore?.ready ?? false,
		secretStoreNote: data.secretStore?.note ?? null,
	};
}

export type ConfigValidationCheck = {
	key: string;
	label: string;
	category: string;
	status: 'pass' | 'fail' | 'degraded' | 'not_configured' | 'unset';
	required: boolean;
	detail: string;
	effectiveSource: string;
};

export type ConfigValidation = {
	environment: string;
	checks: ConfigValidationCheck[];
	summary: Record<string, number>;
	notes?: string[];
};

export async function validateConfig(): Promise<ConfigValidation> {
	return unwrap<ConfigValidation>(await request<unknown>('/control/config/validate'));
}

export type ConfigUpdateResult = {
	key: string;
	before: string | null;
	after: string;
	affectedServices: string[];
	restartRequired: boolean;
	propagation: string;
};

export async function updateConfig(
	key: string,
	body: { value: string; reason?: string },
): Promise<ConfigUpdateResult> {
	return unwrap<ConfigUpdateResult>(
		await request<unknown>(`/control/config/${encodeURIComponent(key)}`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		}),
	);
}

export type SecretWriteResult = {
	key: string;
	hint: string;
	rotated: boolean;
	maskedDisplay: string;
	affectedServices: string[];
	prose: string;
};

export async function writeSecret(
	key: string,
	body: { value: string; reason: string },
): Promise<SecretWriteResult> {
	return unwrap<SecretWriteResult>(
		await request<unknown>(`/control/config/secrets/${encodeURIComponent(key)}`, {
			method: 'PUT',
			body: JSON.stringify(body),
		}),
	);
}

export async function deleteSecret(
	key: string,
	body: { reason: string; confirm: string },
): Promise<{ key: string; envFallbackActive: boolean; note: string }> {
	return unwrap<{ key: string; envFallbackActive: boolean; note: string }>(
		await request<unknown>(`/control/config/secrets/${encodeURIComponent(key)}`, {
			method: 'DELETE',
			body: JSON.stringify(body),
		}),
	);
}

export async function testProvider(provider: string): Promise<ProviderTestResult> {
	return unwrap<ProviderTestResult>(
		await request<unknown>(`/control/config/test/${encodeURIComponent(provider)}`, { method: 'POST' }),
	);
}

// ─── Feature flags ───────────────────────────────────────────────────────────

export type FeatureFlagRow = {
	key: string;
	description: string | null;
	enabled: boolean;
	rolloutPercent: number;
	/** The API names this `rowExists`; normalised to `hasRow` for the page. */
	hasRow: boolean;
	rowExists?: boolean;
	overrides: Array<{
		id: string;
		scopeType: string;
		scopeValue: string;
		enabled: boolean;
		rolloutPercent: number | null;
		reason: string | null;
	}>;
	evaluationPreview?: Array<{ subjectId: string; bucket: number; inside: boolean }>;
};

/**
 * `GET /control/feature-flags`.
 *
 * The route returns `{ flags, knownKeys, notes }` where each flag uses `rowExists`. The
 * page reads `hasRow`, so the two spellings are normalised here — reading `flag.hasRow`
 * directly threw `Cannot read properties of undefined (reading 'key')` because `flags`
 * itself was undefined under the wrong key.
 */
export async function listFlagRows(): Promise<{
	flags: FeatureFlagRow[];
	notes: string[];
	knownKeys: string[];
}> {
	const data = unwrap<{ flags?: FeatureFlagRow[]; notes?: string[]; knownKeys?: string[] } | FeatureFlagRow[]>(
		await request<unknown>('/control/feature-flags'),
	);
	if (Array.isArray(data)) return { flags: data, notes: [], knownKeys: [] };

	const flags = (data.flags ?? []).map((flag) => ({
		...flag,
		hasRow: flag.hasRow ?? flag.rowExists ?? true,
		overrides: flag.overrides ?? [],
	}));

	return { flags, notes: data.notes ?? [], knownKeys: data.knownKeys ?? [] };
}

export type FlagWriteResult = {
	key: string;
	enabled: boolean;
	rolloutPercent: number;
	propagation: string;
};

export async function upsertFlag(body: {
	key: string;
	enabled: boolean;
	rolloutPercent?: number;
	description?: string;
	reason?: string;
}): Promise<FlagWriteResult> {
	return unwrap<FlagWriteResult>(
		await request<unknown>('/control/feature-flags', { method: 'POST', body: JSON.stringify(body) }),
	);
}

export async function updateFlag(
	key: string,
	body: { enabled?: boolean; rolloutPercent?: number; description?: string; reason?: string },
): Promise<FlagWriteResult> {
	return unwrap<FlagWriteResult>(
		await request<unknown>(`/control/feature-flags/${encodeURIComponent(key)}`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		}),
	);
}

export async function deleteFlag(key: string, body: { confirm: string; reason?: string }): Promise<void> {
	await request<unknown>(`/control/feature-flags/${encodeURIComponent(key)}`, {
		method: 'DELETE',
		body: JSON.stringify(body),
	});
}

export async function setFlagOverride(
	key: string,
	body: {
		scopeType: 'environment' | 'user' | 'organization';
		scopeValue: string;
		enabled: boolean;
		rolloutPercent?: number | null;
		reason?: string;
	},
): Promise<{ override: unknown; evaluation?: unknown; propagation?: string }> {
	return unwrap<{ override: unknown; evaluation?: unknown; propagation?: string }>(
		await request<unknown>(`/control/feature-flags/${encodeURIComponent(key)}/overrides`, {
			method: 'PUT',
			body: JSON.stringify(body),
		}),
	);
}

export async function deleteFlagOverride(
	key: string,
	body: { scopeType: string; scopeValue: string; reason?: string },
): Promise<void> {
	await request<unknown>(`/control/feature-flags/${encodeURIComponent(key)}/overrides`, {
		method: 'DELETE',
		body: JSON.stringify(body),
	});
}

export type FlagEvaluation = {
	key: string;
	enabled: boolean;
	source: string;
	rolloutPercent: number | null;
	reason: string;
};

export async function evaluateFlag(
	key: string,
	params: { userId?: string; organizationId?: string; environment?: string },
): Promise<FlagEvaluation> {
	return unwrap<FlagEvaluation>(
		await request<unknown>(`/control/feature-flags/${encodeURIComponent(key)}/evaluate`, { params }),
	);
}

// ─── Controls and maintenance ────────────────────────────────────────────────

export type ControlDefinition = {
	key: string;
	label: string;
	description: string;
	type: 'boolean' | 'string';
	default: boolean | string;
	scope: 'capability' | 'maintenance' | 'metadata';
};

export async function getControls(): Promise<{
	controls: RuntimeControls;
	definitions: ControlDefinition[];
}> {
	const data = unwrap<Record<string, unknown>>(await request<unknown>('/control/controls'));
	// The route returns `getRuntimeControls()` spread alongside `definitions`; accept the
	// nested shape too so a route refactor does not break the page.
	const controls = (data.controls as RuntimeControls | undefined) ?? (data as unknown as RuntimeControls);
	return { controls, definitions: (data.definitions as ControlDefinition[]) ?? [] };
}

export async function setControl(
	key: string,
	body: { value: boolean | string; reason: string },
): Promise<{ key: string; previous: string | null; next: string; propagation: string; warnings?: string[] }> {
	return unwrap(
		await request<unknown>(`/control/controls/${encodeURIComponent(key)}`, {
			method: 'PUT',
			body: JSON.stringify(body),
		}),
	);
}

export async function setMaintenance(body: {
	enabled: boolean;
	message?: string;
	note?: string;
	reason: string;
}): Promise<RuntimeControls> {
	return unwrap<RuntimeControls>(
		await request<unknown>('/control/maintenance', { method: 'PUT', body: JSON.stringify(body) }),
	);
}

// ─── Environment / logs / traces ─────────────────────────────────────────────

export type EnvironmentInfo = {
	environment: string;
	nodeEnv: string;
	self: { uptimeSeconds: number; memoryRssMb: number; memoryHeapUsedMb: number; nodeVersion: string; pid: number };
	services: { targets: Array<{ name: string; host: string; port: number }>; source: string };
	database: Record<string, unknown> | null;
	migrations: { applied: number; latestAppliedAt: string | null; state: string };
	secretStore: { ready: boolean };
	warnings: string[];
};

export async function getEnvironment(): Promise<EnvironmentInfo> {
	return unwrap<EnvironmentInfo>(await request<unknown>('/control/environment'));
}

export type LogEntry = {
	id: string;
	occurredAt: string;
	level: string;
	service: string;
	msg: string | null;
	requestId: string | null;
	userId: string | null;
	route: string | null;
	method: string | null;
	statusCode: number | null;
	durationMs: number | null;
	errorType: string | null;
	errorMessage: string | null;
	stack: string | null;
	context: Record<string, unknown>;
};

export type LogsResponse = {
	/** True since the durable sink exists. Kept in the type so an older API's answer still renders. */
	available: boolean;
	/** Level and retention in force, so an empty table is not read as "nothing happened". */
	level?: string;
	retentionDays?: number;
	droppedSinceBoot?: number;
	failedFlushes?: number;
	pendingRows?: number;
	rows?: LogEntry[];
	totalItems?: number;
	page?: number;
	pageSize?: number;
	totalPages?: number;
	byLevel?: Array<{ level: string; count: number }>;
	byService?: Array<{ service: string; count: number }>;
	notes?: string[];
	/** Present only on the legacy "not available" answer. */
	reason?: string;
	whatExists?: string[];
	howToSearch?: string[];
};

export type LogQuery = {
	level?: string;
	q?: string;
	requestId?: string;
	userId?: string;
	service?: string;
	page?: number;
	pageSize?: number;
};

export async function getLogs(params: LogQuery = {}): Promise<LogsResponse> {
	return unwrap<LogsResponse>(await request<unknown>('/control/logs', { params }));
}

export type TraceResponse = {
	available: boolean;
	reason: string | null;
	traceId: string;
	timeline: Array<{
		source: string;
		timestamp: string;
		summary: string;
		detail?: unknown;
	}>;
	note: string | null;
};

export async function getTrace(traceId: string): Promise<TraceResponse> {
	return unwrap<TraceResponse>(await request<unknown>(`/control/traces/${encodeURIComponent(traceId)}`));
}

// ─── Operations ──────────────────────────────────────────────────────────────

export type ListEnvelope<T> = {
	data: T[];
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
	note?: string | null;
	limitations?: string[];
	/**
	 * True when the API withheld end-user content from this response because the caller does not
	 * hold the matching `*.content_read` permission. The rows, the counts and the pagination are
	 * unchanged — only the user's own words are removed. The console must say so rather than
	 * render an empty cell, which reads as missing data instead of withheld data.
	 */
	contentRedacted?: boolean;
	contentPermission?: string;
};

export async function getOperations<T>(
	path: string,
	params: ListParams = {},
): Promise<ListEnvelope<T>> {
	return unwrap<ListEnvelope<T>>(await request<unknown>(`/control/${path}`, { params }));
}

export async function getRealtime(): Promise<Record<string, unknown>> {
	return unwrap<Record<string, unknown>>(await request<unknown>('/control/realtime'));
}

/** `PATCH /control/tasks/:id` */
export async function updateTask(
	id: string,
	body: { status?: string; priority?: string; dueAt?: string | null; reason?: string },
): Promise<Record<string, unknown>> {
	return unwrap<Record<string, unknown>>(
		await request<unknown>(`/control/tasks/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		}),
	);
}

/**
 * `POST /control/jobs/:id/retry` — requeue a failed job.
 *
 * The route has existed with `jobs.manage`, a refusal for a job that is still in flight, and an
 * audit record, and the console never called it: a failed background job could only be retried by
 * hand against the database. It refuses a `queued` or `running` job on purpose — waiting for one to
 * finish is not a retry, it is a duplicate.
 */
export async function retryJob(id: string): Promise<{ id?: string; jobName?: string; status?: string; attempt?: number; maxAttempts?: number; note?: string }> {
	return unwrap<{ id?: string; jobName?: string; status?: string; attempt?: number; maxAttempts?: number; note?: string }>(
		await request<unknown>(`/control/jobs/${encodeURIComponent(id)}/retry`, {
			method: 'POST',
			body: JSON.stringify({ reason: 'retried from the Control Center' }),
		}),
	);
}

/** `PATCH /control/reminders/:id` */
export async function updateReminder(
	id: string,
	body: { title?: string; triggerAt?: string; dismissed?: boolean; reason?: string },
): Promise<{ reminder: Record<string, unknown>; latestRevision: unknown; propagation: string | null }> {
	return unwrap<{ reminder: Record<string, unknown>; latestRevision: unknown; propagation: string | null }>(
		await request<unknown>(`/control/reminders/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		}),
	);
}

/** `DELETE /control/memory/:id` */
export async function deleteMemory(id: string): Promise<{ deleted: boolean }> {
	return unwrap<{ deleted: boolean }>(
		await request<unknown>(`/control/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
	);
}

/**
 * `GET /control/users/:userId/reminders/:reminderId/history`
 *
 * The reminder's own revision journal plus any job executions recorded against it. The
 * revision rows are written by a database trigger on `trigger_at` change, so they are
 * the authoritative record of the reminder being moved.
 */
export async function getReminderHistory(
	userId: string,
	reminderId: string,
): Promise<{
	reminder: Record<string, unknown>;
	revisions: Array<Record<string, unknown>>;
	jobExecutions: Array<Record<string, unknown>>;
	note: string | null;
}> {
	return unwrap(
		await request<unknown>(
			`/control/users/${encodeURIComponent(userId)}/reminders/${encodeURIComponent(reminderId)}/history`,
		),
	);
}

/** `GET /control/tool-executions` */
export async function getToolExecutions(
	params: ListParams = {},
): Promise<ListEnvelope<Record<string, unknown>>> {
	return getOperations<Record<string, unknown>>('tool-executions', params);
}

/** `GET /control/database/health` */
export async function getDatabaseHealth(): Promise<{
	database: {
		sizePretty: string;
		sizeBytes: number;
		connections: number;
		maxConnections: number;
		tableCount: number;
		largestTables: Array<{ table: string; sizePretty: string; rows: number | null }>;
	} | null;
	slowQueries: Array<{ pid: number; durationSeconds: number; state: string; query: string }>;
	migrations: { applied: number; latestAppliedAt: string | null; state: string };
	notes: string[];
}> {
	const data = unwrap<Record<string, unknown>>(await request<unknown>('/control/database/health'));
	return {
		database: (data.database as never) ?? null,
		slowQueries: (data.slowQueries as never) ?? [],
		migrations: (data.migrations as never) ?? { applied: 0, latestAppliedAt: null, state: 'unknown' },
		notes: (data.notes as string[]) ?? [],
	};
}

/** `GET /control/audit-logs` — the append-only record of admin actions. */
export type AdminAuditEntry = {
	id: string;
	actor_id: string | null;
	actor_email: string | null;
	actor_role: string | null;
	action: string;
	permission: string | null;
	target_type: string | null;
	target_id: string | null;
	outcome: 'success' | 'failure' | 'denied';
	reason: string | null;
	before: unknown;
	after: unknown;
	request_id: string | null;
	ip_address: string | null;
	user_agent: string | null;
	trace_id: string | null;
	occurred_at: string;
};

export async function getAdminAuditLogs(params: ListParams = {}): Promise<{
	rows: AdminAuditEntry[];
	totalItems: number | null;
	totalPages: number | null;
	outcomes: Array<{ outcome: string; count: number }>;
	topActions: Array<{ action: string; count: number }>;
	notes: string[];
}> {
	const data = unwrap<{
		data?: AdminAuditEntry[];
		totalItems?: number;
		totalPages?: number;
		outcomes?: Array<{ outcome: string; count: number }>;
		topActions?: Array<{ action: string; count: number }>;
		notes?: string[];
	}>(await request<unknown>('/control/audit-logs', { params }));
	return {
		rows: data.data ?? [],
		totalItems: data.totalItems ?? null,
		totalPages: data.totalPages ?? null,
		outcomes: data.outcomes ?? [],
		topActions: data.topActions ?? [],
		notes: data.notes ?? [],
	};
}

// ─── AI & voice control center ───────────────────────────────────────────────

export type AiProviderRow = {
	provider: string;
	kind: string;
	label: string;
	credentialKey: string | null;
	credentialConfigured: boolean;
	/** Where the value came from — `secret`, `environment`, `default` or `unset`. */
	credentialSource: string | null;
	maskedHint: string | null;
	isDefault?: boolean;
	testable?: boolean;
	readByRuntime?: boolean;
	/** Model ids only, for a compact cell. */
	models: string[];
	/** The same models with the API's explanation of what each one is used for. */
	modelDetails: Array<{ id: string; use: string }>;
	selectionReason?: string | null;
	lastHealth?: { status: string; latencyMs: number | null; message: string; checkedAt: string } | null;
	notes?: string[];
};

/** The wire shape of one provider, as `GET /control/ai/providers` actually returns it. */
type RawAiProvider = {
	id?: unknown;
	provider?: unknown;
	label?: unknown;
	kind?: unknown;
	credentialKey?: unknown;
	credentialConfigured?: unknown;
	credentialSource?: unknown;
	maskedHint?: unknown;
	testable?: unknown;
	defaultSelected?: unknown;
	isDefault?: unknown;
	selectionReason?: unknown;
	models?: unknown;
	health?: unknown;
	lastHealth?: unknown;
};

function normaliseProvider(raw: RawAiProvider): AiProviderRow {
	const models = Array.isArray(raw.models) ? raw.models : [];
	const modelDetails = models
		.map((entry) => {
			if (typeof entry === 'string') return { id: entry, use: '' };
			const record = (entry ?? {}) as { id?: unknown; use?: unknown };
			return {
				id: typeof record.id === 'string' ? record.id : '',
				use: typeof record.use === 'string' ? record.use : '',
			};
		})
		.filter((entry) => entry.id !== '');

	// `health` is the key the route returns; `lastHealth` is what this reader used to
	// require. Accepting only the latter is why the console said **"never tested"** on
	// every provider even with rows in `provider_health_checks` — it was reading a field
	// the API has never sent. The fallback is kept for the recorded-history shape.
	const health = (raw.lastHealth ?? raw.health ?? null) as
		| { status?: unknown; latencyMs?: unknown; message?: unknown; checkedAt?: unknown }
		| null;

	return {
		// Same story: the route identifies a provider as `id`, the console asked for
		// `provider`, so every row rendered a blank id and React saw `key={undefined}`
		// repeated on every row.
		provider: typeof raw.id === 'string' ? raw.id : typeof raw.provider === 'string' ? raw.provider : 'unknown',
		kind: typeof raw.kind === 'string' ? raw.kind : '',
		label: typeof raw.label === 'string' ? raw.label : '',
		credentialKey: typeof raw.credentialKey === 'string' ? raw.credentialKey : null,
		credentialConfigured: raw.credentialConfigured === true,
		credentialSource: typeof raw.credentialSource === 'string' ? raw.credentialSource : null,
		maskedHint: typeof raw.maskedHint === 'string' ? raw.maskedHint : null,
		testable: raw.testable === true,
		// The route calls it `defaultSelected`; the console calls it `isDefault`.
		isDefault: raw.isDefault === true || raw.defaultSelected === true,
		selectionReason: typeof raw.selectionReason === 'string' ? raw.selectionReason : null,
		models: modelDetails.map((entry) => entry.id),
		modelDetails,
		lastHealth:
			health && typeof health === 'object'
				? {
						status: typeof health.status === 'string' ? health.status : 'unknown',
						latencyMs: typeof health.latencyMs === 'number' ? health.latencyMs : null,
						message: typeof health.message === 'string' ? health.message : '',
						checkedAt: typeof health.checkedAt === 'string' ? health.checkedAt : '',
					}
				: null,
	};
}

/**
 * `GET /control/ai/providers`.
 *
 * Normalised here rather than in the page for the same reason `getConfig` is: the route
 * returns the provider's `id`, a `health` object and `models` as `{id, use}` pairs, and
 * the page is entitled to a stable shape. Three of those keys used to be read under names
 * the API never sent (`provider`, `lastHealth`, `models` as strings), and the result was a
 * provider table that rendered a blank id, `[object Object]` for every model, and the
 * false claim **"never tested"** on providers with recorded health checks.
 */
export async function getAiProviders(): Promise<{
	providers: AiProviderRow[];
	notes: string[];
	defaultModel: string | null;
	fallbackModel: string | null;
}> {
	const data = unwrap<Record<string, unknown>>(await request<unknown>('/control/ai/providers'));
	const rawProviders = Array.isArray(data.providers) ? (data.providers as RawAiProvider[]) : [];
	return {
		providers: rawProviders.map(normaliseProvider),
		notes: (data.notes as string[]) ?? [],
		defaultModel: (data.defaultModel as string) ?? null,
		fallbackModel: (data.fallbackModel as string) ?? null,
	};
}

export async function getAiRouting(): Promise<Record<string, unknown>> {
	return unwrap<Record<string, unknown>>(await request<unknown>('/control/ai/routing'));
}

export async function getVoiceConfig(): Promise<Record<string, unknown>> {
	return unwrap<Record<string, unknown>>(await request<unknown>('/control/voice/config'));
}

export async function getVoiceHealth(): Promise<Record<string, unknown>> {
	return unwrap<Record<string, unknown>>(await request<unknown>('/control/voice/health'));
}

export async function testVoice(body: {
	kind: 'stt' | 'tts' | 'pipeline';
	provider?: string;
}): Promise<{ steps: Array<Record<string, unknown>>; verdict: string; notes: string[] }> {
	return unwrap(
		await request<unknown>('/control/voice/test', { method: 'POST', body: JSON.stringify(body) }),
	);
}

export async function getAvatarConfig(): Promise<Record<string, unknown>> {
	return unwrap<Record<string, unknown>>(await request<unknown>('/control/avatar/config'));
}

export async function getAiModelsApi(): Promise<Record<string, unknown>> {
	return unwrap<Record<string, unknown>>(await request<unknown>('/control/ai/models'));
}

/** `GET /control/admins` — role bindings and candidates for the permission matrix. */
export async function getAdmins(): Promise<{
	candidates: number;
	roleBindings: Array<Record<string, unknown>>;
	note: string | null;
}> {
	const data = unwrap<{ candidates?: number; roleBindings?: Array<Record<string, unknown>>; note?: string | null }>(
		await request<unknown>('/control/admins'),
	);
	return {
		candidates: data.candidates ?? 0,
		roleBindings: data.roleBindings ?? [],
		note: data.note ?? null,
	};
}

/**
 * `GET /control/controls`.
 *
 * The route returns the control state and the definitions together; the console's
 * `getControls` normalises both shapes already, so this alias exists for pages that want
 * the pair explicitly.
 */
export async function getControlsAndDefinitions(): Promise<{
	controls: RuntimeControls;
	definitions: Array<Record<string, unknown>>;
}> {
	const data = unwrap<Record<string, unknown>>(await request<unknown>('/control/controls'));
	const definitions = Array.isArray(data.definitions) ? (data.definitions as Array<Record<string, unknown>>) : [];
	const controls = (data.controls as RuntimeControls | undefined) ?? (data as unknown as RuntimeControls);
	return { controls, definitions };
}

// ─── Platform role assignment ────────────────────────────────────────────────

export type PlatformRoleGrant = {
	id: string;
	userId: string;
	email: string | null;
	name: string | null;
	role: string;
	roleKnown: boolean;
	permissionCount: number;
	permissions: string[];
	grantedBy: string | null;
	reason: string | null;
	createdAt: string;
	updatedAt: string;
};

export type PlatformRolesResponse = {
	grants: PlatformRoleGrant[];
	caller: {
		userId: string | null;
		claimRole: string | null;
		grantSource: 'grant' | 'claim' | null;
		canManageAdmins: boolean;
		canGrantUpTo: string[];
	};
	roles: Array<{ role: string; rank: number; permissionCount: number; description: string }>;
	availableAccounts: Array<{ id: string; email: string | null; name: string | null; disabled: boolean }>;
	notes: string[];
};

export async function getPlatformRoles(): Promise<PlatformRolesResponse> {
	return unwrap<PlatformRolesResponse>(await request<unknown>('/control/platform-roles'));
}

export async function grantPlatformRole(
	userId: string,
	body: { role: string; reason: string },
): Promise<{ userId: string; role: string; permissionCount: number; propagation: string }> {
	return unwrap(
		await request<unknown>(`/control/platform-roles/${encodeURIComponent(userId)}`, {
			method: 'PUT',
			body: JSON.stringify(body),
		}),
	);
}

export async function revokePlatformRole(
	userId: string,
	body: { reason: string; confirm: string },
): Promise<{ userId: string; revoked: boolean; propagation: string }> {
	return unwrap(
		await request<unknown>(`/control/platform-roles/${encodeURIComponent(userId)}`, {
			method: 'DELETE',
			body: JSON.stringify(body),
		}),
	);
}

// ─── Administrator sessions ──────────────────────────────────────────────────

/**
 * One console session, as the registry reports it.
 *
 * `state` is the server's decision — `active` means unrevoked *and* unexpired — and `current`
 * marks the session making the request. The console must not re-derive either: doing so is how a
 * session whose token expired an hour ago gets counted as a live operator.
 */
export type AdminSessionRow = {
	id: string;
	user: { id: string; email: string | null; name: string | null; disabled: boolean };
	role: string;
	ipAddress: string | null;
	userAgent: string | null;
	expiresAt: string;
	revokedAt: string | null;
	lastSeenAt: string;
	createdAt: string;
	state: 'active' | 'expired' | 'revoked';
	current: boolean;
};

export type AdminSessionListPage = {
	rows: AdminSessionRow[];
	totalItems: number | null;
	totalPages: number | null;
	counts: { active: number; revoked: number; expired: number } | null;
	notes: string[];
};

export async function listAdminSessions(params: ListParams = {}): Promise<AdminSessionListPage> {
	const data = unwrap<{
		data?: AdminSessionRow[];
		totalItems?: number;
		totalPages?: number;
		counts?: AdminSessionListPage['counts'];
		notes?: string[];
	}>(await request<unknown>('/control/admin-sessions', { params }));
	return {
		rows: data.data ?? [],
		totalItems: data.totalItems ?? null,
		totalPages: data.totalPages ?? null,
		counts: data.counts ?? null,
		notes: data.notes ?? [],
	};
}

export async function revokeAdminSession(
	id: string,
	body: { reason: string },
): Promise<{ revoked: boolean; userId: string; alreadyRevoked: boolean; propagation: string }> {
	return unwrap(
		await request<unknown>(`/control/admin-sessions/${encodeURIComponent(id)}/revoke`, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	);
}

// ─── Audit-log export ────────────────────────────────────────────────────────

export type AuditExportResult = {
	csv: string;
	filename: string;
	/** Rows in the file, as the API counted them. */
	rows: number;
	/** True when the API's row cap was reached, so the file is not the whole log. */
	truncated: boolean;
};

/**
 * `GET /control/audit-logs/export` — a CSV copy of the administrator audit log.
 *
 * Written with `fetch` rather than the shared `request()` helper because the response is
 * `text/csv`, not the API's JSON envelope, and `request()` sets `Accept: application/json` and
 * parses accordingly. Everything else is the same: the internal base URL so the console does not
 * hairpin out through the public hostname, and the operator's token from the cookie.
 *
 * The row count and the truncation flag travel in response headers, which is what a client that
 * streams the file to disk needs — it never renders a body note.
 */
export async function fetchAuditExportCsv(params: ListParams = {}): Promise<AuditExportResult> {
	const base = await resolveApiBase();
	const token = await readToken();
	if (!token) {
		const error = new Error('No admin token is available for this request.') as Error & { status?: number };
		error.status = 401;
		throw error;
	}

	const query = Object.entries({ ...params })
		.filter(([, value]) => value !== undefined && value !== null && value !== '')
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
		.join('&');
	const url = `${base}/control/audit-logs/export${query ? `?${query}` : ''}`;

	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'text/csv' },
		cache: 'no-store',
	});

	if (!res.ok) {
		// The status is preserved so the caller can answer 401/403 verbatim instead of turning a
		// permission failure into a generic 500.
		const body = await res.text().catch(() => '');
		const error = new Error(
			`Admin API ${res.status} ${res.statusText} on /control/audit-logs/export${body ? `: ${body.slice(0, 200)}` : ''}`,
		) as Error & { status?: number };
		error.status = res.status;
		throw error;
	}

	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'nova-admin-audit.csv';

	return {
		csv: await res.text(),
		filename,
		rows: Number(res.headers.get('x-nova-export-rows') ?? 0),
		truncated: res.headers.get('x-nova-export-truncated') === 'true',
	};
}

// ─── Security Center ─────────────────────────────────────────────────────────

export type SecurityOverview = {
	window: { days: number; since: string };
	signIns: {
		succeeded: number;
		failed: number;
		byReason: Array<{ reason: string; count: number }>;
		topAttemptedEmails: Array<{ email: string | null; attempts: number }>;
		topSourceAddresses: Array<{ ip: string | null; attempts: number }>;
		recentFailures: Array<Record<string, unknown>>;
		/** False when nothing has ever been recorded, which is not the same as zero failures. */
		instrumented: boolean;
	};
	refusals: {
		total: number;
		topActors: Array<{ actorEmail: string | null; role: string | null; refusals: number }>;
		topPermissions: Array<{ permission: string | null; refusals: number }>;
		topActions: Array<{ action: string; refusals: number }>;
		recent: Array<Record<string, unknown>>;
	};
	adminSessions: {
		active: number;
		revoked: number;
		expired: number;
		soonestExpiring: Array<Record<string, unknown>>;
	};
	privilegeChanges: Array<Record<string, unknown>>;
	configurationChanges: Array<Record<string, unknown>>;
	credentials: Array<{
		key: string;
		configured: boolean;
		source: string;
		lastTestStatus: string | null;
		lastTestedAt: string | null;
		/** True when the recorded test describes a value that has since been replaced. */
		testStale: boolean;
		testedBy: string[];
	}>;
	watchlist: Array<{
		actorEmail: string | null;
		role: string | null;
		refusals: number;
		distinctPermissions: number;
		firstSeen: string;
		lastSeen: string;
	}>;
	notes: string[];
};

export async function getSecurityOverview(days = 7): Promise<SecurityOverview> {
	return unwrap<SecurityOverview>(await request<unknown>('/control/security/overview', { params: { days } }));
}

// ─── Administrator MFA ───────────────────────────────────────────────────────

export type MfaStatus = {
	enrolled: boolean;
	confirmed: boolean;
	confirmedAt: string | null;
	remainingRecoveryCodes: number;
	lastUsedCounter: number | null;
};

export type MfaEnrolmentStart = { secret: string; otpauthUri: string };
export type MfaCoverage = { confirmed: number; pending: number; adminsWithout: number };

/** The signed-in operator's own factor status. Not permissioned: it is their own account. */
export async function getMfaStatus(): Promise<MfaStatus> {
	return unwrap<MfaStatus>(await request<unknown>('/control/admin-mfa'));
}

export async function beginMfaEnrolment(): Promise<MfaEnrolmentStart> {
	return unwrap<MfaEnrolmentStart>(
		await request<unknown>('/control/admin-mfa/enrol', { method: 'POST', body: JSON.stringify({}) }),
	);
}

export async function confirmMfaEnrolment(code: string): Promise<{ confirmed: boolean; recoveryCodes: string[] }> {
	return unwrap<{ confirmed: boolean; recoveryCodes: string[] }>(
		await request<unknown>('/control/admin-mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
	);
}

export async function regenerateMfaRecoveryCodes(code: string): Promise<{ recoveryCodes: string[] }> {
	return unwrap<{ recoveryCodes: string[] }>(
		await request<unknown>('/control/admin-mfa/recovery-codes', { method: 'POST', body: JSON.stringify({ code }) }),
	);
}

export async function disableMfa(password: string, code: string): Promise<{ confirmed: boolean }> {
	return unwrap<{ confirmed: boolean }>(
		await request<unknown>('/control/admin-mfa/disable', { method: 'POST', body: JSON.stringify({ password, code }) }),
	);
}

/** How many administrators have a confirmed factor. For the Security Center. */
export async function getMfaCoverage(): Promise<MfaCoverage> {
	return unwrap<MfaCoverage>(await request<unknown>('/control/admin-mfa/coverage'));
}

// ─── Permissions: the authority, not a copy ──────────────────────────────────

export type PermissionDescriptor = {
	permission: string;
	group: string;
	label: string;
	description: string;
	dangerous: boolean;
};

export type RoleMatrixEntry = {
	role: string;
	rank: number;
	permissions: string[];
};

export type PermissionCatalog = {
	catalog: PermissionDescriptor[];
	roles: RoleMatrixEntry[];
	notes: string[];
};

/**
 * The catalogue and role matrix, from the API.
 *
 * The console used to render a hand-maintained copy of this. Two lists kept in step by hand drift,
 * and the one an operator reads should be the one the server enforces.
 */
export async function getPermissionCatalog(): Promise<PermissionCatalog> {
	return unwrap<PermissionCatalog>(await request<unknown>('/control/permissions'));
}

export type MyPermissions = {
	email: string | null;
	platformRole: string | null;
	adminRole: string | null;
	permissions: string[];
	source: string;
	notes: string[];
};

/**
 * What the **server** says this operator may do.
 *
 * Used for navigation gating instead of decoding the role claim locally. The difference is not
 * cosmetic: a database grant overrides the claim, so the claim alone can describe access the server
 * would refuse — and hiding destinations the server would allow.
 */
export async function getMyPermissions(): Promise<MyPermissions> {
	return unwrap<MyPermissions>(await request<unknown>('/control/me/permissions'));
}
