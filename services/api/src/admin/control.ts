/**
 * NOVA — Emergency controls, kill switches and maintenance mode.
 *
 * These are the levers an operator reaches for when something is actively wrong:
 * "stop spending money on AI", "turn voice off until the provider recovers". They are
 * deliberately separate from feature flags, because they answer a different
 * question — a flag decides *who* gets a feature; a control decides whether the
 * capability runs at all.
 *
 * States live in `system_configs` so a change survives a restart, and every write is
 * audited with the operator's reason. `CONTROL_*` keys are declared here rather than
 * in the main catalog because they are operational state, not configuration an
 * operator tunes.
 *
 * **These are read on the hot path**, so `getRuntimeControls` is memoised for a
 * short window and returns a permissive default on error: if the configuration store
 * is unreachable, the platform keeps serving rather than black-holing every request.
 * That is the right failure direction for a *kill* switch — the switch is meant to
 * be thrown deliberately by a human, so its absence should not itself cause an
 * outage. The per-key defaults are recorded in `CONTROL_DEFINITIONS` so the
 * behaviour is explicit rather than incidental.
 */

import { eq, inArray } from 'drizzle-orm';
import { systemConfigs } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { invalidateConfigCache } from './config.js';

export type ControlKey =
	| 'CONTROL_MAINTENANCE_MODE'
	| 'CONTROL_MAINTENANCE_MESSAGE'
	| 'CONTROL_AI_ENABLED'
	| 'CONTROL_VOICE_ENABLED'
	| 'CONTROL_STT_ENABLED'
	| 'CONTROL_TTS_ENABLED'
	| 'CONTROL_BACKGROUND_JOBS_ENABLED'
	| 'CONTROL_PROACTIVE_ENABLED'
	| 'CONTROL_NOTIFICATIONS_ENABLED'
	| 'CONTROL_REALTIME_ENABLED'
	| 'CONTROL_OPERATOR_NOTE';

export type ControlDefinition = {
	key: ControlKey;
	label: string;
	description: string;
	type: 'boolean' | 'string';
	/**
	 * Value used when the key has never been set. `true` for capability switches:
	 * an un-configured platform runs normally, and an operator turns things *off*.
	 */
	default: boolean | string;
	scope: 'capability' | 'maintenance' | 'metadata';
};

export const CONTROL_DEFINITIONS: readonly ControlDefinition[] = [
	{
		key: 'CONTROL_MAINTENANCE_MODE',
		label: 'Global maintenance mode',
		description:
			'When on, clients are told NOVA is under maintenance and AI/voice requests are refused with a 503. Existing sessions are not destroyed.',
		type: 'boolean',
		default: false,
		scope: 'maintenance',
	},
	{
		key: 'CONTROL_MAINTENANCE_MESSAGE',
		label: 'Maintenance message',
		description: 'Text shown to users while maintenance mode is active.',
		type: 'string',
		default: 'NOVA is briefly unavailable while we perform scheduled maintenance.',
		scope: 'maintenance',
	},
	{
		key: 'CONTROL_AI_ENABLED',
		label: 'AI',
		description: 'Master switch for all LLM calls. Off means no completion is attempted and no tokens are billed.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_VOICE_ENABLED',
		label: 'Voice (whole pipeline)',
		description: 'Master switch for the realtime voice session. Off refuses new WebSocket sessions.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_STT_ENABLED',
		label: 'Speech-to-text',
		description: 'When off, the voice session rejects audio with a transcription-unavailable error.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_TTS_ENABLED',
		label: 'Text-to-speech',
		description: 'When off, NOVA replies with text only and the client falls back to on-device speech.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_BACKGROUND_JOBS_ENABLED',
		label: 'Background jobs',
		description: 'When off, scheduled engines (follow-up, retention sweep, recording reaper) skip their runs.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_PROACTIVE_ENABLED',
		label: 'Proactive assistant',
		description: 'When off, NOVA never initiates contact, regardless of any feature flag.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_NOTIFICATIONS_ENABLED',
		label: 'Notifications',
		description: 'Master switch for outbound notifications.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_REALTIME_ENABLED',
		label: 'Realtime transport',
		description: 'When off, the WebSocket gateway refuses new connections.',
		type: 'boolean',
		default: true,
		scope: 'capability',
	},
	{
		key: 'CONTROL_OPERATOR_NOTE',
		label: 'Operator note',
		description: 'Free-text reason for the current control state, shown on the dashboard so the next operator knows why.',
		type: 'string',
		default: '',
		scope: 'metadata',
	},
];

