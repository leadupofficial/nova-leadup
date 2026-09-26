/**
 * NOVA — Prometheus metrics.
 *
 * `docs/operations/monitoring.md` described a `/metrics` endpoint, a metric
 * catalogue and alerting rules, but nothing served any of it: there was no
 * exporter, no registry and no route. An operator following that document would
 * have configured a scrape that could never succeed, which is worse than having
 * no document — the absence looks like a misconfiguration instead of a gap.
 *
 * This module is the missing exporter. What it deliberately does *not* do is
 * invent the rest of the catalogue: the document's Redis, auth and business
 * metrics are not instrumented anywhere in the code, and rather than fabricate
 * zeros the doc now says which series exist. A metric that always reads 0 is a
 * lie an alerting rule will eventually believe.
 *
 * Cardinality is the other hazard. Path labels come from the Express route
 * pattern (`/api/v1/recordings/:id`), never from the raw URL — labelling by raw
 * URL would create a new time series per recording id and take Prometheus down
 * with it. Requests that never match a route (401s, 404s) fall back to a
 * normaliser that replaces id-shaped segments with `:id`.
 */
import { timingSafeEqual } from 'node:crypto';
import {
	Counter,
	Gauge,
	Histogram,
	Registry,
	collectDefaultMetrics,
} from 'prom-client';
import type { NextFunction, Request, Response } from 'express';
import { getDbPool } from '../db/connection.js';
import { logger } from '../utils/logger.js';

export const registry = new Registry();

export const httpRequestsTotal = new Counter({
	name: 'http_requests_total',
	help: 'HTTP requests handled, by method, route pattern and status code.',
	labelNames: ['method', 'path', 'status'],
	registers: [registry],
});

export const httpRequestDuration = new Histogram({
	name: 'http_request_duration_seconds',
	help: 'HTTP request latency in seconds, by method and route pattern.',
	labelNames: ['method', 'path'],
	// Tuned for a voice product: a healthy turn is well under a second, and the
	// interesting failures are the ones that cross the realtime budget.
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
	registers: [registry],
});

/**
 * Which build is actually serving. Without this, "is the deploy live?" is
 * answered by grepping a container filesystem, which is how the trust-proxy fix
 * had to be confirmed before this existed.
 */
export const buildInfo = new Gauge({
	name: 'nova_build_info',
	help: 'Build identity of the running API (always 1).',
	labelNames: ['version', 'commit'],
	registers: [registry],
});

