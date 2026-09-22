/**
 * NOVA — a job queue on the database that already existed.
 *
 * ## The problem this solves
 *
 * The console's Jobs page read `job_executions`, which nothing wrote, and its retry action answered
 * `501 RETRY_NOT_SUPPORTED`: *"there is no queue to re-enqueue into."* That was honest, and it left an
 * operator with an empty table and a button that did nothing — the one place in the control center
 * where a control had no effect.
 *
 * The table was already shaped like a queue — `job_name`, `queue_name`, `worker_id`, `status`,
 * `attempt`, `max_attempts`, `payload`, `result`, `error_message`, `duration_ms`, `started_at`,
 * `finished_at` — so this adds the two columns a queue needs (`run_at` for backoff and scheduling,
 * `enqueued_by` for attribution) and puts a claim loop behind it. A second table would have meant two
 * job concepts and a join between them.
 *
 * ## Claiming, and why `SKIP LOCKED`
 *
 * Workers claim with a single statement:
 *
 * ```sql
 * UPDATE job_executions SET status = 'running', ...
 * WHERE id = (SELECT id FROM job_executions
 *             WHERE status = 'queued' AND run_at <= now()
 *             ORDER BY run_at ASC
 *             FOR UPDATE SKIP LOCKED LIMIT 1)
 * RETURNING *
 * ```
 *
 * `SKIP LOCKED` is what makes this safe with more than one worker: a row being claimed by another
 * worker is skipped rather than waited on, so two workers never run the same job and neither blocks.
 * This is the same mechanism Postgres-backed queues use, and it is why no broker is required.
 *
 * ## A worker that dies
 *
 * A crash mid-job leaves a row in `running` for ever. `reclaimStale()` returns any `running` row whose
 * `started_at` is older than the lease to `queued`, and the attempt count is **not** incremented — the
 * job did not fail, it was interrupted, and charging it an attempt would eventually dead-letter work
 * that was never actually completed. The lease is generous (5 minutes) because a slow job is not a dead
 * one, and `worker_id` records who held it so an operator can see the pattern.
 *
 * ## What is deliberately not here
 *
 * No priorities, no rate limiting, no cron expressions, and no cross-queue concurrency limits. Each is a
 * real feature and none is needed for the work this queue has: a handful of maintenance jobs. Adding
 * them now would be building against imagined load, and the shapes that matter — backoff, retry,
 * dead-letter, cancellation — are here.
 */

import { getDbPool } from '../db/connection.js';
import { logger } from '../utils/logger.js';

/** Statuses, matching the comment on the column. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter' | 'cancelled';

/** How long a claimed job may run before another worker may reclaim it. */
export const LEASE_MS = 5 * 60 * 1000;

/** Attempt backoff: 30s, 2m, 8m. Bounded, so a permanently broken job dead-letters quickly. */
export function backoffMs(attempt: number): number {
	return Math.min(30_000 * 4 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
}

export type JobRow = {
	id: string;
	job_name: string;
	queue_name: string | null;
	worker_id: string | null;
	status: JobStatus;
	user_id: string | null;
	related_type: string | null;
	related_id: string | null;
	attempt: number;
	max_attempts: number;
	payload: Record<string, unknown>;
	result: Record<string, unknown>;
	error_message: string | null;
	duration_ms: number | null;
	request_id: string | null;
	started_at: Date | null;
	finished_at: Date | null;
	run_at: Date;
	enqueued_by: string | null;
	created_at: Date;
};

export type JobHandler = (payload: Record<string, unknown>, context: { jobId: string; attempt: number }) => Promise<Record<string, unknown> | void>;

/**
 * The registry.
 *
 * A job with no handler is left `queued` rather than failed: a worker that has not been upgraded yet
 * should not burn another worker's job, and an operator can see it waiting. `runOne` reports the
 * distinction.
 */
const handlers = new Map<string, JobHandler>();

export function registerJobHandler(name: string, handler: JobHandler): void {
	handlers.set(name, handler);
}

export function jobHandlerNames(): string[] {
	return [...handlers.keys()];
}

export type EnqueueOptions = {
	name: string;
	payload?: Record<string, unknown>;
	queue?: string | null;
	runAt?: Date;
	maxAttempts?: number;
	userId?: string | null;
	relatedType?: string | null;
	relatedId?: string | null;
	requestId?: string | null;
	enqueuedBy?: string | null;
	/**
	 * De-duplication key.
	 *
	 * When set, a second enqueue with the same name and key while one is still `queued` or `running` is
	 * ignored. This is what makes a periodic check safe to schedule: without it, a slow run would stack
	 * up behind itself, and the fix for that is not a bigger interval but not enqueuing what is already
	 * waiting.
	 */
	dedupeKey?: string | null;
};

/** Adds a job. Returns the row, or `null` when the dedupe key showed one was already pending. */
export async function enqueue(options: EnqueueOptions): Promise<JobRow | null> {
	const pool = getDbPool();
	if (options.dedupeKey) {
		const existing = await pool.query<{ id: string }>(
			`SELECT id FROM job_executions
			 WHERE job_name = $1 AND status IN ('queued', 'running') AND payload->>'dedupeKey' = $2
			 LIMIT 1`,
			[options.name, options.dedupeKey],
		);
		if (existing.rows.length > 0) return null;
	}

	const { rows } = await pool.query<JobRow>(
		`INSERT INTO job_executions
		   (job_name, queue_name, status, payload, run_at, max_attempts, user_id, related_type,
		    related_id, request_id, enqueued_by)
		 VALUES ($1, $2, 'queued', $3::jsonb, COALESCE($4, now()), $5, $6, $7, $8, $9, $10)
		 RETURNING *`,
		[
			options.name,
			options.queue ?? 'default',
			JSON.stringify({ ...(options.payload ?? {}), ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}) }),
			options.runAt ?? null,
			options.maxAttempts ?? 3,
			options.userId ?? null,
			options.relatedType ?? null,
			options.relatedId ?? null,
			options.requestId ?? null,
			options.enqueuedBy ?? null,
		],
	);
	return rows[0] ?? null;
}

