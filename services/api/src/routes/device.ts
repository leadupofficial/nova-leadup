/**
 * NOVA API — Device routes (§13.10).
 *
 * `GET|PATCH /api/v1/device/wake-word/config` records **which wake word the user
 * chose**. Read the next paragraph before changing anything here, because the
 * obvious reading of this endpoint is wrong.
 *
 * ── This is a preference record, not a control ───────────────────────────────
 * The phrase NOVA actually listens for is decided **on the device**, by the
 * classifiers compiled into the app bundle (`apps/mobile/android/app/src/main/assets/
 * wakeword/models.json`, consumed by `WakeWordService.kt`). Detection runs
 * entirely offline in an Android foreground service; there is no wake-word
 * service this API could command, and no push channel that could retune a
 * microphone. Storing a phrase here does not change what the device hears.
 *
 * What the record is for: the user's own account carries the choice, so the
 * companion settings are consistent across re-installs and visible to the user
 * later. It is validated against the list the *client* reports are installed,
 * because the client is the only party that knows — a phrase this API invented
 * could never be honoured by any build.
 *
 * A phrase that is not in `available` is rejected rather than stored, so the
 * record can never disagree with a device that is honest about its classifiers.
 *
 * Storage: `companion_configs.wake_word` (jsonb), the per-user companion
 * settings row that already ships with a `{ word, sensitivity }` default. No
 * schema change is needed; the column has existed since the canonical schema
 * was written.
 */
import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/connection.js';
import { companionConfigs, devices } from '@nova/database';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';

const router: ReturnType<typeof Router> = Router();

/**
 * Wake-word names are the classifier identifiers from `models.json`:
 * `hey_jarvis`, `hey_nova`, `hey_mycroft`. Lowercase snake_case only, so a
 * stored record can be compared to an asset name byte-for-byte.
 */
const WakeWordNameSchema = z
	.string()
	.trim()
	.min(1, 'wakeWord must not be empty')
	.max(64, 'wakeWord must be at most 64 characters')
	.regex(
		/^[a-z0-9][a-z0-9_]*$/,
		'wakeWord must be a lowercase classifier name such as "hey_jarvis"',
	);

const WakeWordConfigSchema = z
	.object({
		wakeWord: WakeWordNameSchema,
		/**
		 * The classifier names the calling device reports are installed. Required:
		 * without it this route cannot tell an honest choice from a phrase that
		 * exists nowhere, and the latter is exactly what it must refuse to store.
		 */
		available: z
			.array(WakeWordNameSchema)
			.min(1, 'available must list at least one installed wake word')
			.max(20, 'available must list at most 20 wake words'),
	})
	// Guarded on a non-empty list so an empty `available` reports the single,
	// actionable "list at least one installed wake word" error instead of also
	// tripping this rule and collapsing into "Multiple validation errors".
	.refine((value) => value.available.length === 0 || value.available.includes(value.wakeWord), {
		path: ['wakeWord'],
		message:
			'wakeWord must be one of the wake words reported in available — the device only listens for an installed classifier',
	});

type WakeWordConfigBody = z.infer<typeof WakeWordConfigSchema>;

/** The shape actually persisted in `companion_configs.wake_word`. */
interface StoredWakeWord {
	word?: unknown;
	available?: unknown;
	updatedAt?: unknown;
}

/** Exactly what Dart's `WakeWordAvailability` understands, plus the caveat. */
function present(stored: StoredWakeWord | null | undefined) {
	const word = typeof stored?.word === 'string' && stored.word.length > 0 ? stored.word : null;
	const available = Array.isArray(stored?.available)
		? stored.available.filter((entry): entry is string => typeof entry === 'string')
		: [];
	const updatedAt = typeof stored?.updatedAt === 'string' ? stored.updatedAt : null;

	return {
		wakeWord: word,
		available,
		updatedAt,
		/**
		 * The device, not this API, decides the phrase. Both fields say so in the
		 * payload itself so no client can read `wakeWord` as a remote control.
		 */
		enforcedOnDevice: true,
		control: 'preference_record' as const,
		note:
			'NOVA listens for a wake word installed in the app build on your device. ' +
			'This record stores your choice for your account; it cannot change what the ' +
			'microphone listens for.',
	};
}

// ─── Wake-word config (§13.10) ───────────────────────────────────────────────

router.get('/wake-word/config', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const [row] = await db
			.select()
			.from(companionConfigs)
			.where(eq(companionConfigs.userId, req.user!.id))
			.limit(1);

		// A user with no companion row yet has no recorded choice. The default is
		// `null`, NOT a phrase: this API must never claim a wake word is set when
		// the device has not told it which classifiers exist.
		res.status(200).json({ success: true, data: present((row?.wakeWord ?? null) as StoredWakeWord | null) });
	} catch (err) {
		next(err);
	}
});

router.patch('/wake-word/config', authenticate, validate(WakeWordConfigSchema), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const body = (req as { validatedBody?: WakeWordConfigBody }).validatedBody as WakeWordConfigBody;
		const db = getDb();
		const now = new Date();

		const record = {
			word: body.wakeWord,
			available: body.available,
			updatedAt: now.toISOString(),
		};

		// Upsert on `user_id` (UNIQUE). The other companion columns are left
		// untouched: choosing a phrase is not the same decision as enabling
		// listening, which stays owned by the on-device toggle.
		const [saved] = await db
			.insert(companionConfigs)
			.values({
				userId: req.user!.id,
				wakeWord: record,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: companionConfigs.userId,
				set: { wakeWord: record, updatedAt: now },
			})
			.returning();

		logger.info(
			{ userId: req.user!.id, wakeWord: body.wakeWord, available: body.available },
			'wake-word preference recorded (device enforces the phrase)',
		);

		res.status(200).json({ success: true, data: present((saved?.wakeWord ?? record) as StoredWakeWord) });
	} catch (err) {
		next(err);
	}
});