// Pool gauges are read at scrape time rather than counted, because the pool
// knows its own state and a duplicate counter would drift from it.
//
// The reads are defensive on purpose. `pg.Pool` exposes these counters, but the
// pool is a seam other code substitutes, and an absent counter used to yield
// `NaN` — which prom-client rejects, so one unreadable gauge failed the whole
// scrape and left the scraper waiting on a handler that never responded. An
// unreadable value now emits no sample rather than a fabricated `0`: "the pool
// is empty" and "the pool could not be read" are different statements, and only
// the first should ever fire an alert.
function poolCounter(read: (pool: ReturnType<typeof getDbPool>) => number): number | undefined {
	try {
		const value = read(getDbPool());
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

new Gauge({
	name: 'db_connection_pool_active',
	help: 'Database connections currently checked out.',
	registers: [registry],
	collect() {
		const active = poolCounter((pool) => pool.totalCount - pool.idleCount);
		if (active !== undefined) this.set(Math.max(active, 0));
	},
});

new Gauge({
	name: 'db_connection_pool_idle',
	help: 'Database connections open but unused.',
	registers: [registry],
	collect() {
		const idle = poolCounter((pool) => pool.idleCount);
		if (idle !== undefined) this.set(idle);
	},
});

new Gauge({
	name: 'db_connection_pool_waiting',
	help: 'Requests queued waiting for a database connection.',
	registers: [registry],
	collect() {
		const waiting = poolCounter((pool) => pool.waitingCount);
		if (waiting !== undefined) this.set(waiting);
	},
});

let defaultMetricsStarted = false;

/**
 * Starts the process-level collectors (CPU, heap, GC, event-loop lag).
 *
 * Called from the server bootstrap rather than at import time: prom-client's
 * default collectors hold a timer, and starting one as a side effect of
 * importing the app would leave a handle open in every test run.
 */
export function startDefaultMetrics(version: string, commit: string): void {
	if (defaultMetricsStarted) return;
	defaultMetricsStarted = true;
	collectDefaultMetrics({ register: registry });
	buildInfo.set({ version, commit }, 1);
}

/** Replaces id-shaped path segments so an unmatched request cannot explode cardinality. */
export function normalisePath(path: string): string {
	return path
		.split('?')[0]
		.split('/')
		.map((segment) =>
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
			/^\d+$/.test(segment) ||
			/^[0-9a-f]{24,}$/i.test(segment)
				? ':id'
				: segment,
		)
		.join('/');
}

function routeLabel(req: Request): string {
	// Read in the response's `finish` handler, by which point Express has already
	// unwound the router stack: `req.baseUrl` is empty again and `req.path` is
	// relative to the last router entered. A route pattern is therefore only
	// usable when its mount prefix survived, and `req.originalUrl` — which routers
	// never rewrite — is the dependable input. It still yields the same shape for
	// id-bearing paths, because `normalisePath` collapses those segments.
	const pattern = (req as Request & { route?: { path?: string } }).route?.path;
	if (pattern && req.baseUrl) return `${req.baseUrl}${pattern}`;
	return normalisePath((req.originalUrl || req.path).split('?')[0]);
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
	// Scrapes are not application traffic; counting them makes the scrape rate
	// look like load and would let a busy Prometheus distort the SLO numbers.
	if (req.path === '/metrics') return next();

	const start = process.hrtime.bigint();
	res.on('finish', () => {
		const seconds = Number(process.hrtime.bigint() - start) / 1e9;
		const labels = { method: req.method, path: routeLabel(req) };
		httpRequestsTotal.inc({ ...labels, status: String(res.statusCode) });
		httpRequestDuration.observe(labels, seconds);
	});
	next();
}

function constantTimeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Loopback and RFC1918 addresses only.
 *
 * In production the container's port is published on 127.0.0.1, so no public
 * request can reach this anyway; the check exists for the case where someone
 * publishes the port, and it is evaluated against `req.ip`, which the server's
 * loopback-only `trust proxy` setting resolves to the real client rather than
 * to the nginx hop.
 */
function isPrivateAddress(ip: string | undefined): boolean {
	if (!ip) return false;
	const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
	if (address === '::1' || address === '127.0.0.1') return true;
	if (address.startsWith('10.') || address.startsWith('192.168.')) return true;
	if (address.startsWith('172.')) {
		const second = Number(address.split('.')[1]);
		if (second >= 16 && second <= 31) return true;
	}
	if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
	return false;
}

export async function metricsHandler(req: Request, res: Response): Promise<void> {
	const token = process.env.METRICS_TOKEN;
	if (token) {
		const header = req.get('authorization') ?? '';
		const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
		if (!constantTimeEquals(provided, token)) {
			res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'A metrics token is required.' } });
			return;
		}
	} else if (!isPrivateAddress(req.ip)) {
		res.status(403).json({
			success: false,
			error: {
				code: 'FORBIDDEN',
				message: 'Metrics are available to private addresses, or to any caller presenting METRICS_TOKEN.',
			},
		});
		return;
	}

	// Collection can fail — a collector reaching a subsystem that is down, for
	// instance. Express 4 does not catch a rejected async handler, so without this
	// the request would simply never be answered and every scrape would sit until
	// it timed out, with nothing in the log to say why. Answering with 503 keeps
	// the failure visible and bounded.
	try {
		const body = await registry.metrics();
		res.setHeader('Content-Type', registry.contentType);
		res.send(body);
	} catch (error) {
		logger.error({ err: error }, 'Metrics collection failed');
		if (!res.headersSent) {
			res.status(503).json({
				success: false,
				error: { code: 'METRICS_UNAVAILABLE', message: 'Metrics could not be collected.' },
			});
		}
	}
}