/**
 * Claims one job, or `null` when none is due.
 *
 * One statement, so two workers cannot both believe they claimed the same row. `worker_id` is required
 * because it is both the attribution and half of the lease.
 */
export async function claim(workerId: string): Promise<JobRow | null> {
	const { rows } = await getDbPool().query<JobRow>(
		`UPDATE job_executions
		 SET status = 'running', worker_id = $1, started_at = now(), finished_at = NULL
		 WHERE id = (
		   SELECT id FROM job_executions
		   WHERE status = 'queued' AND run_at <= now()
		   ORDER BY run_at ASC
		   FOR UPDATE SKIP LOCKED
		   LIMIT 1
		 )
		 RETURNING *`,
		[workerId],
	);
	return rows[0] ?? null;
}

/** Marks a job done. */
export async function complete(jobId: string, result: Record<string, unknown> = {}): Promise<void> {
	await getDbPool().query(
		`UPDATE job_executions
		 SET status = 'succeeded', finished_at = now(), result = $2::jsonb, error_message = NULL,
		     duration_ms = CASE WHEN started_at IS NULL THEN NULL
		                        ELSE (extract(epoch FROM (now() - started_at)) * 1000)::int END
		 WHERE id = $1`,
		[jobId, JSON.stringify(result)],
	);
}

/**
 * Records a failure, and either schedules a retry or dead-letters it.
 *
 * `attempt` is incremented here rather than at claim time, so the number an operator reads is the
 * number of attempts that actually **ran**. Counting a claim instead would show an attempt for work a
 * crashed worker never started.
 */
export async function fail(jobId: string, message: string): Promise<{ status: JobStatus; retryAt: Date | null }> {
	const { rows } = await getDbPool().query<{ attempt: number; max_attempts: number }>(
		`SELECT attempt, max_attempts FROM job_executions WHERE id = $1`,
		[jobId],
	);
	const row = rows[0];
	if (!row) return { status: 'failed', retryAt: null };

	const nextAttempt = row.attempt + 1;
	const durationSql = `duration_ms = CASE WHEN started_at IS NULL THEN NULL
	                        ELSE (extract(epoch FROM (now() - started_at)) * 1000)::int END,`;

	if (nextAttempt <= row.max_attempts) {
		const delay = backoffMs(row.attempt);
		const { rows: updated } = await getDbPool().query<{ run_at: Date }>(
			`UPDATE job_executions
			 SET status = 'queued', attempt = $2, finished_at = now(), error_message = $3,
			     run_at = now() + ($4 || ' milliseconds')::interval, worker_id = NULL,
			     ${durationSql}
			     started_at = NULL
			 WHERE id = $1
			 RETURNING run_at`,
			[jobId, nextAttempt, message, String(delay)],
		);
		return { status: 'queued', retryAt: updated[0]?.run_at ?? null };
	}

	await getDbPool().query(
		`UPDATE job_executions
		 SET status = 'dead_letter', attempt = $2, finished_at = now(), error_message = $3,
		     worker_id = NULL, ${durationSql} started_at = started_at
		 WHERE id = $1`,
		[jobId, nextAttempt, message],
	);
	return { status: 'dead_letter', retryAt: null };
}

/**
 * Re-runs a finished job — what the console's Retry button does.
 *
 * Resets the attempt count as well as the status: an operator retrying a dead-lettered job is starting
 * the work again, not adding a fourth attempt to a count that already exhausted its budget. Refuses a
 * job that is currently queued or running, because two copies of the same work is not a retry.
 */
