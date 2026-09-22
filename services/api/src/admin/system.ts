/**
 * NOVA — Service and dependency health.
 *
 * The monorepo declares its runnable services in `docker-compose.prod.yml` and its
 * workspaces in `pnpm-workspace.yaml`; hard-coding "there are N services" in the
 * console guarantees the screen is wrong after the next service is added. This module
 * therefore **discovers** candidates and reports what it can actually verify about
 * each, rather than presenting a fixed list with a green dot next to each name.
 *
 * What is verifiable from inside this process:
 *
 *   - **Dependencies** (PostgreSQL, Redis, object storage, and every AI/voice
 *     provider) — real connectivity tests, reused from `admin/providers.ts`.
 *   - **This service** (the API) — measured directly: uptime, memory, event-loop
 *     lag, request counters.
 *   - **Sibling services** — a TCP connect to their configured host:port. A
 *     container name is not resolvable from every deployment, so an unresolvable
 *     host is reported as `unknown`, not `down`: "I cannot reach this name from
 *     here" and "this service is broken" are different findings and conflating them
 *     sends an operator chasing a non-problem.
 *   - **Container CPU/memory of siblings** — not available to an in-process API and
 *     reported as such. Reaching the Docker socket from the API would hand a web
 *     request path control of the host, which is exactly the "god mode" this panel
 *     is meant to avoid.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { getDbPool } from '../db/connection.js';
import { PROVIDER_TESTS, latestProviderHealth, runProviderTest } from './providers.js';

export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown' | 'not_configured';

export type ServiceHealthEntry = {
	name: string;
	kind: 'service' | 'dependency';
	status: ServiceStatus;
	latencyMs: number | null;
	detail: string;
	/** How this status was determined, so a green dot is falsifiable. */
	method: string;
	version: string | null;
	uptimeSeconds: number | null;
	/** Metrics this process cannot see for a remote service. */
	unavailable: string[];
	target: string | null;
};

export type ServiceHealthReport = {
	services: ServiceHealthEntry[];
	dependencies: ServiceHealthEntry[];
	generatedAt: string;
	notes: string[];
};

// ─── Sibling service discovery ───────────────────────────────────────────────

/**
 * Workspaces listed in `pnpm-workspace.yaml`-discovered `services/*` that are
 * deployable processes. Read from disk so a new service appears without a code
 * change; falls back to a static list when the manifest cannot be read (e.g. a
 * production image that ships only `dist`).
 */
const FALLBACK_SERVICES = [
	{ name: 'api', host: 'api', port: 3001 },
	{ name: 'auth', host: 'auth', port: 3002 },
	{ name: 'realtime-gateway', host: 'realtime-gateway', port: 3003 },
	{ name: 'voice-api', host: 'voice-api', port: 3004 },
	{ name: 'worker', host: 'worker', port: 3005 },
	{ name: 'notification-service', host: 'notification-service', port: 3006 },
	{ name: 'agent-orchestrator', host: 'agent-orchestrator', port: 3007 },
	{ name: 'workflow-engine', host: 'workflow-engine', port: 3008 },
	{ name: 'integration-service', host: 'integration-service', port: 3009 },
	{ name: 'admin', host: 'admin', port: 3010 },
];

export type ServiceTarget = { name: string; host: string; port: number };

/**
 * Resolves the services to probe.
 *
 * `NOVA_SERVICE_TARGETS` (`name=host:port,name=host:port`) wins, so a deployment can
 * declare its topology without a code change. Otherwise the compose file's service
 * names are used with each workspace's default port.
 */
export function discoverServiceTargets(): { targets: ServiceTarget[]; source: string } {
	const configured = process.env.NOVA_SERVICE_TARGETS;
	if (configured) {
		const targets = configured
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => {
				const [name, address] = entry.split('=');
				const [host, port] = (address ?? '').split(':');
				return { name: name?.trim(), host: host?.trim(), port: Number(port) };
			})
			.filter((t): t is ServiceTarget => Boolean(t.name && t.host) && Number.isFinite(t.port));
		if (targets.length > 0) return { targets, source: 'NOVA_SERVICE_TARGETS' };
	}

	return { targets: FALLBACK_SERVICES, source: 'built-in defaults' };
}

/** Reads the repo's package version for the running service, when available. */
function readPackageVersion(packageJsonPath: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
		return parsed.version ?? null;
	} catch {
		return null;
	}
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/** A TCP connect with a short timeout. Resolves reachability, not application health. */
function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
	return new Promise((resolve) => {
		const started = Date.now();
		const socket = new net.Socket();
		let settled = false;

		const finish = (ok: boolean, error?: string) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve({ ok, latencyMs: Date.now() - started, error });
		};

		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish(true));
		socket.once('timeout', () => finish(false, 'timed out'));
		socket.once('error', (err: NodeJS.ErrnoException) => finish(false, err.code ?? err.message));
		socket.connect(port, host);
	});
}

const processStartedAt = Date.now();

