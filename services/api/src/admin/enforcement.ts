/**
 * NOVA — Capability enforcement middleware.
 *
 * The operator controls in `admin/control.ts` are only real if something refuses a
 * request when they are off. This module is that refusal.
 *
 * Design rules:
 *
 * - **Fail open on control lookup failure, fail closed on a known-off control.**
 *   If `system_configs` is unreachable, capability requests proceed: an
 *   infrastructure hiccup must not become a platform-wide outage. If a control is
 *   successfully read and says "off", the request is refused. The asymmetry is
 *   deliberate — a kill switch is meant to be thrown by a human, so its *absence*
 *   should never be the thing that takes NOVA down.
 *
 * - **`503` with a machine-readable code**, not `403`. The client needs to
 *   distinguish "NOVA is temporarily unavailable" (show the maintenance message,
 *   keep the session) from "you are not allowed" (sign out). Every refusal carries
 *   `code` and a `retryable: true` hint so the Flutter client can branch without
 *   string matching.
 *
 * - **Maintenance and capability are different refusals.** Maintenance mode is a
 *   platform-wide notice; a disabled capability is one subsystem being switched off.
 *   Both return 503 but the code and message differ.
 */

import type { Request, Response, NextFunction } from 'express';
import { getRuntimeControls, type ControlKey } from './control.js';
import { logger } from '../utils/logger.js';

export type CapabilityName =
	| 'ai'
	| 'voice'
	| 'stt'
	| 'tts'
	| 'notifications'
	| 'background_jobs'
	| 'proactive'
	| 'realtime';

const CONTROL_FOR_CAPABILITY: Record<CapabilityName, ControlKey> = {
	ai: 'CONTROL_AI_ENABLED',
	voice: 'CONTROL_VOICE_ENABLED',
	stt: 'CONTROL_STT_ENABLED',
	tts: 'CONTROL_TTS_ENABLED',
	notifications: 'CONTROL_NOTIFICATIONS_ENABLED',
	background_jobs: 'CONTROL_BACKGROUND_JOBS_ENABLED',
	proactive: 'CONTROL_PROACTIVE_ENABLED',
	realtime: 'CONTROL_REALTIME_ENABLED',
};

const CAPABILITY_LABEL: Record<CapabilityName, string> = {
	ai: 'AI',
	voice: 'Voice',
	stt: 'Speech-to-text',
	tts: 'Text-to-speech',
	notifications: 'Notifications',
	background_jobs: 'Background processing',
	proactive: 'Proactive assistance',
	realtime: 'Realtime connection',
};

function refuse(
	res: Response,
	status: number,
	code: string,
	message: string,
	extra: Record<string, unknown> = {},
): void {
	res.status(status).json({
		type: `https://api.nova.leadup.in/problems/${code.toLowerCase()}`,
		title: message,
		status,
		detail: message,
		error: code,
		code,
		retryable: true,
		...extra,
	});
}

/**
 * Gate a router or route on one or more capabilities.
 *
 * ```ts
 * apiV1.use('/ai', requireCapability('ai'), aiRoutes);
 * ```
 *
 * When `alsoMaintenance` is true (the default), platform maintenance mode also
 * refuses the request — that is what makes maintenance mode a real switch rather
 * than a banner.
 */
export function requireCapability(capability: CapabilityName, options: { alsoMaintenance?: boolean } = {}) {
	const alsoMaintenance = options.alsoMaintenance ?? true;
	const controlKey = CONTROL_FOR_CAPABILITY[capability];

	return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
		try {
			const controls = await getRuntimeControls();

			if (alsoMaintenance && controls.maintenanceMode) {
				refuse(res, 503, 'MAINTENANCE_MODE', controls.maintenanceMessage || 'NOVA is under maintenance.', {
					maintenance: true,
					maintenanceMessage: controls.maintenanceMessage,
					capability,
				});
				return;
			}

			const enabled = Boolean(controls[controlKeyToProperty(controlKey)]);
			if (!enabled) {
				refuse(
					res,
					503,
					'CAPABILITY_DISABLED',
					`${CAPABILITY_LABEL[capability]} is currently disabled by an operator.`,
					{ capability, controlKey },
				);
				return;
			}

			next();
		} catch (error) {
			// Fail open. See the module comment.
			logger.error(
				{ err: error, capability },
				'[capability-gate] could not read operator controls; allowing the request',
			);
			next();
		}
	};
}