// ─── Device registration ─────────────────────────────────────────────────────
//
// The `devices` table existed from the canonical schema and **nothing ever wrote to it**.
// That is why the console's device, platform and app-version views were empty, and why the
// version gate had no adoption data to target — not a rendering bug, a missing writer.
//
// Design decisions:
//
//  * **Auth is required.** A device row is linked to an account. Registering before sign-in
//    would mean either an ownerless row or a fabricated one, and the inventory exists to
//    answer "who is on which build". The client calls this right after a session exists.
//  * **`installationId` is the identity, not the row.** The app registers on every launch, so
//    this is an upsert keyed on the installation: one row per install, updated in place. The
//    partial unique index added in migration 0008 is what makes that an upsert rather than a
//    row per start.
//  * **Every field is optional except the installation id.** A client that cannot read its OS
//    version must still be able to register; refusing would lose the device entirely.
//  * **`platformVersion` and `appVersion` are stored, not guessed.** They are what the
//    dashboard's "Android versions" and "app versions" tiles read.

const RegisterDeviceSchema = z
	.object({
		installationId: z.string().trim().min(8).max(100),
		name: z.string().trim().max(255).optional(),
		platform: z.string().trim().max(50).optional(),
		platformVersion: z.string().trim().max(50).optional(),
		model: z.string().trim().max(100).optional(),
		appVersion: z.string().trim().max(50).optional(),
		/**
		 * The FCM registration token from `firebase_messaging`.
		 *
		 * `devices.push_token` has existed all along and the admin console even
		 * reports `hasPushToken`, but nothing ever wrote it, so there was no
		 * transport for proactive nudges at all. An empty string clears it (the
		 * token is dead); omitting it leaves the stored token alone, so a routine
		 * re-registration cannot wipe a good token.
		 */
		pushToken: z.string().trim().max(4096).optional(),
	})
	.strict();

router.post('/register', authenticate, validate(RegisterDeviceSchema), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
	try {
		const body = (req as unknown as { validatedBody: z.infer<typeof RegisterDeviceSchema> }).validatedBody;
		const userId = req.user!.id;
		const db = getDb();
		const now = new Date();

		// Upsert on the installation id. `onConflictDoUpdate` needs the conflict target to be a
		// unique index, which migration 0008 creates.
		const [row] = await db
			.insert(devices)
			.values({
				userId,
				installationId: body.installationId,
				name: body.name ?? null,
				platform: body.platform ?? null,
				platformVersion: body.platformVersion ?? null,
				model: body.model ?? null,
				appVersion: body.appVersion ?? null,
				pushToken: body.pushToken ? body.pushToken : null,
				lastSeenAt: now,
			})
			.onConflictDoUpdate({
				target: devices.installationId,
				set: {
					// Rebind to the current account: a shared device switching users must not stay
					// attached to the previous one.
					userId,
					name: body.name ?? null,
					platform: body.platform ?? null,
					platformVersion: body.platformVersion ?? null,
					model: body.model ?? null,
					appVersion: body.appVersion ?? null,
					// Only touched when the client actually reported one, so the
					// launch-time re-registration that carries no token cannot erase it.
					// Only touched when the client actually reported one, so the
					// launch-time re-registration that carries no token cannot erase it.
					...(body.pushToken === undefined
						? {}
						: { pushToken: body.pushToken ? body.pushToken : null }),
					lastSeenAt: now,
				},
			})
			.returning({ id: devices.id, createdAt: devices.createdAt });

		res.status(200).json({
			success: true,
			data: {
				deviceId: row?.id ?? null,
				registeredAt: now.toISOString(),
				// The client is told what the server now believes, so a mismatch (wrong platform
				// reported) is visible rather than silent.
				recorded: {
					platform: body.platform ?? null,
					platformVersion: body.platformVersion ?? null,
					appVersion: body.appVersion ?? null,
					hasPushToken: Boolean(body.pushToken),
				},
				note:
					'Re-registering the same installationId updates this row rather than creating another. This endpoint is the only writer of the devices table.',
			},
		});
	} catch (err) {
		logger.error({ err }, 'Device registration failed');
		next(err);
	}
});

/**
 * `GET /device/register` — what the server currently holds for this installation.
 *
 * Lets the client check whether its last report landed, without a console session.
 */
router.get('/register', authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
	try {
		const installationId = typeof req.query.installationId === 'string' ? req.query.installationId.trim() : '';
		if (!installationId) {
			res.status(400).json({ success: false, error: 'installationId is required', code: 'BAD_REQUEST' });
			return;
		}

		const db = getDb();
		const [row] = await db
			.select()
			.from(devices)
			.where(and(eq(devices.installationId, installationId), eq(devices.userId, req.user!.id)))
			.limit(1);

		res.status(200).json({
			success: true,
			data: {
				registered: Boolean(row),
				device: row
					? {
							id: row.id,
							platform: row.platform,
							platformVersion: row.platformVersion,
							model: row.model,
							appVersion: row.appVersion,
							// Reported, not returned: the client needs to know whether a
							// push token is on file — this is the read-back for the one
							// thing that decides whether a nudge can reach the device —
							// without the token itself travelling back over the wire.
							hasPushToken: Boolean(row.pushToken),
							lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
						}
					: null,
			},
		});
	} catch (err) {
		next(err);
	}
});

export { router as deviceRouter };
