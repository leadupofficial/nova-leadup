// Load a local `.env` before anything else is imported.
//
// Import evaluation is hoisted above the module body, so without this the
// modules pulled in below (and `../server.js` at the bottom in particular)
// read process.env before this file has set anything. That made the suite
// depend on whatever happened to be exported in the developer's shell.
import 'dotenv/config';

import { vi, expect } from 'vitest';
import { z } from 'zod';
import { getTableName } from 'drizzle-orm';

const envSchema = z.object({
	NODE_ENV: z.enum(['development','test','production']).default('development'),
	DATABASE_URL: z.string().url(),
	JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
	JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
	REDIS_URL: z.string().url().optional(),
	ANTHROPIC_API_KEY: z.string().optional(),
	ELEVENLABS_API_KEY: z.string().optional(),
	SARVAM_API_KEY: z.string().optional(),
	OPENAI_API_KEY: z.string().optional(),
	DEEPGRAM_API_KEY: z.string().optional(),
	LOG_LEVEL: z.enum(['debug','info','warn','error']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
	console.error('ZOD ISSUES:', JSON.stringify(parsed.error.issues, null, 2));
	throw new Error('Invalid environment configuration. Check logs for details.');
}

const testEnv = {
	NODE_ENV: 'test',
	JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long',
	JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-chars-long!',
	DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/nova_test',
	PORT: '3001',
	LOG_LEVEL: 'warn',
};

for (const [key, value] of Object.entries({ ...parsed.data, ...testEnv })) {
	process.env[key] = value;
}

const defaultSelectResults: Record<string, any[]> = {
	users: [{ id: 'user-1', email: 'existing@test.com', name: 'Test', locale: 'en-IN', timezone: 'Asia/Kolkata', disabled: false, password_hash: '$2a$12$73NeQhAdu49df/dhGTRrR.PWpoTt7BS04Ea.6yaK0qmi8cCK3XWIC', organization_id: 'org-1' }],
	sessions: [{ id: 'sess-1', user_id: 'user-1', refresh_token_hash: 'hash', expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), created_at: new Date(), revoked_at: null }],
	conversations: [{ id: 'conv-1', userId: 'user-1', title: 'test', mode: 'text', metadata: {}, createdAt: new Date(), updatedAt: new Date() }],
	conversationMessages: [{ id: 'msg-1', conversationId: 'conv-1', role: 'assistant', content: 'hi', model: 'fallback', tokenUsage: null, createdAt: new Date() }],
	memories: [{ id: 'mem-1', userId: 'user-1', content: 'test memory', embedding: null, metadata: {}, createdAt: new Date() }],
	memoryEmbeddings: [{ id: 'emb-1', memoryId: 'mem-1', embedding: null, metadata: {}, createdAt: new Date() }],
	tasks: [{ id: 'task-1', userId: 'user-1', title: 'test task', status: 'pending', metadata: {}, createdAt: new Date(), updatedAt: new Date() }],
	organizations: [{ id: 'org-1' }],
	// The privacy switches. Present so `getPrivacyPreferences` can be exercised at all:
	// without a row it falls back to `PRIVACY_DEFAULTS` (everything on) and every gated
	// route runs with saving enabled, which made the gates structurally untestable — a
	// future edit could delete one and the suite would stay green.
	// The mock returns rows verbatim and ignores the `select({...})` projection, so
	// these keys are the *destructured* names `getPrivacyPreferences` reads, not the
	// snake_case column names. A fixture keyed only by column name silently yields
	// `undefined` for every field, which `?? PRIVACY_DEFAULTS` turns back into "all
	// saving on" — a test would then pass while asserting nothing.
	privacy_preferences: [
		{
			id: 'prefs-1',
			userId: 'user-1',
			saveConversations: true,
			saveRecordings: true,
			saveTranscripts: true,
			saveMemories: true,
			autoDeleteRecordingsDays: 30,
			autoDeleteTranscriptsDays: 7,
			cloudProcessing: true,
			localProcessing: false,
		},
	],
};

/** The row the mock returns for `privacy_preferences`. */
const DEFAULT_PRIVACY_ROW = { ...defaultSelectResults.privacy_preferences[0] };

/**
 * Overrides the privacy row this suite's database mock returns.
 *
 * `getPrivacyPreferences` reads these columns, so a test can turn a switch off and
 * assert the route refuses to write — which is the only way the gates can be covered
 * without a real database. Pass `null` to simulate a user who has never opened Privacy
 * controls (no row), and `setPrivacyPreferencesRow()` with no argument to restore the
 * defaults.
 */
export function setPrivacyPreferencesRow(
	partial: Record<string, unknown> | null = DEFAULT_PRIVACY_ROW,
): void {
	defaultSelectResults.privacy_preferences =
		partial === null ? [] : [{ ...DEFAULT_PRIVACY_ROW, ...partial }];
}

/**
 * Drizzle-shaped in-memory query builder.
 *
 * The routes call `getDb()` and then use the real Drizzle API:
 *
 *   db.select({ count: sql`count(*)` }).from(tasks).where(where)
 *   db.select().from(conversations).where(...).orderBy(...).limit(1)
 *   db.insert(conversations).values({...}).returning()
 *   db.update(conversations).set({...}).where(...)
 *   db.delete(conversations).where(...)
 *
 * The previous mock returned a plain array from `select()`, so the very first
 * `.from(...)` on it was a TypeError and every DB-backed route answered 500.
 * These builders are thenable (Drizzle queries are awaited directly) and every
 * chain method returns itself, so a route can call any subset in any order.
 */
function tableNameOf(table: unknown): string {
	try {
		return getTableName(table as never);
	} catch {
		return '';
	}
}

function rowsFor(table: unknown): any[] {
	return defaultSelectResults[tableNameOf(table)] ?? [];
}

interface ChainState {
	rows: any[];
	selection?: Record<string, unknown>;
}

function chainOf(state: ChainState): any {
	const resolve = (): any[] => {
		// A `select({ count: sql`count(*)` })` projection resolves to a single
		// aggregate row, which is how the routes read pagination totals.
		if (state.selection && Object.prototype.hasOwnProperty.call(state.selection, 'count')) {
			return [{ count: state.rows.length }];
		}
		return state.rows;
	};

	const q: any = {};
	const passthrough = [
		'from', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'having',
		'leftJoin', 'innerJoin', 'rightJoin', 'fullJoin', 'for', 'with',
	];
	for (const method of passthrough) {
		q[method] = (table?: unknown) => {
			if (method === 'from' && table) state.rows = rowsFor(table);
			return q;
		};
	}
	q.then = (onFulfilled?: any, onRejected?: any) => Promise.resolve(resolve()).then(onFulfilled, onRejected);
	q.catch = (onRejected?: any) => Promise.resolve(resolve()).catch(onRejected);
	q.finally = (onFinally?: any) => Promise.resolve(resolve()).finally(onFinally);
	return q;
}

function insertChain(): any {
	let values: any = {};
	const q: any = {
		values: (v: any) => {
			values = Array.isArray(v) ? { ...v[0] } : { ...v };
			return q;
		},
		onConflictDoUpdate: () => q,
		onConflictDoNothing: () => q,
		returning: () => Promise.resolve([{ id: 'new-1', ...values }]),
	};
	q.then = (onFulfilled?: any, onRejected?: any) =>
		Promise.resolve([{ id: 'new-1', ...values }]).then(onFulfilled, onRejected);
	q.catch = (onRejected?: any) =>
		Promise.resolve([{ id: 'new-1', ...values }]).catch(onRejected);
	return q;
}

function updateChain(): any {
	let patch: any = {};
	const result = () => [{ id: 'updated-1', ...patch }];
	const q: any = {
		set: (v: any) => {
			patch = { ...v };
			return q;
		},
		where: () => q,
		returning: () => Promise.resolve(result()),
	};
	q.then = (onFulfilled?: any, onRejected?: any) => Promise.resolve(result()).then(onFulfilled, onRejected);
	q.catch = (onRejected?: any) => Promise.resolve(result()).catch(onRejected);
	return q;
}

function deleteChain(): any {
	const done = () => [] as any[];
	const q: any = { where: () => q, returning: () => Promise.resolve(done()) };
	q.then = (onFulfilled?: any, onRejected?: any) => Promise.resolve(done()).then(onFulfilled, onRejected);
	q.catch = (onRejected?: any) => Promise.resolve(done()).catch(onRejected);
	return q;
}

vi.mock('../db/connection', () => {
	const db = {
		select: (selection?: Record<string, unknown>) => chainOf({ rows: [], selection }),
		insert: (_table?: unknown) => insertChain(),
		update: (_table?: unknown) => updateChain(),
		delete: (_table?: unknown) => deleteChain(),
		execute: async (_query: unknown) => ({ rows: [] }),
	};
	const qb = {
		select: () => db,
		insert: () => db,
		update: () => db,
		delete: () => db,
	} as any;
	return {
		// Wrapped in `vi.fn` so an individual test can replace a single lookup
		// with `vi.mocked(getDb).mockReturnValueOnce(...)` — this in-memory
		// builder ignores `where`, so a test that needs an empty result (e.g. an
		// ownership-mismatch 404) cannot express it otherwise.
		getDb: vi.fn(() => db),
		/**
		 * The pool answers the account-state query `authenticate` makes before every route.
		 *
		 * `authenticate` checks that the token's subject is a real, enabled account, on a raw pool
		 * query rather than through `getDb()` — see the comment in `middleware/auth.ts` for why
		 * that distinction matters to this suite. Without an answer here every authenticated
		 * request would be refused as `ACCOUNT_DISABLED`, and the route under test would never
		 * run. Matching the projection rather than the table keeps this from interfering with the
		 * admin routes, which also read `users` but select many columns or a count.
		 */
		getDbPool: () => ({
			query: async (sql: unknown) => {
				const text = typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');
				if (/^\s*select\s+disabled\s+from\s+users\s+where\s+id\s*=/i.test(text)) {
					return { rows: [{ disabled: false }], rowCount: 1 };
				}
				return { rows: [], rowCount: 0 };
			},
		}),
		getDbClient: () => ({ query: async (_sql: string) => ({ rows: [] }) }),
		getQueryBuilder: () => qb,
	};
});

vi.mock('../redis', () => ({
	getRedis: () => ({
		connect: vi.fn().mockResolvedValue(undefined),
		ping: vi.fn().mockResolvedValue('PONG'),
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue('OK'),
		del: vi.fn().mockResolvedValue(1),
		exists: vi.fn().mockResolvedValue(0),
		keys: vi.fn().mockResolvedValue([]),
		quit: vi.fn().mockResolvedValue('OK'),
	}),
}));

/**
 * AI provider calls are stubbed at the provider boundary.
 *
 * These are network calls to Anthropic / Deepgram / ElevenLabs / Sarvam, none of
 * which a unit test should make: with the placeholder keys from `.env.test` they
 * do not merely fail, they hang until the test times out. Every route degrades
 * gracefully *around* a provider failure, so a deterministic stub is what lets
 * the route's own logic — persistence, fallbacks, response shaping — be tested.
 */
vi.mock('../services/ai.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../services/ai.js')>();
	const stubAudio = (contentType: string) => async () => ({
		audioBuffer: Buffer.from('mock-audio'),
		contentType,
	});
	const stubTranscript = (language: string) => async () => ({
		transcript: 'mock transcript',
		confidence: 0.99,
		language,
	});
	return {
		...actual,
		// Shaped like the real `ChatCompletionResult` (see services/ai.ts), not
		// just the two fields `content`-only callers read. A mock missing
		// `toolUses` made `runAssistantToolLoop` throw on `.length` of undefined,
		// so no suite could exercise a tool-bearing route through the shared
		// mock at all — the routes that use the loop were untestable here.
		// `usage` uses the provider-neutral camelCase keys the route code reads;
		// it used to report `input_tokens`/`output_tokens`, which every caller
		// silently turned into `undefined`.
		chatCompletion: vi.fn(async () => ({
			content: 'mock assistant reply',
			model: 'mock-model',
			usage: { inputTokens: 1, outputTokens: 1 },
			blocks: [{ type: 'text' as const, text: 'mock assistant reply' }],
			stopReason: null,
			toolUses: [],
		})),
		transcribeAudio: vi.fn(stubTranscript('en')),
		transcribeAudioSarvam: vi.fn(stubTranscript('ta')),
		transcribeAudioGoogle: vi.fn(stubTranscript('hi')),
		synthesizeSpeech: vi.fn(stubAudio('audio/mpeg')),
		synthesizeSpeechSarvam: vi.fn(stubAudio('audio/wav')),
		synthesizeSpeechGoogle: vi.fn(stubAudio('audio/mp3')),
		synthesizeSpeechDeepgram: vi.fn(stubAudio('audio/mpeg')),
	};
});