export async function retryJob(jobId: string): Promise<{ ok: true; job: JobRow } | { ok: false; reason: 'not-found' | 'in-flight' }> {
	const pool = getDbPool();
	const { rows } = await pool.query<JobRow>(`SELECT * FROM job_executions WHERE id = $1`, [jobId]);
	const job = rows[0];
	if (!job) return { ok: false, reason: 'not-found' };
	if (job.status === 'queued' || job.status === 'running') return { ok: false, reason: 'in-flight' };

	const { rows: updated } = await pool.query<JobRow>(
		`UPDATE job_executions
		 SET status = 'queued', attempt = 1, run_at = now(), started_at = NULL, finished_at = NULL,
		     error_message = NULL, duration_ms = NULL, worker_id = NULL, result = '{}'::jsonb
		 WHERE id = $1
		 RETURNING *`,
		[jobId],
	);
	return { ok: true, job: updated[0] };
}

/** Cancels a job that has not finished. A running job is marked cancelled; the worker's result is ignored. */
export async function cancelJob(jobId: string): Promise<boolean> {
	const { rowCount } = await getDbPool().query(
		`UPDATE job_executions SET status = 'cancelled', finished_at = now(), worker_id = NULL
		 WHERE id = $1 AND status IN ('queued', 'running')`,
		[jobId],
	);
	return (rowCount ?? 0) > 0;
}

/**
 * Returns abandoned jobs to the queue.
 *
 * The attempt is **not** incremented: the job was interrupted, not failed, and charging it an attempt
 * would dead-letter work that never actually completed.
 */
export async function reclaimStale(leaseMs: number = LEASE_MS): Promise<string[]> {
	const { rows } = await getDbPool().query<{ id: string; job_name: string; worker_id: string | null }>(
		`UPDATE job_executions
		 SET status = 'queued', worker_id = NULL, started_at = NULL
		 WHERE status = 'running' AND started_at < now() - ($1 || ' milliseconds')::interval
		 RETURNING id, job_name, worker_id`,
		[String(leaseMs)],
	);
	if (rows.length > 0) {
		logger.warn(
			{ jobs: rows.map((row) => ({ id: row.id, name: row.job_name, worker: row.worker_id })) },
			'[job-queue] reclaimed jobs whose worker stopped reporting — they will run again',
		);
	}
	return rows.map((row) => row.id);
}

/**
 * Runs one due job, if a handler exists for it.
 *
 * Returns what happened so the worker loop and the tests can assert without inspecting the table. A job
 * with no registered handler is left alone and reported as `unhandled` — the alternative, failing it,
 * would let one replica running an older build dead-letter work the rest of the fleet can do.
 */
export async function runOne(
	workerId: string,
): Promise<{ outcome: 'idle' | 'ran' | 'failed' | 'unhandled'; job?: JobRow; error?: string }> {
	const job = await claim(workerId);
	if (!job) return { outcome: 'idle' };

	const handler = handlers.get(job.job_name);
	if (!handler) {
		// Hand it back untouched, with the attempt count as it was.
		await getDbPool().query(
			`UPDATE job_executions SET status = 'queued', worker_id = NULL, started_at = NULL
			 WHERE id = $1`,
			[job.id],
		);
		return { outcome: 'unhandled', job };
	}

	try {
		const result = await handler(job.payload ?? {}, { jobId: job.id, attempt: job.attempt });
		await complete(job.id, (result ?? {}) as Record<string, unknown>);
		return { outcome: 'ran', job };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await fail(job.id, message);
		return { outcome: 'failed', job, error: message };
	}
}

/** Counts by status, plus the age of the oldest queued job — the two things an operator looks at. */
export async function queueStats(): Promise<{
	byStatus: Record<string, number>;
	oldestQueuedSeconds: number | null;
	handlers: string[];
	reclaimable: number;
}> {
	const pool = getDbPool();
	const [byStatus, oldest, reclaimable] = await Promise.all([
		pool.query<{ status: string; count: string }>(`SELECT status, count(*)::int AS count FROM job_executions GROUP BY status`),
		pool.query<{ age: string | null }>(
			`SELECT extract(epoch FROM (now() - min(run_at)))::text AS age
			 FROM job_executions WHERE status = 'queued' AND run_at <= now()`,
		),
		pool.query<{ count: string }>(
			`SELECT count(*)::int AS count FROM job_executions
			 WHERE status = 'running' AND started_at < now() - ($1 || ' milliseconds')::interval`,
			[String(LEASE_MS)],
		),
	]);

	const statuses: Record<string, number> = {};
	for (const row of byStatus.rows) statuses[row.status] = Number(row.count);
	const age = oldest.rows[0]?.age;

	return {
		byStatus: statuses,
		oldestQueuedSeconds: age === null || age === undefined ? null : Math.max(0, Math.round(Number(age))),
		handlers: jobHandlerNames(),
		reclaimable: Number(reclaimable.rows[0]?.count ?? 0),
	};
}

/** A worker id that says which process and which boot. */
export function workerId(): string {
	return `${process.env.HOSTNAME ?? 'api'}-${process.pid}-${process.uptime().toFixed(0)}`;
}

/** Test seam: drop every registered handler. */
export const __testing = { resetHandlers: () => handlers.clear() };
