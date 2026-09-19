// Load a local `.env` before anything else is imported.
//
// Import evaluation is hoisted above the module body, so without this the
// modules pulled in below (and `../server.js` at the bottom in particular)
// read process.env before this file has set anything. That made the suite
// depend on whatever happened to be exported in the developer's shell.
import 'dotenv/config';

import { vi, expect } from 'vitest';
import { z } from 'zod';

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
};

type QueryUpdate = {
	table?: any;
	set: (set: any) => { where: (where: any) => { returning: (cols: string[]) => Promise<any[]> } };
};
type QueryDelete = {
	where: (where: any) => { returning: (cols: string[]) => Promise<any[]> };
};

vi.mock('../db/connection', () => {
	const mockDb = () => ({
		select: vi.fn(async (_table?: string, _opts?: any) => defaultSelectResults[_table || ''] ?? []),
		insert: vi.fn(async () => [{ id: 'new-1' }]),
		update: vi.fn(async () => []),
		delete: vi.fn(async () => []),
	});
	const db = mockDb();
	const qb = {
		select() { return db; },
		insert() { return db; },
		update: () => ({}),
		delete: () => ({}),
	} as any;
	return {
		getDb: () => db,
		getDbClient: () => ({ query: vi.fn(async (sql: string) => ({ rows: [] })) }),
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

vi.mock('../config', () => ({
	config: {
		PORT: 3001,
		DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/nova_test',
		JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long',
		JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-chars-long!',
		REDIS_URL: 'redis://localhost:6379',
		ANTHROPIC_API_KEY: 'test-anthropic',
		ELEVENLABS_API_KEY: 'test-elevenlabs',
		SARVAM_API_KEY: 'test-sarvam',
		OPENAI_API_KEY: 'test-openai',
		DEEPGRAM_API_KEY: 'test-deepgram',
		CORS_ORIGIN: '*',
		LOG_LEVEL: 'warn',
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