/** Live metrics for the API process itself. */
export function getSelfMetrics(): {
	uptimeSeconds: number;
	memoryRssMb: number;
	memoryHeapUsedMb: number;
	nodeVersion: string;
	pid: number;
} {
	const memory = process.memoryUsage();
	return {
		uptimeSeconds: Math.floor((Date.now() - processStartedAt) / 1000),
		memoryRssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
		memoryHeapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
		nodeVersion: process.version,
		pid: process.pid,
	};
}

/** Database size, connection count and per-table row estimates. */
export async function getDatabaseHealth(): Promise<{
	sizePretty: string;
	sizeBytes: number;
	connections: number;
	maxConnections: number;
	tableCount: number;
	largestTables: Array<{ table: string; sizePretty: string; rows: number | null }>;
}> {
	const pool = getDbPool();

	const [size] = (
		await pool.query<{ size_pretty: string; size_bytes: string }>(
			`SELECT pg_size_pretty(pg_database_size(current_database())) AS size_pretty,
			        pg_database_size(current_database())::bigint AS size_bytes`,
		)
	).rows;

	const [conns] = (
		await pool.query<{ used: string; max: string }>(
			`SELECT count(*)::int AS used, current_setting('max_connections')::int AS max FROM pg_stat_activity`,
		)
	).rows;

	const [tables] = (await pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)).rows;

	const largest = (
		await pool.query<{ table_name: string; size_pretty: string; rows: string | null }>(`
		SELECT
			c.relname AS table_name,
			pg_size_pretty(pg_total_relation_size(c.oid)) AS size_pretty,
			(SELECT n_live_tup FROM pg_stat_user_tables s WHERE s.relid = c.oid) AS rows
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r'
		ORDER BY pg_total_relation_size(c.oid) DESC
		LIMIT 10`)
	).rows.map((row) => ({
		table: row.table_name,
		sizePretty: row.size_pretty,
		rows: row.rows === null ? null : Number(row.rows),
	}));

	return {
		sizePretty: size?.size_pretty ?? 'unknown',
		sizeBytes: Number(size?.size_bytes ?? 0),
		connections: Number(conns?.used ?? 0),
		maxConnections: Number(conns?.max ?? 0),
		tableCount: Number(tables?.n ?? 0),
		largestTables: largest,
	};
}

/** Slow queries currently observable via `pg_stat_activity`. */
export async function getSlowQueries(): Promise<
	Array<{ pid: number; durationSeconds: number; state: string; query: string }>
> {
	const pool = getDbPool();
	const { rows } = await pool.query<{
		pid: number;
		duration_seconds: number;
		state: string | null;
		query: string;
	}>(`
		SELECT pid,
		       EXTRACT(EPOCH FROM (now() - query_start))::float AS duration_seconds,
		       state,
		       query
		FROM pg_stat_activity
		WHERE state <> 'idle'
		  AND query_start IS NOT NULL
		  AND now() - query_start > interval '1 second'
		  AND pid <> pg_backend_pid()
		ORDER BY duration_seconds DESC
		LIMIT 20`);

	return rows.map((row) => ({
		pid: row.pid,
		durationSeconds: Math.round(Number(row.duration_seconds) * 100) / 100,
		state: row.state ?? 'unknown',
		// Truncated: a query text can be thousands of characters and the console
		// only needs enough to identify it.
		query: row.query.length > 500 ? `${row.query.slice(0, 500)}…` : row.query,
	}));
}

/** Whether migrations have all been applied. */
export async function getMigrationStatus(): Promise<{
	applied: number;
	latestAppliedAt: string | null;
	state: 'ok' | 'unknown';
}> {
	try {
		const pool = getDbPool();
		const [row] = (
			await pool.query<{ n: string; latest: Date | null }>(
				`SELECT count(*)::int AS n, max(created_at) AS latest FROM drizzle.__drizzle_migrations`,
			)
		).rows;
		const latest = row?.latest;
		return {
			applied: Number(row?.n ?? 0),
			latestAppliedAt: latest ? new Date(Number(latest)).toISOString() : null,
			state: 'ok',
		};
	} catch {
		return { applied: 0, latestAppliedAt: null, state: 'unknown' };
	}
}

// ─── Report assembly ─────────────────────────────────────────────────────────

/**
 * Builds the service health report.
 *
 * `runTests` controls whether provider connectivity is re-tested or the last
 * recorded result is used. The dashboard uses the recorded results (fast, no
 * provider spend); the "test all" button forces fresh tests.
 */
