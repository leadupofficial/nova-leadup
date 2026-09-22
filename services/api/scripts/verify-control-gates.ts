/**
 * Live verification: do the operator controls actually refuse the background gates?
 *
 * Run against the real API process, using the real control store.
 *
 * The unit suite covers the *engine's* decision by injecting a gate, because this repository's
 * test `DATABASE_URL` is a placeholder no server answers. That leaves the gates' own logic — the
 * part that reads `system_configs` through the control cache and decides — covered only by
 * inspection. This script closes that: it writes real `CONTROL_*` rows, calls the real
 * `proactiveGate` / `backgroundJobsGate`, and asserts the reason each one returns.
 *
 * It restores every key it touched, including deleting a key that did not exist before.
 *
 * Usage: cd services/api && npx tsx scripts/verify-control-gates.ts
 */
import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { systemConfigs } from '@nova/database';
import { getDb } from '../src/db/connection.js';
import { invalidateControlCache } from '../src/admin/control.js';
// The same call the config routes make after a write. Using it here means the verifier exercises
// the production invalidation path rather than a hand-rolled approximation of it.
import { invalidateConfigCache } from '../src/admin/config.js';
import { backgroundJobsGate, proactiveGate } from '../src/admin/enforcement.js';

const KEYS = [
	'CONTROL_BACKGROUND_JOBS_ENABLED',
	'CONTROL_PROACTIVE_ENABLED',
	'CONTROL_MAINTENANCE_MODE',
	'PROACTIVE_ASSISTANT_ENABLED',
] as const;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
	if (ok) {
		console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
		passed += 1;
	} else {
		console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
		failed += 1;
	}
}

const db = getDb();

async function readKey(key: string): Promise<string | null> {
	const rows = (await db
		.select()
		.from(systemConfigs)
		.where(eq(systemConfigs.key, key))
		.limit(1)) as unknown as Array<{ value: string | null }>;
	return rows[0]?.value ?? null;
}

async function writeKey(key: string, value: string | null): Promise<void> {
	if (value === null) {
		await db.delete(systemConfigs).where(eq(systemConfigs.key, key));
	} else {
		await db
			.insert(systemConfigs)
			.values({
				key,
				scope: 'private',
				category: 'Emergency Controls',
				value,
				valueType: key === 'PROACTIVE_ASSISTANT_ENABLED' ? 'boolean' : 'boolean',
				usedBy: ['verification'],
			})
			.onConflictDoUpdate({ target: systemConfigs.key, set: { value, updatedAt: new Date() } });
	}
	invalidateControlCache();
	await invalidateConfigCache();
}

/** Sets several keys and drops the caches once, so the next gate read sees them all. */
async function setControls(values: Partial<Record<(typeof KEYS)[number], string | null>>): Promise<void> {
	for (const [key, value] of Object.entries(values)) {
		await writeKey(key, value ?? null);
	}
	invalidateControlCache();
	await invalidateConfigCache();
}

const original = new Map<string, string | null>();