// Mirrors the *nested* shape `src/config.ts` actually exports.
//
// This mock used to be flat (`PORT`, `ANTHROPIC_API_KEY`, `CORS_ORIGIN`, …), which
// matched a config module that no longer exists. `src/server.ts` now reads
// `config.cors.origins`, so every one of the 20 suites aborted during collection
// with "Cannot read properties of undefined (reading 'origins')" and the run
// reported 0 tests — a green-looking `passWithNoTests` away from being missed.
// Keep this in step with `ApiConfig` in `src/config.ts`.
vi.mock('../config', () => ({
	config: {
		port: 3001,
		database: {
			host: 'localhost',
			port: 5432,
			database: 'nova_test',
			user: 'postgres',
			password: 'postgres',
		},
		redis: { host: 'localhost', port: 6379 },
		storage: {
			endpoint: 'http://localhost:9000',
			port: 9000,
			accessKey: 'test-access-key',
			secretKey: 'test-secret-key',
			bucket: 'nova-test',
		},
		jwt: {
			secret: 'test-secret-key-that-is-at-least-32-chars-long',
			refreshSecret: 'test-refresh-secret-that-is-at-least-32-chars-long!',
			expiresIn: '1h',
		},
		cors: { origins: ['http://localhost:3000'] },
		services: {
			anthropicApiKey: 'test-anthropic',
			anthropicBaseUrl: 'https://api.anthropic.com',
			broCodeKey: '',
			elevenlabsApiKey: 'test-elevenlabs',
			deepgramApiKey: 'test-deepgram',
			sarvamApiKey: 'test-sarvam',
			googleCloudApiKey: '',
		},
	},
}));

const { createServer } = await import('node:http');
import http from 'node:http';
import request from 'supertest';
import app from '../server.js';

let server: http.Server | undefined;

export function getTestServer(): http.Server {
	if (!server) {
		server = app.listen(3001, '127.0.0.1');
	}
	return server;
}

export const testRequest = () => request(getTestServer());

export async function createTestRequest(
	expressApp: import('express').Express,
): Promise<ReturnType<typeof request>> {
	const s = createServer(expressApp);
	await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
	const srv = s as any;
	return request(srv);
}

(global as any).API_BASE = '/api';