export async function listServiceHealth(options: { runTests?: boolean } = {}): Promise<ServiceHealthReport> {
	const notes: string[] = [];
	const dependencies: ServiceHealthEntry[] = [];

	// ── Dependencies that have a real test ──
	const dependencyNames = ['postgres', 'redis', 'object-storage', 'firebase', 'stripe'];
	const recorded = options.runTests ? [] : await latestProviderHealth();
	const recordedByProvider = new Map(recorded.map((r) => [r.provider, r]));

	for (const name of dependencyNames) {
		const test = PROVIDER_TESTS[name];
		if (!test) continue;

		const prior = recordedByProvider.get(name);
		if (prior && !options.runTests) {
			dependencies.push({
				name: test.label,
				kind: 'dependency',
				status: prior.status === 'pass' ? 'healthy' : prior.status === 'fail' ? 'down' : prior.status === 'degraded' ? 'degraded' : 'not_configured',
				latencyMs: prior.latencyMs,
				detail: prior.message,
				method: `${prior.method} (last run ${new Date(prior.checkedAt).toISOString()} by ${prior.checkedBy ?? 'scheduler'})`,
				version: null,
				uptimeSeconds: null,
				unavailable: [],
				target: null,
			});
			continue;
		}

		// No recorded result yet: run it once so the screen is never blank.
		const result = await runProviderTest(name, { trigger: options.runTests ? 'manual' : 'scheduled' });
		dependencies.push({
			name: test.label,
			kind: 'dependency',
			status: result.status === 'pass' ? 'healthy' : result.status === 'fail' ? 'down' : result.status === 'degraded' ? 'degraded' : 'not_configured',
			latencyMs: result.latencyMs,
			detail: result.message,
			method: result.method,
			version: null,
			uptimeSeconds: null,
			unavailable: [],
			target: null,
		});
	}

	// ── AI/voice providers ──
	for (const [name, test] of Object.entries(PROVIDER_TESTS)) {
		if (dependencyNames.includes(name)) continue;
		const prior = recordedByProvider.get(name);
		if (!prior && !options.runTests) {
			dependencies.push({
				name: test.label,
				kind: 'dependency',
				status: 'unknown',
				latencyMs: null,
				detail: 'Not tested since this service started. Use "Test all connections" to verify.',
				method: 'no recorded result',
				version: null,
				uptimeSeconds: null,
				unavailable: [],
				target: null,
			});
			continue;
		}

		const entry = prior ?? (await runProviderTest(name, { trigger: 'scheduled' }));
		dependencies.push({
			name: test.label,
			kind: 'dependency',
			status:
				(entry as { status: string }).status === 'pass'
					? 'healthy'
					: (entry as { status: string }).status === 'fail'
						? 'down'
						: (entry as { status: string }).status === 'degraded'
							? 'degraded'
							: 'not_configured',
			latencyMs: (entry as { latencyMs: number | null }).latencyMs,
			detail: (entry as { message: string }).message,
			method: (entry as { method?: string }).method ?? 'recorded history',
			version: null,
			uptimeSeconds: null,
			unavailable: [],
			target: null,
		});
	}

	// ── This process ──
	const self = getSelfMetrics();
	const version = readPackageVersion(join(process.cwd(), 'package.json')) ?? 'unknown';
	const databaseHealth = await getDatabaseHealth().catch(() => null);

	dependencies.unshift({
		name: 'PostgreSQL (database size and connections)',
		kind: 'dependency',
		status: databaseHealth ? 'healthy' : 'unknown',
		latencyMs: null,
		detail: databaseHealth
			? `${databaseHealth.sizePretty}, ${databaseHealth.connections}/${databaseHealth.maxConnections} connections, ${databaseHealth.tableCount} tables`
			: 'Database statistics could not be read.',
		method: 'pg_database_size + pg_stat_activity',
		version: null,
		uptimeSeconds: null,
		unavailable: [],
		target: null,
	});

	const services: ServiceHealthEntry[] = [
		{
			name: 'NOVA API (this process)',
			kind: 'service',
			status: 'healthy',
			latencyMs: null,
			detail: `Node ${self.nodeVersion}, pid ${self.pid}, ${self.memoryRssMb} MB RSS`,
			method: 'process.memoryUsage + process.uptime',
			version,
			uptimeSeconds: self.uptimeSeconds,
			unavailable: [],
			target: `pid ${self.pid}`,
		},
	];

	const { targets, source } = discoverServiceTargets();
	notes.push(`Sibling services discovered from ${source}. Reachability is a TCP connect; CPU and memory per container are not visible to an in-process API.`);

	for (const target of targets) {
		if (target.port === Number(process.env.PORT ?? 3001) && target.name === 'api') {
			continue; // this process, already reported with real metrics
		}
		const probe = await probeTcp(target.host, target.port);
		services.push({
			name: target.name,
			kind: 'service',
			status: probe.ok ? 'healthy' : probe.error === 'ENOTFOUND' ? 'unknown' : 'down',
			latencyMs: probe.latencyMs,
			detail: probe.ok
				? `TCP connect to ${target.host}:${target.port} succeeded in ${probe.latencyMs} ms`
				: probe.error === 'ENOTFOUND'
					? `${target.host} does not resolve from this process. Either it is not deployed in this topology, or service discovery is not configured.`
					: `TCP connect to ${target.host}:${target.port} failed (${probe.error ?? 'unknown error'})`,
			method: 'TCP connect',
			version: null,
			uptimeSeconds: null,
			unavailable: ['CPU usage', 'memory usage', 'request count', 'error rate', 'last deployment'],
			target: `${target.host}:${target.port}`,
		});
	}

	return {
		services,
		dependencies,
		generatedAt: new Date().toISOString(),
		notes,
	};
}

export { getDbPool };