/** Maps a `CONTROL_X_ENABLED` key to the camelCase property on `RuntimeControls`. */
function controlKeyToProperty(key: ControlKey): keyof Awaited<ReturnType<typeof getRuntimeControls>> {
	const map: Partial<Record<ControlKey, keyof Awaited<ReturnType<typeof getRuntimeControls>>>> = {
		CONTROL_AI_ENABLED: 'aiEnabled',
		CONTROL_VOICE_ENABLED: 'voiceEnabled',
		CONTROL_STT_ENABLED: 'sttEnabled',
		CONTROL_TTS_ENABLED: 'ttsEnabled',
		CONTROL_NOTIFICATIONS_ENABLED: 'notificationsEnabled',
		CONTROL_BACKGROUND_JOBS_ENABLED: 'backgroundJobsEnabled',
		CONTROL_PROACTIVE_ENABLED: 'proactiveEnabled',
		CONTROL_REALTIME_ENABLED: 'realtimeEnabled',
	};
	return map[key] ?? 'aiEnabled';
}

/**
 * Programmatic check for code paths that are not Express routes — the background
 * engines, for example, which must skip a run when switched off.
 */
export async function isCapabilityAvailable(capability: CapabilityName): Promise<{
	allowed: boolean;
	reason: string | null;
}> {
	try {
		const controls = await getRuntimeControls();
		if (controls.maintenanceMode) {
			return { allowed: false, reason: 'maintenance mode is active' };
		}
		const enabled = Boolean(controls[controlKeyToProperty(CONTROL_FOR_CAPABILITY[capability])]);
		return { allowed: enabled, reason: enabled ? null : `${capability} is disabled by an operator` };
	} catch (error) {
		logger.error({ err: error, capability }, '[capability-gate] control lookup failed; allowing');
		return { allowed: true, reason: null };
	}
}

/**
 * Whether a scheduled background engine may run right now.
 *
 * Extracted so the three in-process engines (follow-up, retention sweep, recording reaper)
 * share one definition rather than each re-deriving it. Before this existed, **none** of them
 * consulted the switches: an operator could disable background jobs in the console, the
 * dashboard would report them off, and every sweep kept running and kept deleting rows. That
 * is the worst failure a control plane can have — the operator believes they stopped the
 * behaviour and has not.
 *
 * `reason` is a stable machine-readable slug, so a caller can record why it skipped.
 *
 * Fails **open** on a lookup error, like every other gate here: a database blip must not
 * silently stop retention (which would grow storage unbounded) with no operator action and no
 * audit row.
 */
export async function backgroundJobsGate(): Promise<{ allowed: boolean; reason: string | null }> {
	try {
		const controls = await getRuntimeControls();
		if (controls.maintenanceMode) return { allowed: false, reason: 'maintenance-mode' };
		if (!controls.backgroundJobsEnabled) return { allowed: false, reason: 'background-jobs-disabled' };
		return { allowed: true, reason: null };
	} catch (error) {
		logger.warn({ err: error }, '[capability-gate] could not read the background-jobs gate; allowing the run');
		return { allowed: true, reason: null };
	}
}

/** Whether NOVA may initiate contact: the proactive switch plus the configuration key. */
export async function proactiveGate(): Promise<{ allowed: boolean; reason: string | null }> {
	try {
		const controls = await getRuntimeControls();
		if (controls.maintenanceMode) return { allowed: false, reason: 'maintenance-mode' };
		if (!controls.backgroundJobsEnabled) return { allowed: false, reason: 'background-jobs-disabled' };
		if (!controls.proactiveEnabled) return { allowed: false, reason: 'proactive-disabled' };

		// The ordinary configuration key, distinct from the emergency switch: an operator may
		// turn proactive behaviour off without declaring an incident.
		const { runtimeConfigValue } = await import('./runtime-config.js');
		const configured = runtimeConfigValue('PROACTIVE_ASSISTANT_ENABLED');
		if (configured === 'false' || configured === '0') {
			return { allowed: false, reason: 'proactive-config-disabled' };
		}
		return { allowed: true, reason: null };
	} catch (error) {
		logger.warn({ err: error }, '[capability-gate] could not read the proactive gate; allowing the run');
		return { allowed: true, reason: null };
	}
}
