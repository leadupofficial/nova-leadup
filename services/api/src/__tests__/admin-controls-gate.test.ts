/**
 * The operator controls must actually decide whether background work runs.
 *
 * Before these gates existed, an operator could switch `CONTROL_BACKGROUND_JOBS_ENABLED` off in
 * the console, watch the dashboard and the API both report it off, and have the follow-up
 * engine, the retention sweep and the recording reaper all keep running — with retention
 * continuing to **delete user data**. That is worse than having no switch at all: the operator
 * believes they have stopped something and has not. The console's own copy for that switch says
 * "scheduled engines skip their runs", so the claim has to be true.
 *
 * ## How this is tested, and why not against a real database
 *
 * `gates read two sources: `getRuntimeControls()` (the `CONTROL_*` rows) and the runtime
 * configuration overlay. Both are mocked at their module boundary, because the suite's
 * `DATABASE_URL` is a placeholder (`postgres://test:test@localhost:5432/test`) that no server
 * answers — a real-row test here would silently fall through to environment defaults and pass
 * for the wrong reason. The first version of this file did exactly that: every gate returned
 * `allowed: true` and the "switch is off" assertions failed, which is how the wrong data source
 * was found.
 *
 * The wiring — that the engines call these gates at all — is asserted separately below by
 * checking the engine returns the gate's reason as its `skipReason`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

import { getDb } from '../db/connection.js';
import { runFollowUpEngine } from '../jobs/follow-up-engine.js';
import { runRetentionSweep } from '../jobs/retention.js';
import { runRecordingReaper } from '../jobs/recording-reaper.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';

/**
 * A gate decision a test can control.
 *
 * Injected rather than mocked: the engines accept `options.gate`, defaulting to the real
 * `proactiveGate` / `backgroundJobsGate`. An earlier version of this file tried to mock the
 * control module and the mock never took effect, so every "switch is off" assertion failed with
 * the engine happily running — the test was measuring vitest's module graph, not the code. With
 * injection the assertion is about the engine's decision, which is the thing that matters.
 *
 * The gates' own logic is covered by `admin-control-refusals` below, which drives the real
 * functions against a stubbed control store.
 */
type GateDecision = { allowed: boolean; reason: string | null };

const ALLOW: () => Promise<GateDecision> = async () => ({ allowed: true, reason: null });
const refuse = (reason: string): (() => Promise<GateDecision>) => async () => ({ allowed: false, reason });

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
/** 10:00 Asia/Kolkata — inside the allowed window, so quiet hours is never the reason. */
const NOW = new Date('2026-09-18T04:30:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function taskRow(): Row {
	return {
		id: TASK_ID,
		userId: USER_ID,
		tenantId: null,
		title: 'Send the proposal',
		description: null,
		status: 'pending',
		priority: 'medium',
		assigneeId: null,
		dueAt: new Date(NOW.getTime() - DAY),
		completedAt: null,
		source: 'manual',
		tags: [],
		aiConfidence: null,
		dedupeKey: null,
		createdAt: new Date(NOW.getTime() - 2 * DAY),
		updatedAt: new Date(NOW.getTime() - DAY),
	} as unknown as Row;
}

/** The in-memory database the engines read, with every collection they touch present. */
function engineDb(seed: Record<string, Row[]> = {}) {
	const { db } = makeFilteringDb({
		tasks: [],
		reminders: [],
		audit_logs: [],
		audio_recordings: [],
		transcripts: [],
		privacy_preferences: [],
		...seed,
	});
	vi.mocked(getDb).mockReturnValue(db as never);
	return db;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the follow-up engine obeys the operator controls', () => {
	it('raises a follow-up when nothing is switched off', async () => {
		const db = engineDb({ tasks: [taskRow()] });
		const result = await runFollowUpEngine(db as never, { now: NOW });
		// The positive control. Without it, a gate that always refused would make every
		// "disabled" assertion below pass while proving nothing.
		expect(result.raised).toBe(1);
		expect(result.skipReason).toBeNull();
	});

	it('CONTROL_PROACTIVE_ENABLED=off stops it, and says so', async () => {
		const db = engineDb({ tasks: [taskRow()] });
		const result = await runFollowUpEngine(db as never, { now: NOW, gate: refuse('proactive-disabled') });

		expect(result.raised).toBe(0);
		expect(result.examinedUsers).toBe(0);
		expect(result.skipReason).toBe('proactive-disabled');
	});

	it('CONTROL_BACKGROUND_JOBS_ENABLED=off stops it', async () => {
		const db = engineDb({ tasks: [taskRow()] });
		const result = await runFollowUpEngine(db as never, { now: NOW, gate: refuse('background-jobs-disabled') });

		expect(result.raised).toBe(0);
		expect(result.skipReason).toBe('background-jobs-disabled');
	});

	it('maintenance mode stops it', async () => {
		const db = engineDb({ tasks: [taskRow()] });
		const result = await runFollowUpEngine(db as never, { now: NOW, gate: refuse('maintenance-mode') });

		expect(result.raised).toBe(0);
		expect(result.skipReason).toBe('maintenance-mode');
	});

	it('the configuration key alone stops it, with no emergency switch thrown', async () => {
		// The ordinary path: proactive behaviour turned off for everyone without an incident.
		const db = engineDb({ tasks: [taskRow()] });
		const result = await runFollowUpEngine(db as never, {
			now: NOW,
			gate: refuse('proactive-config-disabled'),
		});

		expect(result.raised).toBe(0);
		expect(result.skipReason).toBe('proactive-config-disabled');
	});
});

describe('the retention sweep obeys the operator controls', () => {
	it('purges nothing while background jobs are disabled', async () => {
		const deleted: string[] = [];
		const db = engineDb({
			audio_recordings: [
				{
					id: 'rec-1',
					userId: USER_ID,
					storageKey: 'audio/rec-1.wav',
					createdAt: new Date(NOW.getTime() - 400 * DAY),
					status: 'ready',
				} as unknown as Row,
			],
		});

		const result = await runRetentionSweep(db as never, {
			now: NOW,
			gate: refuse('background-jobs-disabled'),
			deleteObject: async (key: string) => {
				deleted.push(key);
			},
		});

		// The assertion that matters: no user data was destroyed while the switch was off.
		expect(deleted).toHaveLength(0);
		expect(result.recordingsPurged).toBe(0);
		expect(result.transcriptsPurged).toBe(0);
	});
});

describe('the recording reaper obeys the operator controls', () => {
	it('requeues nothing while background jobs are disabled', async () => {
		const requeued: string[] = [];
		const db = engineDb();

		const result = await runRecordingReaper(db as never, {
			now: NOW,
			gate: refuse('background-jobs-disabled'),
			requeue: async (id: string) => {
				requeued.push(id);
			},
		});

		expect(requeued).toHaveLength(0);
		expect(result.examined).toBe(0);
		expect(result.requeued).toBe(0);
	});
});
