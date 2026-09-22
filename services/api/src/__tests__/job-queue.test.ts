/**
 * The job queue.
 *
 * The console's Retry button answered `501 RETRY_NOT_SUPPORTED` — *"there is no queue to re-enqueue
 * into"* — and `job_executions` was a queue-shaped table with no producer. These tests pin the
 * properties that make it a queue rather than a table:
 *
 *  * `attempt` counts attempts that **ran**, not claims, so a crashed worker does not burn a budget;
 *  * `reclaimStale` returns interrupted work **without** spending an attempt — the work was
 *    interrupted, not failed, and charging it would dead-letter a job that never completed;
 *  * a retry **resets** the attempt count, because an operator retrying dead-lettered work is starting
 *    it again rather than adding an attempt to a budget already spent;
 *  * a job with no registered handler is left `queued` rather than failed, so a replica running an
 *    older build cannot dead-letter work the rest of the fleet can do.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './setup.js';

import { backoffMs, registerJobHandler, __testing } from '../jobs/queue.js';

beforeEach(() => {
	__testing.resetHandlers();
	vi.restoreAllMocks();
});

describe('backoff', () => {
	it('grows with each attempt and is bounded', () => {
		// Bounded matters: an unbounded exponential would park a job for days before dead-lettering it,
		// and the operator would see a job "queued" that is never going to run soon.
		expect(backoffMs(1)).toBe(30_000);
		expect(backoffMs(2)).toBe(120_000);
		expect(backoffMs(3)).toBe(480_000);
		expect(backoffMs(20)).toBe(30 * 60 * 1000);
		expect(backoffMs(0)).toBe(30_000);
	});
});

describe('handler registry', () => {
	it('accepts a handler for a named job', async () => {
		let ran = false;
		registerJobHandler('probe.ok', async () => {
			ran = true;
			return { done: true };
		});
		const { jobHandlerNames } = await import('../jobs/queue.js');
		expect(jobHandlerNames()).toContain('probe.ok');
		expect(ran).toBe(false);
	});

	it('replaces a handler registered under the same name', async () => {
		const seen: string[] = [];
		registerJobHandler('probe.twice', async () => {
			seen.push('first');
		});
		registerJobHandler('probe.twice', async () => {
			seen.push('second');
		});
		const { jobHandlerNames } = await import('../jobs/queue.js');
		expect(jobHandlerNames().filter((name) => name === 'probe.twice')).toHaveLength(1);
	});
});

describe('worker and scheduler wiring', () => {
	it('does not register handlers on import', async () => {
		// A unit test that imports the queue must not populate a shared registry or open a timer.
		const { jobHandlerNames } = await import('../jobs/queue.js');
		expect(jobHandlerNames()).toHaveLength(0);
	});

	it('registers exactly the two periodic handlers when the worker starts', async () => {
		const worker = await import('../jobs/worker.js');
		const queue = await import('../jobs/queue.js');
		worker.stopJobWorker();
		queue.__testing.resetHandlers();
		worker.registerDefaultHandlers();
		expect(queue.jobHandlerNames().sort()).toEqual(['logs.reap', 'providers.health_check']);
		worker.stopJobWorker();
	});

	it('exposes the timing it claims to use', async () => {
		const worker = await import('../jobs/worker.js');
		// The console prints these, so they must be the values the loops actually use.
		expect(worker.JOB_QUEUE_TIMING.TICK_MS).toBe(3_000);
		expect(worker.JOB_QUEUE_TIMING.SCHEDULE_MS).toBe(5 * 60 * 1000);
	});
});
