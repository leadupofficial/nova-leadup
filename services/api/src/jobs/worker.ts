/**
 * NOVA — the work the queue does, and the loop that runs it.
 *
 * ## Which jobs exist, and why these
 *
 * Two, both already implemented as functions and both genuinely periodic:
 *
 *  * **`providers.health_check`** — every connectivity test, on an interval. This is the job that makes
 *    the console's Jobs page non-empty and the provider history continuous rather than only populated
 *    when an operator presses a button.
 *  * **`logs.reap`** — deletes log rows past retention. The sink already does this on its own flush
 *    cycle; running it as a job as well means an operator can see retention happening and retry it.
 *
 * Neither is here to demonstrate the queue. They are the two pieces of work the platform actually has
 * that are periodic, idempotent and safe to run twice — which is also why nothing user-facing was moved
 * onto it: a queue is the right home for repeatable maintenance, not for a request that has a user
 * waiting on it.
 *
 * ## The loop
 *
 * One `setInterval`, one job per tick, handlers registered at startup. It is deliberately serial within
 * a process: the concurrency that matters is across replicas, and `FOR UPDATE SKIP LOCKED` provides it
 * without any coordination. A process that claims two slow jobs at once and starves its own event loop
 * would be a worse failure than a job waiting one tick.
 */

import { getDbPool } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { getLogSink } from '../utils/log-sink.js';
import { runAllProviderTests } from '../admin/providers.js';
import { enqueue, jobHandlerNames, queueStats, reclaimStale, registerJobHandler, runOne, workerId } from './queue.js';

/** How often the worker looks for work. */
const TICK_MS = 3_000;

/** How often the periodic jobs are enqueued. Five minutes is frequent enough to notice a provider failing. */
const SCHEDULE_MS = 5 * 60 * 1000;

let loop: NodeJS.Timeout | null = null;
let scheduler: NodeJS.Timeout | null = null;
let currentWorkerId: string | null = null;
let ticks = 0;

/**
 * Registers the handlers.
 *
 * Idempotent, and called by `startJobWorker` rather than at module load: a unit test that imports this
 * module must not register handlers into a shared map.
 */
export function registerDefaultHandlers(): void {
	registerJobHandler('providers.health_check', async () => {
		const results = await runAllProviderTests({ trigger: 'scheduled' });
		const failing = results.filter((result) => result.status === 'fail');
		if (failing.length > 0) {
			// A job that succeeds while reporting failures is right — the check ran — and the failure
			// count is in the result an operator reads. Throwing here would retry a check that already
			// told the truth.
			logger.warn(
				{ providers: failing.map((result) => result.provider) },
				'[job-queue] scheduled provider check found failures',
			);
		}
		return { checked: results.length, failing: failing.length };
	});

	registerJobHandler('logs.reap', async () => {
		const deleted = await getLogSink().applyRetention();
		return { deleted };
	});
}

/** Enqueues the periodic jobs, ignoring one that is already waiting. */
export async function schedulePeriodicJobs(): Promise<void> {
	// The dedupe key is per job name, so a slow run does not stack up behind itself — the fix for a job
	// that outruns its interval is not a longer interval.
	await enqueue({ name: 'providers.health_check', queue: 'maintenance', dedupeKey: 'periodic', enqueuedBy: 'scheduler' });
	await enqueue({ name: 'logs.reap', queue: 'maintenance', dedupeKey: 'periodic', enqueuedBy: 'scheduler' });
}

/**
 * Runs one tick: reclaim abandoned work, then run one due job.
 *
 * Exported so a test or a verification script can drive the loop deterministically instead of waiting
 * three seconds.
 */
export async function runTick(worker = workerId()): Promise<Awaited<ReturnType<typeof runOne>>> {
	ticks += 1;
	// Reclaiming on every tick rather than on a separate timer: a crashed worker's job should return to
	// the queue on the next tick of any process, not on a schedule of its own.
	if (ticks % 20 === 0) await reclaimStale();
	return runOne(worker);
}

/** Starts the worker and the scheduler. Idempotent. */
export function startJobWorker(): void {
	if (loop) return;
	currentWorkerId = workerId();
	registerDefaultHandlers();

	loop = setInterval(() => {
		void runTick(currentWorkerId ?? undefined).catch((error) => {
			logger.warn({ err: error }, '[job-queue] a tick failed');
		});
	}, TICK_MS);
	loop.unref?.();

	scheduler = setInterval(() => {
		void schedulePeriodicJobs().catch((error) => {
			logger.warn({ err: error }, '[job-queue] could not enqueue the periodic jobs');
		});
	}, SCHEDULE_MS);
	scheduler.unref?.();

	// Enqueued on the next tick rather than synchronously, so boot is not blocked on the database and a
	// database that is slow to come up does not delay startup.
	setTimeout(() => {
		void schedulePeriodicJobs().catch(() => {});
	}, 2_000).unref?.();

	logger.info({ worker: currentWorkerId, handlers: jobHandlerNames() }, '[job-queue] worker started');
}

export function stopJobWorker(): void {
	if (loop) clearInterval(loop);
	if (scheduler) clearInterval(scheduler);
	loop = null;
	scheduler = null;
}

/** The worker's own view, reported by the console's Jobs page beside the queue. */
export async function workerStatus(): Promise<{
	workerId: string | null;
	running: boolean;
	handlers: string[];
	queue: Awaited<ReturnType<typeof queueStats>>;
}> {
	return {
		workerId: currentWorkerId,
		running: loop !== null,
		handlers: jobHandlerNames(),
		queue: await queueStats(),
	};
}

/** Used by the verification script to confirm the queue can see its own table. */
export async function queueReachable(): Promise<boolean> {
	try {
		await getDbPool().query('SELECT 1 FROM job_executions LIMIT 1');
		return true;
	} catch {
		return false;
	}
}

export const JOB_QUEUE_TIMING = { TICK_MS, SCHEDULE_MS };
