/**
 * NOVA API — Prometheus metrics endpoint.
 *
 * The ops documentation promised a `/metrics` surface that no code served, so a
 * scrape would have failed forever while looking like a misconfiguration. These
 * tests pin the parts that make the surface safe to expose rather than merely
 * present: the format Prometheus can parse, the refusal of a public caller, the
 * token path, and — most importantly — that labels come from route patterns
 * instead of raw URLs, because raw URLs would create one time series per
 * recording id and take the scraper down.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import './setup.js';

import app from '../server.js';
import { normalisePath } from '../metrics/registry.js';

const ORIGINAL_TOKEN = process.env.METRICS_TOKEN;
const UUID = '3f9a1c22-5b7e-4a10-9c3d-2b8f7e6d5a41';

beforeEach(() => {
	delete process.env.METRICS_TOKEN;
});

afterEach(() => {
	if (ORIGINAL_TOKEN === undefined) delete process.env.METRICS_TOKEN;
	else process.env.METRICS_TOKEN = ORIGINAL_TOKEN;
});

describe('GET /metrics', () => {
	it('serves Prometheus text format with the HTTP series registered', async () => {
		const res = await request(app).get('/metrics');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/plain');
		expect(res.text).toContain('# HELP http_requests_total');
		expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
	});

	it('exposes database pool gauges read at scrape time', async () => {
		const res = await request(app).get('/metrics');
		expect(res.text).toContain('db_connection_pool_active');
		expect(res.text).toContain('db_connection_pool_idle');
	});

	it('requires the bearer token once METRICS_TOKEN is set', async () => {
		process.env.METRICS_TOKEN = 'metrics-token-for-tests-0123456789';

		const anonymous = await request(app).get('/metrics');
		expect(anonymous.status).toBe(401);

		const wrong = await request(app).get('/metrics').set('Authorization', 'Bearer not-the-token');
		expect(wrong.status).toBe(401);

		const right = await request(app)
			.get('/metrics')
			.set('Authorization', 'Bearer metrics-token-for-tests-0123456789');
		expect(right.status).toBe(200);
		expect(right.text).toContain('http_requests_total');
	});

	it('labels requests by route pattern, never by raw id', async () => {
		// Unauthenticated, so this never reaches a handler and has no matched
		// route — the case where a naive implementation would label with the URL.
		await request(app).get(`/api/v1/recordings/${UUID}`);

		const res = await request(app).get('/metrics');
		expect(res.text).toContain('/api/v1/recordings/:id');
		expect(res.text).not.toContain(UUID);
	});

	it('does not count scrapes as application traffic', async () => {
		const before = await request(app).get('/metrics');
		const countOf = (body: string) =>
			Number(body.match(/http_requests_total\{[^}]*path="\/metrics"[^}]*\}\s+(\d+)/)?.[1] ?? 0);

		await request(app).get('/metrics');
		const after = await request(app).get('/metrics');
		expect(countOf(after.text)).toBe(countOf(before.text));
	});
});

describe('normalisePath', () => {
	it('replaces uuid, numeric and long-hex segments with :id', () => {
		expect(normalisePath(`/api/v1/recordings/${UUID}/audio`)).toBe('/api/v1/recordings/:id/audio');
		expect(normalisePath('/api/v1/tasks/4821')).toBe('/api/v1/tasks/:id');
		expect(normalisePath('/api/v1/threads/9f8e7d6c5b4a39281706f5e4')).toBe('/api/v1/threads/:id');
	});

	it('leaves ordinary route words alone', () => {
		expect(normalisePath('/api/v1/auth/login')).toBe('/api/v1/auth/login');
		expect(normalisePath('/healthz')).toBe('/healthz');
	});
});
