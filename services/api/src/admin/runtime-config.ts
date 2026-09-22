/**
 * NOVA — Runtime config accessors.
 *
 * ## The problem this solves
 *
 * The Admin Control Center advertised `AI_DEFAULT_MODEL`, `AI_MAX_TOKENS`,
 * `STT_PROVIDER` and friends, but a grep showed **nothing read them**
 * (`services/api/src/services/ai.ts:277` read `process.env.ANTHROPIC_MODEL`
 * directly, `ai.ts:458` read `env.LLM_MAX_OUTPUT_TOKENS`). Writing one of those rows
 * changed a row and nothing else. A configuration screen that implies control it does
 * not have is the most misleading thing this panel could ship.
 *
 * ## The mechanism
 *
 * Two accessors, one source of truth:
 *
 * - `resolveRuntimeConfig(key)` — **async**, authoritative. Reads the database (via
 *   the admin config layer), then the environment, then the catalog default.
 * - `runtimeConfigValue(key)` — **synchronous**, for hot paths that cannot await
 *   (`getAnthropicHttpConfig()` is called while building a request).
 *
 * The sync accessor reads an in-memory overlay. `refreshRuntimeOverlay()` fills that
 * overlay from the database and is called by the config cache loader, which already
 * runs at most once every 15 seconds. So the flow is:
 *
 *   admin writes a value → cache invalidated → next read republishes the overlay →
 *   sync call sites see the new value
 *
 * This is a bounded, explicit global, not a hidden one: only keys listed in
 * `RUNTIME_WIRED_KEYS` are published, the overlay holds no secrets, and the write is
 * audited by the route that performed it.
 *
 * ## What is *not* wired
 *
 * `RUNTIME_WIRED_KEYS` is deliberately short. Every other catalog key is reported by
 * the console as `readByRuntime: false` with the note explaining that a stored value
 * is inert until a call site reads it. Pretending otherwise is the failure mode this
 * module exists to prevent — and for a few keys (`CONTROL_*`, `MOBILE_*`) the value
 * *is* read, just through `control.ts` and the bootstrap endpoint rather than here.
 */

import { getRuntimeControls } from './control.js';
import { getConfigDefinition, resolveConfigMap } from './config.js';
import { logger } from '../utils/logger.js';

/**
 * Catalog keys whose value the running code actually reads.
 *
 * Keep this list honest. Adding a key here without a call site re-creates exactly the
 * problem described above; removing a key whose call site still exists silently
 * disables a configuration control.
 */
export const RUNTIME_WIRED_KEYS: readonly string[] = [
	'AI_DEFAULT_MODEL',
	'AI_MAX_TOKENS',
	'STT_LANGUAGE',
	'REMINDER_ENABLED',
	'PROACTIVE_ASSISTANT_ENABLED',
	'BACKGROUND_ASSISTANT_ENABLED',
	'MEMORY_ENABLED',
];

/**
 * Keys the gate logic reads through `runtimeConfigValue`.
 *
 * A subset of `RUNTIME_WIRED_KEYS` today, but declared separately because the overlay refresh
 * and the "is this wired?" report answer different questions. **This list is why the bug below
 * was found:** `PROACTIVE_ASSISTANT_ENABLED` was read by `proactiveGate` but was missing from
 * `RUNTIME_WIRED_KEYS`, so `refreshRuntimeOverlay` never published it — a stored value was
 * invisible and the gate fell through to the environment. The live gate verifier caught it by
 * writing the key and observing that the gate still allowed the run.
 */
export const GATE_CONFIG_KEYS: readonly string[] = [
	'PROACTIVE_ASSISTANT_ENABLED',
	'BACKGROUND_ASSISTANT_ENABLED',
	'REMINDER_ENABLED',
];

/** Keys read by a dedicated subsystem rather than through this overlay. */
export const SUBSYSTEM_READ_KEYS: readonly string[] = [
	// Read by admin/control.ts on every capability-gated request.
	'CONTROL_MAINTENANCE_MODE',
	'CONTROL_MAINTENANCE_MESSAGE',
	'CONTROL_AI_ENABLED',
	'CONTROL_VOICE_ENABLED',
	'CONTROL_STT_ENABLED',
	'CONTROL_TTS_ENABLED',
	'CONTROL_BACKGROUND_JOBS_ENABLED',
	'CONTROL_PROACTIVE_ENABLED',
	'CONTROL_NOTIFICATIONS_ENABLED',
	'CONTROL_REALTIME_ENABLED',
	// Read by routes/device-bootstrap.ts for the mobile client contract.
	'MOBILE_MIN_SUPPORTED_VERSION',
	'MOBILE_LATEST_VERSION',
	'MOBILE_FORCE_UPDATE',
	'MAINTENANCE_MODE',
	'MAINTENANCE_MESSAGE',
	'AVATAR_ENABLED',
	'OVERLAY_ENABLED',
];

/** True when a stored value for this key changes behaviour without a restart. */
export function isKeyReadByRuntime(key: string): boolean {
	return RUNTIME_WIRED_KEYS.includes(key) || SUBSYSTEM_READ_KEYS.includes(key) || key.startsWith('CONTROL_');
}