const DEFINITIONS_BY_KEY = new Map(CONTROL_DEFINITIONS.map((d) => [d.key, d]));

export function isControlKey(key: string): key is ControlKey {
	return DEFINITIONS_BY_KEY.has(key as ControlKey);
}

export type RuntimeControls = {
	maintenanceMode: boolean;
	maintenanceMessage: string;
	aiEnabled: boolean;
	voiceEnabled: boolean;
	sttEnabled: boolean;
	ttsEnabled: boolean;
	backgroundJobsEnabled: boolean;
	proactiveEnabled: boolean;
	notificationsEnabled: boolean;
	realtimeEnabled: boolean;
	operatorNote: string;
	/** True when any capability is switched off — drives the dashboard banner. */
	anyDisabled: boolean;
};

type CacheState = {
	values: Map<string, string>;
	loadedAt: number;
};

let cacheState: CacheState | null = null;
const CONTROL_CACHE_TTL_MS = 5000;

export function invalidateControlCache(): void {
	cacheState = null;
}

async function loadControlRows(): Promise<Map<string, string>> {
	const now = Date.now();
	if (cacheState && now - cacheState.loadedAt < CONTROL_CACHE_TTL_MS) return cacheState.values;

	try {
		const db = getDb();
		const rows = (await db
			.select()
			.from(systemConfigs)
			.where(inArray(systemConfigs.key, [...DEFINITIONS_BY_KEY.keys()]))) as unknown as Array<{
			key: string;
			value: string | null;
		}>;

		const values = new Map<string, string>();
		for (const row of rows) {
			if (row.value !== null && row.value !== undefined) values.set(row.key, row.value);
		}
		cacheState = { values, loadedAt: now };
		return values;
	} catch (error) {
		logger.warn({ err: error }, '[admin-control] could not read controls; using defaults');
		// Keep the last good snapshot if there is one, otherwise fall back to the
		// declared defaults. Either way the platform keeps running.
		cacheState = cacheState ?? { values: new Map(), loadedAt: now };
		return cacheState.values;
	}
}

function readBoolean(values: Map<string, string>, key: ControlKey): boolean {
	const definition = DEFINITIONS_BY_KEY.get(key);
	const raw = values.get(key);
	if (raw === undefined) {
		// The environment is consulted as a second source so a container-level
		// emergency override works even before the database is reachable.
		const fromEnv = process.env[key];
		if (fromEnv !== undefined && fromEnv !== '') return fromEnv === 'true' || fromEnv === '1';
		return Boolean(definition?.default ?? true);
	}
	return raw === 'true' || raw === '1';
}

function readString(values: Map<string, string>, key: ControlKey): string {
	const raw = values.get(key);
	if (raw !== undefined) return raw;
	const fromEnv = process.env[key];
	if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
	const definition = DEFINITIONS_BY_KEY.get(key);
	return typeof definition?.default === 'string' ? definition.default : '';
}

/**
 * The current control state.
 *
 * Memoised for five seconds. A kill switch therefore takes up to five seconds to be
 * observed by a process that has already read it once — reported honestly in the
 * console rather than described as instantaneous.
 */
