/**
 * NOVA — Client bootstrap and remote configuration.
 *
 * **This endpoint is what makes the admin panel control the mobile app.**
 *
 * Before it existed, `feature_flags` was a table with a CRUD screen and no reader:
 * the Flutter client fetched no remote configuration at all (verified — no
 * `featureFlag`, `remoteConfig`, `maintenance` or `minimumVersion` handling anywhere
 * in `apps/mobile/lib`), so toggling a flag changed a database row and nothing else.
 * The console was therefore *not* a control plane, whatever it looked like.
 *
 * The contract:
 *
 *   `GET /api/v1/device/bootstrap`  (optional bearer token)
 *
 *     {
 *       flags: { VOICE_ASSISTANT: true, PROACTIVE_ASSISTANT: false, ... },
 *       flagDetails: [ { key, enabled, source, rolloutPercent, reason } ],
 *       maintenance: { enabled, message },
 *       version: { minimum, latest, forceUpdate, updateRequired },
 *       capabilities: { voice, stt, tts, ai, avatar, overlay, notifications, realtime },
 *       config: { /* public config only *\/ },
 *       environment, generatedAt, ttlSeconds
 *     }
 *
 * Design decisions worth keeping:
 *
 * - **Optional auth, not required.** A client that has not signed in still needs the
 *   maintenance flag and the version gate, so the endpoint accepts a token but does
 *   not demand one. Without a token, per-user flag overrides cannot apply and the
 *   response says which evaluations were therefore skipped.
 *
 * - **`flags` is a flat boolean map AND `flagDetails` explains each one.** The app
 *   wants a cheap lookup; an operator wants to know *why*. Both come from the same
 *   evaluation, so they cannot disagree.
 *
 * - **`capabilities` folds the kill switches in.** A client that only reads `flags`
 *   would miss an emergency `CONTROL_AI_ENABLED=off`, so the effective answer is
 *   pre-computed here rather than left to the client to combine.
 *
 * - **Short TTL, and the client is told what it is.** A control change should reach
 *   devices quickly; `ttlSeconds` lets the app refresh on a sensible cadence instead
 *   of polling blindly. There is no push channel (the Flutter app has no FCM
 *   integration), so polling is the only mechanism, and saying so is more useful
 *   than implying instant delivery.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { users } from '@nova/database';
import { getDb } from '../db/connection.js';
import { verifyAccessToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { evaluateAllFlags } from '../admin/flags.js';
import { getRuntimeControls } from '../admin/control.js';
import { resolveConfigMap, publicConfigKeys } from '../admin/config.js';

const router: ReturnType<typeof Router> = Router();

/** How long a client may cache the response. Kept short: this carries kill switches. */
const BOOTSTRAP_TTL_SECONDS = 60;

type BootstrappedUser = { id: string; organizationId: string | null } | null;

/**
 * Resolves the caller without requiring a token.
 *
 * A malformed or expired token is treated as anonymous rather than as an error: the
 * client should still receive maintenance state and the version gate so it can show
 * a meaningful screen instead of a network error. The failure reason is reported in
 * `auth` so the app can decide to sign the user out on its own terms.
 */
async function resolveOptionalUser(req: Request): Promise<{
	user: BootstrappedUser;
	auth: { authenticated: boolean; note: string | null };
}> {
	const header = req.headers.authorization;
	if (!header?.startsWith('Bearer ')) {
		return {
			user: null,
			auth: { authenticated: false, note: 'No bearer token supplied; per-user flag overrides are not applied.' },
		};
	}

	const token = header.slice(7).trim();
	if (!token) {
		return { user: null, auth: { authenticated: false, note: 'Empty bearer token.' } };
	}

	try {
		const claims = verifyAccessToken(token);
		try {
			const db = getDb();
			const [row] = (await db
				.select({ id: users.id, organizationId: users.organizationId, disabled: users.disabled })
				.from(users)
				.where(eq(users.id, claims.id))
				.limit(1)) as unknown as Array<{ id: string; organizationId: string | null; disabled: boolean }>;

			if (!row) {
				return {
					user: null,
					auth: { authenticated: false, note: 'Token is valid but the account no longer exists.' },
				};
			}
			if (row.disabled) {
				// Surfaced explicitly so the app can sign out and explain why, instead of
				// silently degrading to anonymous configuration.
				return {
					user: null,
					auth: {
						authenticated: false,
						note: 'This account is suspended. Configuration is being served anonymously.',
					},
				};
			}
			return {
				user: { id: row.id, organizationId: row.organizationId },
				auth: { authenticated: true, note: null },
			};
		} catch (error) {
			// A database failure must not deny configuration; fall back to the claims.
			logger.warn({ err: error }, '[bootstrap] could not load user row; using token claims only');
			return {
				user: { id: claims.id, organizationId: null },
				auth: { authenticated: true, note: 'Organization-scoped overrides were skipped (database read failed).' },
			};
		}
	} catch {
		return {
			user: null,
			auth: { authenticated: false, note: 'The supplied token is invalid or expired.' },
		};
	}
}