/** How the runtime consumes a key, for the configuration screen. */
export function runtimeWiringNote(key: string): string {
	if (RUNTIME_WIRED_KEYS.includes(key)) {
		return 'Read live by the service on each use (via the runtime overlay, refreshed with the config cache).';
	}
	if (key.startsWith('CONTROL_')) {
		return 'Read by the capability gate on every request in the affected subsystem.';
	}
	if (SUBSYSTEM_READ_KEYS.includes(key)) {
		return 'Read by a dedicated subsystem (mobile bootstrap or control gate), not by this service directly.';
	}
	return 'Not read by any running code yet. A stored value is inert: the call site still uses its own hardcoded or environment value.';
}

// ─── Synchronous overlay ─────────────────────────────────────────────────────

let overlay = new Map<string, string>();
let overlayLoadedAt = 0;
let overlayLoaded = false;

/**
 * Republish the overlay from the database.
 *
 * Called by the config cache loader. Never throws: a failure keeps the previous
 * overlay, so a database blip cannot blank a live setting.
 */
export async function refreshRuntimeOverlay(): Promise<void> {
	try {
		// The union, so a key read by a gate is always published even if it is not in the
		// main overlay list — the omission that made `PROACTIVE_ASSISTANT_ENABLED` inert.
		const values = await resolveConfigMap([...new Set([...RUNTIME_WIRED_KEYS, ...GATE_CONFIG_KEYS])]);
		const next = new Map<string, string>();
		for (const [key, value] of Object.entries(values)) {
			if (value !== null && value !== undefined && value !== '') next.set(key, value);
		}
		overlay = next;
		overlayLoadedAt = Date.now();
		overlayLoaded = true;
	} catch (error) {
		logger.warn({ err: error }, '[runtime-config] overlay refresh failed; keeping previous values');
	}
}

/** Force the next sync read to observe a just-written value. */
export function invalidateRuntimeOverlay(): void {
	overlayLoaded = false;
	overlayLoadedAt = 0;
	overlay = new Map();
}

/**
 * Synchronous read for hot paths.
 *
 * Order: overlay (database) → process environment → catalog default. The environment
 * sits in the middle deliberately: a deployment that sets `ANTHROPIC_MODEL` keeps
 * working exactly as before until an operator overrides it in the console.
 */
export function runtimeConfigValue(key: string): string | null {
	const fromOverlay = overlay.get(key);
	if (fromOverlay !== undefined) return fromOverlay;
	const fromEnv = process.env[key];
	if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
	return getConfigDefinition(key)?.defaultValue ?? null;
}

/**
 * Ensures the overlay has been populated at least once.
 *
 * Called by the server at boot so the very first request already sees database
 * overrides rather than waiting up to 15 seconds for the first cache load.
 */
export async function primeRuntimeOverlay(): Promise<void> {
	if (overlayLoaded && Date.now() - overlayLoadedAt < 15_000) return;
	await refreshRuntimeOverlay();
}

export function runtimeOverlayStatus(): { loaded: boolean; keys: number; loadedAt: string | null } {
	return {
		loaded: overlayLoaded,
		keys: overlay.size,
		loadedAt: overlayLoaded ? new Date(overlayLoadedAt).toISOString() : null,
	};
}

// ─── Typed convenience accessors ─────────────────────────────────────────────

/**
 * The chat completion model.
 *
 * **`AI_DEFAULT_MODEL` is the console-facing key and wins when set.** The existing
 * `ANTHROPIC_MODEL` environment variable is still honoured as the fallback so nothing
 * that works today changes behaviour, and the historical default is preserved for a
 * deployment that sets neither.
 */
export function resolveChatModel(): string {
	return (
		runtimeConfigValue('AI_DEFAULT_MODEL') ??
		process.env.ANTHROPIC_MODEL ??
		'claude-sonnet-4-20250514'
	);
}

/** Max output tokens. `AI_MAX_TOKENS` (console) then `LLM_MAX_OUTPUT_TOKENS` (env). */
export function resolveMaxOutputTokens(): number {
	const raw = runtimeConfigValue('AI_MAX_TOKENS') ?? process.env.LLM_MAX_OUTPUT_TOKENS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 4096;
}

/** True when reminders are enabled by either the control or the config key. */
export function resolveRemindersEnabled(): boolean {
	const control = process.env.CONTROL_NOTIFICATIONS_ENABLED;
	if (control === 'false' || control === '0') return false;
	const value = runtimeConfigValue('REMINDER_ENABLED');
	return value !== 'false' && value !== '0';
}

/** The STT language hint, when a deployment wants to pin one. */
export function resolveSttLanguage(fallback: string): string {
	return runtimeConfigValue('STT_LANGUAGE') ?? fallback;
}

/** Whether the proactive assistant may act, combining the kill switch and the flag. */
export async function resolveProactiveAllowed(): Promise<boolean> {
	const controls = await getRuntimeControls();
	if (!controls.proactiveEnabled || controls.maintenanceMode) return false;
	const value = runtimeConfigValue('PROACTIVE_ASSISTANT_ENABLED');
	return value !== 'false' && value !== '0';
}

/** Whether background jobs may run, combining the kill switch and the config key. */
export async function resolveBackgroundJobsAllowed(): Promise<boolean> {
	const controls = await getRuntimeControls();
	if (!controls.backgroundJobsEnabled || controls.maintenanceMode) return false;
	const value = runtimeConfigValue('BACKGROUND_ASSISTANT_ENABLED');
	return value !== 'false' && value !== '0';
}