async function main(): Promise<void> {
	const rows = (await db
		.select()
		.from(systemConfigs)
		.where(inArray(systemConfigs.key, [...KEYS]))) as unknown as Array<{
		key: string;
		value: string | null;
	}>;
	for (const key of KEYS) original.set(key, rows.find((row) => row.key === key)?.value ?? null);

	console.log('\n\x1b[1m1. Baseline — nothing switched off\x1b[0m');
	await setControls({
		CONTROL_BACKGROUND_JOBS_ENABLED: 'true',
		CONTROL_PROACTIVE_ENABLED: 'true',
		CONTROL_MAINTENANCE_MODE: 'false',
		PROACTIVE_ASSISTANT_ENABLED: 'true',
	});
	let gate = await backgroundJobsGate();
	console.log(`     backgroundJobsGate -> allowed=${gate.allowed} reason=${gate.reason}`);
	check('the background-jobs gate allows a run', gate.allowed);
	gate = await proactiveGate();
	console.log(`     proactiveGate -> allowed=${gate.allowed} reason=${gate.reason}`);
	check('the proactive gate allows a run', gate.allowed);

	console.log('\n\x1b[1m2. CONTROL_BACKGROUND_JOBS_ENABLED=off\x1b[0m');
	await setControls({ CONTROL_BACKGROUND_JOBS_ENABLED: 'false' });
	gate = await backgroundJobsGate();
	console.log(`     backgroundJobsGate -> allowed=${gate.allowed} reason=${gate.reason}`);
	check('the background-jobs gate refuses', !gate.allowed);
	check('with the switch’s own reason', gate.reason === 'background-jobs-disabled', `got ${gate.reason}`);
	gate = await proactiveGate();
	console.log(`     proactiveGate -> allowed=${gate.allowed} reason=${gate.reason}`);
	check('proactive work is refused too, because it is background work', gate.reason === 'background-jobs-disabled');

	console.log('\n\x1b[1m3. CONTROL_PROACTIVE_ENABLED=off (background jobs still on)\x1b[0m');
	await setControls({ CONTROL_BACKGROUND_JOBS_ENABLED: 'true', CONTROL_PROACTIVE_ENABLED: 'false' });
	gate = await proactiveGate();
	console.log(`     proactiveGate -> allowed=${gate.allowed} reason=${gate.reason}`);
	check('the proactive gate refuses on its own switch', gate.reason === 'proactive-disabled', `got ${gate.reason}`);
	gate = await backgroundJobsGate();
	check('the background-jobs gate is unaffected', gate.allowed);

	console.log('\n\x1b[1m4. PROACTIVE_ASSISTANT_ENABLED=false — configuration, no switch thrown\x1b[0m');
	await setControls({
		CONTROL_PROACTIVE_ENABLED: 'true',
		CONTROL_BACKGROUND_JOBS_ENABLED: 'true',
		PROACTIVE_ASSISTANT_ENABLED: 'false',
	});
	gate = await proactiveGate();
	console.log(`     proactiveGate -> allowed=${gate.allowed} reason=${gate.reason}`);
	check(
		'the configuration key alone stops proactive work',
		gate.reason === 'proactive-config-disabled',
		`got ${gate.reason}`,
	);

	console.log('\n\x1b[1m5. Maintenance mode outranks the other switches\x1b[0m');
	await setControls({
		CONTROL_MAINTENANCE_MODE: 'true',
		CONTROL_PROACTIVE_ENABLED: 'true',
		CONTROL_BACKGROUND_JOBS_ENABLED: 'true',
		PROACTIVE_ASSISTANT_ENABLED: 'true',
	});
	gate = await proactiveGate();
	console.log(`     proactiveGate -> allowed=${gate.allowed} reason=${gate.reason}`);
	check('maintenance mode refuses proactive work', gate.reason === 'maintenance-mode', `got ${gate.reason}`);
	gate = await backgroundJobsGate();
	check('maintenance mode refuses background jobs', gate.reason === 'maintenance-mode', `got ${gate.reason}`);

	console.log('\n\x1b[1m6. Restore every key exactly as it was\x1b[0m');
	for (const key of KEYS) await writeKey(key, original.get(key) ?? null);
	const restored = await Promise.all(KEYS.map((key) => readKey(key)));
	const expected = KEYS.map((key) => original.get(key) ?? null);
	console.log(`     restored: ${restored.map((value, index) => `${KEYS[index]}=${value}`).join(', ')}`);
	check('every touched key is back to its original value', restored.every((value, index) => value === expected[index]));
	gate = await backgroundJobsGate();
	check('and the gates allow runs again', gate.allowed);
}

try {
	await main();
} finally {
	// Restore even if an assertion threw, so a failure cannot leave the platform switched off.
	for (const key of KEYS) await writeKey(key, original.get(key) ?? null);
	console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
	process.exit(failed === 0 ? 0 : 1);
}