/** Simple semantic-version compare, tolerant of a `v` prefix and build metadata. */
export function compareVersions(a: string, b: string): number {
	const normalise = (value: string) =>
		value
			.replace(/^v/i, '')
			.split('+')[0]
			.split('-')[0]
			.split('.')
			.map((part) => Number.parseInt(part, 10) || 0);

	const left = normalise(a);
	const right = normalise(b);
	const length = Math.max(left.length, right.length);

	for (let i = 0; i < length; i += 1) {
		const l = left[i] ?? 0;
		const r = right[i] ?? 0;
		if (l > r) return 1;
		if (l < r) return -1;
	}
	return 0;
}

/**
 * `GET /device/bootstrap`
 *
 * Public (optional auth). Every value is derived from the same resolvers the admin
 * console uses, so what an operator sees in the console and what a client receives
 * cannot diverge.
 */
router.get('/bootstrap', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { user, auth } = await resolveOptionalUser(req);

		// The client reports its own version so the server can decide the gate.
		const clientVersion = typeof req.query.version === 'string' ? req.query.version : null;
		const clientPlatform = typeof req.query.platform === 'string' ? req.query.platform : null;

		const [controls, publicConfig, flagDetails] = await Promise.all([
			getRuntimeControls(),
			resolveConfigMap(publicConfigKeys()),
			evaluateAllFlags(
				{ userId: user?.id ?? null, organizationId: user?.organizationId ?? null },
				// Defaults preserve current behaviour for a flag that has no row, so
				// adding a flag cannot switch a feature off for an existing user.
				{
					VOICE_ASSISTANT: true,
					BACKGROUND_ASSISTANT: true,
					PROACTIVE_ASSISTANT: true,
					AVATAR: true,
					OVERLAY: true,
					MEMORY: true,
					TASKS: true,
					REMINDERS: true,
					FOLLOW_UP: true,
					AI_TOOLS: true,
					WEB_SEARCH: false,
					VOICE_STT: true,
					VOICE_TTS: true,
					WAKE_WORD: true,
					NOTIFICATIONS: true,
					REALTIME: true,
					AI: true,
				},
			),
		]);

		const flags: Record<string, boolean> = {};
		for (const detail of flagDetails) flags[detail.key] = detail.enabled;

		const minimumVersion = publicConfig.MOBILE_MIN_SUPPORTED_VERSION ?? '1.0.0';
		const latestVersion = publicConfig.MOBILE_LATEST_VERSION ?? '1.0.0';
		const forceUpdate = publicConfig.MOBILE_FORCE_UPDATE === 'true';

		// `updateRequired` is computed from the minimum version, not from the force
		// flag: a client below the minimum cannot talk to this backend correctly
		// whatever the operator wants, whereas `forceUpdate` is a product decision to
		// push the newest build onto clients that are still compatible.
		const belowMinimum = clientVersion ? compareVersions(clientVersion, minimumVersion) < 0 : false;

		// Kill switches folded into capability answers. `maintenance` already forces
		// everything off, so a client that only reads `capabilities` still behaves.
		const capabilities = {
			ai: flags.AI && controls.aiEnabled && !controls.maintenanceMode,
			voice: flags.VOICE_ASSISTANT && flags.VOICE_STT && flags.VOICE_TTS && controls.voiceEnabled && !controls.maintenanceMode,
			stt: flags.VOICE_STT && controls.sttEnabled && !controls.maintenanceMode,
			tts: flags.VOICE_TTS && controls.ttsEnabled && !controls.maintenanceMode,
			avatar: flags.AVATAR && !controls.maintenanceMode,
			overlay: flags.OVERLAY && !controls.maintenanceMode,
			notifications: flags.NOTIFICATIONS && controls.notificationsEnabled && !controls.maintenanceMode,
			realtime: flags.REALTIME && controls.realtimeEnabled && !controls.maintenanceMode,
			memory: flags.MEMORY && !controls.maintenanceMode,
			tasks: flags.TASKS && !controls.maintenanceMode,
			reminders: flags.REMINDERS && !controls.maintenanceMode,
			proactive: flags.PROACTIVE_ASSISTANT && controls.proactiveEnabled && !controls.maintenanceMode,
			background: flags.BACKGROUND_ASSISTANT && controls.backgroundJobsEnabled && !controls.maintenanceMode,
		};

		res.setHeader('Cache-Control', `private, max-age=${BOOTSTRAP_TTL_SECONDS}`);
		res.json({
			success: true,
			data: {
				flags,
				flagDetails,
				maintenance: {
					enabled: controls.maintenanceMode,
					message: controls.maintenanceMessage,
				},
				version: {
					minimum: minimumVersion,
					latest: latestVersion,
					forceUpdate,
					clientVersion,
					clientPlatform,
					updateRequired: belowMinimum,
					updateRecommended: clientVersion ? compareVersions(clientVersion, latestVersion) < 0 : false,
				},
				capabilities,
				controls: {
					aiEnabled: controls.aiEnabled,
					voiceEnabled: controls.voiceEnabled,
					sttEnabled: controls.sttEnabled,
					ttsEnabled: controls.ttsEnabled,
					backgroundJobsEnabled: controls.backgroundJobsEnabled,
					proactiveEnabled: controls.proactiveEnabled,
					notificationsEnabled: controls.notificationsEnabled,
					realtimeEnabled: controls.realtimeEnabled,
					anyDisabled: controls.anyDisabled,
					operatorNote: controls.operatorNote,
				},
				config: publicConfig,
				auth,
				environment: req.headers['x-nova-environment'] ?? process.env.NODE_ENV ?? 'development',
				ttlSeconds: BOOTSTRAP_TTL_SECONDS,
				generatedAt: new Date().toISOString(),
				propagation: {
					note:
						'Flag and control changes are applied on this server within the config cache window (15 seconds for flags, 5 seconds for controls). Clients pick them up on their next bootstrap call; there is no push channel, so a device that is idle or offline keeps its last configuration until its next fetch.',
				},
			},
		});
	} catch (error) {
		next(error);
	}
});