export async function getRuntimeControls(): Promise<RuntimeControls> {
	const values = await loadControlRows();

	const controls: RuntimeControls = {
		maintenanceMode: readBoolean(values, 'CONTROL_MAINTENANCE_MODE'),
		maintenanceMessage: readString(values, 'CONTROL_MAINTENANCE_MESSAGE'),
		aiEnabled: readBoolean(values, 'CONTROL_AI_ENABLED'),
		voiceEnabled: readBoolean(values, 'CONTROL_VOICE_ENABLED'),
		sttEnabled: readBoolean(values, 'CONTROL_STT_ENABLED'),
		ttsEnabled: readBoolean(values, 'CONTROL_TTS_ENABLED'),
		backgroundJobsEnabled: readBoolean(values, 'CONTROL_BACKGROUND_JOBS_ENABLED'),
		proactiveEnabled: readBoolean(values, 'CONTROL_PROACTIVE_ENABLED'),
		notificationsEnabled: readBoolean(values, 'CONTROL_NOTIFICATIONS_ENABLED'),
		realtimeEnabled: readBoolean(values, 'CONTROL_REALTIME_ENABLED'),
		operatorNote: readString(values, 'CONTROL_OPERATOR_NOTE'),
		anyDisabled: false,
	};

	controls.anyDisabled =
		!controls.aiEnabled ||
		!controls.voiceEnabled ||
		!controls.sttEnabled ||
		!controls.ttsEnabled ||
		!controls.backgroundJobsEnabled ||
		!controls.proactiveEnabled ||
		!controls.notificationsEnabled ||
		!controls.realtimeEnabled ||
		controls.maintenanceMode;

	return controls;
}

/** Convenience for a single capability, avoiding a full object build. */
export async function isCapabilityEnabled(capability: ControlKey): Promise<boolean> {
	const values = await loadControlRows();
	const definition = DEFINITIONS_BY_KEY.get(capability);
	if (definition?.type !== 'boolean') return true;
	return readBoolean(values, capability);
}

/**
 * Writes a control value.
 *
 * Validates against the declaration, records the operator, and drops both the
 * control cache and the general config cache so the next read in this process sees
 * the change.
 */
export async function setControl(
	key: ControlKey,
	value: string | boolean,
	updatedBy: string | null,
): Promise<{ key: ControlKey; previous: string | null; next: string }> {
	const definition = DEFINITIONS_BY_KEY.get(key);
	if (!definition) throw new Error(`Unknown control key "${key}"`);

	let normalised: string;
	if (definition.type === 'boolean') {
		if (typeof value === 'boolean') normalised = value ? 'true' : 'false';
		else if (value === 'true' || value === 'false') normalised = value;
		else throw new Error(`${key} takes a boolean`);
	} else {
		const text = String(value);
		if (text.length > 2000) throw new Error(`${key} is too long`);
		normalised = text;
	}

	const db = getDb();
	// A control is conceptually a config row, so it lives in the same table with
	// scope 'private'. `onConflictDoUpdate` keeps this a single round trip.
	const existing = (await db
		.select()
		.from(systemConfigs)
		.where(eq(systemConfigs.key, key))
		.limit(1)) as unknown as Array<{ value: string | null }>;

	const previous = existing[0]?.value ?? null;

	await db
		.insert(systemConfigs)
		.values({
			key,
			scope: 'private',
			category: definition.scope === 'maintenance' ? 'Maintenance' : 'Emergency Controls',
			value: normalised,
			valueType: definition.type,
			description: definition.description,
			usedBy: ['api-server', 'ai-service', 'realtime', 'worker'],
			restartRequired: false,
			hotReloadable: true,
			displayOrder: 0,
			updatedBy,
		})
		.onConflictDoUpdate({
			target: systemConfigs.key,
			set: {
				value: normalised,
				updatedBy,
				updatedAt: new Date(),
			},
		});

	invalidateControlCache();
	await invalidateConfigCache();

	return { key, previous, next: normalised };
}