/**
 * `GET /device/bootstrap/version-gate`
 *
 * A tiny, cacheable endpoint for a client that only needs the update decision, so
 * the app can check on launch without pulling the whole document.
 */
router.get('/bootstrap/version-gate', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const clientVersion = typeof req.query.version === 'string' ? req.query.version : null;
		const config = await resolveConfigMap([
			'MOBILE_MIN_SUPPORTED_VERSION',
			'MOBILE_LATEST_VERSION',
			'MOBILE_FORCE_UPDATE',
			'MAINTENANCE_MODE',
			'MAINTENANCE_MESSAGE',
		]);

		const minimum = config.MOBILE_MIN_SUPPORTED_VERSION ?? '1.0.0';
		const latest = config.MOBILE_LATEST_VERSION ?? '1.0.0';
		const maintenance = config.MAINTENANCE_MODE === 'true' || (await getRuntimeControls()).maintenanceMode;

		res.setHeader('Cache-Control', `private, max-age=${BOOTSTRAP_TTL_SECONDS}`);
		res.json({
			success: true,
			data: {
				minimumVersion: minimum,
				latestVersion: latest,
				forceUpdate: config.MOBILE_FORCE_UPDATE === 'true',
				updateRequired: clientVersion ? compareVersions(clientVersion, minimum) < 0 : false,
				maintenance,
				maintenanceMessage: config.MAINTENANCE_MESSAGE ?? '',
			},
		});
	} catch (error) {
		next(error);
	}
});

export default router;
