/**
 * NOVA API — Settings routes with real PostgreSQL via drizzle-orm.
 */
import { Router, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { users, privacyPreferences, personas, avatars, companionConfigs, organizations, featureFlags,
} from '@nova/database';
import { eq, and, desc, like, ilike, sql, type SQL } from 'drizzle-orm';
import { authenticate, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';

const escapeHtml = (str: string): string => {
	if (typeof str !== 'string') return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
};

const router: ReturnType<typeof Router> = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const UpdateProfileSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	avatarUrl: z.string().url().optional().or(z.literal('')),
	locale: z.string().max(10).optional(),
	timezone: z.string().max(50).optional(),
});

const NotificationPrefsSchema = z.object({
	notifications: z
		.object({
			push: z.boolean().optional(),
			email: z.boolean().optional(),
			sms: z.boolean().optional(),
			inApp: z.boolean().optional(),
		})
		.optional(),
	appearance: z
		.object({
			theme: z.enum(['system', 'light', 'dark']).optional(),
			fontSize: z.enum(['small', 'medium', 'large']).optional(),
		})
		.optional(),
});

const PersonaSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	personality: z.string().max(50).optional(),
	voiceSpeed: z.coerce.number().int().min(50).max(200).optional(),
	voiceTone: z.string().max(50).optional(),
	languagePolicy: z.enum(['auto', 'en', 'ta', 'tanglish']).optional(),
	wakeWordEnabled: z.boolean().optional(),
});

const CompanionSchema = z.object({
	companionMode: z.enum(['passive', 'active', 'sleep']).optional(),
	wakeWordEnabled: z.boolean().optional(),
	notificationFilter: z.object({
		otpBlocked: z.boolean().optional(),
		bankingBlocked: z.boolean().optional(),
		spamBlocked: z.boolean().optional(),
		blockedKeywords: z.array(z.string()).optional(),
		allowedPackages: z.array(z.string()).optional(),
		blockedPackages: z.array(z.string()).optional(),
	}).optional(),
});

const PrivacyPrefsSchema = z.object({
	saveConversations: z.boolean().optional(),
	saveRecordings: z.boolean().optional(),
	saveTranscripts: z.boolean().optional(),
	saveMemories: z.boolean().optional(),
	// `null` is meaningful here: it is the design's "Never", and the column is
	// nullable. `z.coerce.number()` maps null to 0, which then fails
	// `.positive()`, so null must be matched before the coercion is attempted.
	autoDeleteRecordingsDays: z
		.union([z.literal(null), z.coerce.number().int().positive()])
		.optional(),
	autoDeleteTranscriptsDays: z
		.union([z.literal(null), z.coerce.number().int().positive()])
		.optional(),
	cloudProcessing: z.boolean().optional(),
	localProcessing: z.boolean().optional(),
});

// ─── Profile ─────────────────────────────────────────────────────────────────

router.get('/profile', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
		if (!user) {
			throw new HttpError(404, 'User not found', 'NOT_FOUND');
		}
		res.status(200).json({
			success: true,
			data: {
				id: user.id,
				email: escapeHtml(user.email ?? ''),
				name: escapeHtml(user.name ?? ''),
				avatarUrl: user.avatarUrl,
				locale: user.locale,
				timezone: user.timezone,
			},
		});
	} catch (err) {
		next(err);
	}
});

router.patch('/profile', authenticate, validate(UpdateProfileSchema), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof UpdateProfileSchema>;
		const db = getDb();
		const now = new Date();

		const [updated] = await db.update(users).set({ ...body, updatedAt: now }).where(eq(users.id, req.user!.id)).returning();

		res.status(200).json({
			success: true,
			data: {
				id: updated.id,
				email: escapeHtml(updated.email ?? ''),
				name: escapeHtml(updated.name ?? ''),
				...body,
				updatedAt: updated.updatedAt,
			},
		});
	} catch (err) {
		next(err);
	}
});

// ─── Preferences ─────────────────────────────────────────────────────────────

router.get('/preferences', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		// Reached with raw SQL on purpose: `notification_preferences` was added
		// directly to the database, and @nova/database's dist cannot be rebuilt
		// cleanly (pre-existing type errors in lead.repository.ts), so importing
		// the drizzle table would resolve to undefined at runtime.
		const result = await getDb().execute(
			sql`SELECT push, email, sms, in_app, theme, font_size, updated_at
			    FROM notification_preferences WHERE user_id = ${req.user!.id} LIMIT 1`,
		);
		const row = (result as any)?.rows?.[0];

		res.status(200).json({
			success: true,
			data: {
				notifications: {
					push: row?.push ?? true,
					email: row?.email ?? true,
					sms: row?.sms ?? false,
					inApp: row?.in_app ?? true,
				},
				appearance: {
					theme: row?.theme ?? 'system',
					fontSize: row?.font_size ?? 'medium',
				},
			},
		});
	} catch (err) {
		next(err);
	}
});

router.patch('/preferences', authenticate, validate(NotificationPrefsSchema), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof NotificationPrefsSchema>;
		const n = body.notifications ?? {};
		const a = body.appearance ?? {};

		// COALESCE keeps every unspecified field at its existing value, so a
		// partial patch cannot reset unrelated preferences to their defaults.
		const result = await getDb().execute(
			sql`INSERT INTO notification_preferences
			      (user_id, push, email, sms, in_app, theme, font_size, updated_at)
			    VALUES (
			      ${req.user!.id},
			      COALESCE(${n.push ?? null}, true),
			      COALESCE(${n.email ?? null}, true),
			      COALESCE(${n.sms ?? null}, false),
			      COALESCE(${n.inApp ?? null}, true),
			      COALESCE(${a.theme ?? null}, 'system'),
			      COALESCE(${a.fontSize ?? null}, 'medium'),
			      now()
			    )
			    ON CONFLICT (user_id) DO UPDATE SET
			      push       = COALESCE(${n.push ?? null}, notification_preferences.push),
			      email      = COALESCE(${n.email ?? null}, notification_preferences.email),
			      sms        = COALESCE(${n.sms ?? null}, notification_preferences.sms),
			      in_app     = COALESCE(${n.inApp ?? null}, notification_preferences.in_app),
			      theme      = COALESCE(${a.theme ?? null}, notification_preferences.theme),
			      font_size  = COALESCE(${a.fontSize ?? null}, notification_preferences.font_size),
			      updated_at = now()
			    RETURNING push, email, sms, in_app, theme, font_size, updated_at`,
		);
		const row = (result as any)?.rows?.[0];

		res.status(200).json({
			success: true,
			data: {
				notifications: {
					push: row?.push ?? true,
					email: row?.email ?? true,
					sms: row?.sms ?? false,
					inApp: row?.in_app ?? true,
				},
				appearance: {
					theme: row?.theme ?? 'system',
					fontSize: row?.font_size ?? 'medium',
				},
				updatedAt: row?.updated_at ?? new Date(),
			},
		});
	} catch (err) {
		next(err);
	}
});

// ─── Privacy ─────────────────────────────────────────────────────────────────

router.get('/privacy', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const [prefs] = await db.select().from(privacyPreferences).where(eq(privacyPreferences.userId, req.user!.id)).limit(1);

		if (prefs) {
			res.status(200).json({
				success: true,
				data: {
					saveConversations: prefs.saveConversations,
					saveRecordings: prefs.saveRecordings,
					saveTranscripts: prefs.saveTranscripts,
					saveMemories: prefs.saveMemories,
					autoDeleteRecordingsDays: prefs.autoDeleteRecordingsDays,
					autoDeleteTranscriptsDays: prefs.autoDeleteTranscriptsDays,
					cloudProcessing: prefs.cloudProcessing,
					localProcessing: prefs.localProcessing,
				},
			});
		} else {
			res.status(200).json({
				success: true,
				data: {
					saveConversations: true,
					saveRecordings: true,
					saveTranscripts: true,
					saveMemories: true,
					autoDeleteRecordingsDays: 30,
					autoDeleteTranscriptsDays: 7,
					cloudProcessing: true,
					localProcessing: false,
				},
			});
		}
	} catch (err) {
		next(err);
	}
});

router.patch('/privacy', authenticate, validate(PrivacyPrefsSchema), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof PrivacyPrefsSchema>;
		const db = getDb();
		const now = new Date();

		const [prefs] = await db.select().from(privacyPreferences).where(eq(privacyPreferences.userId, req.user!.id)).limit(1);

		if (prefs) {
			const [updated] = await db.update(privacyPreferences).set({ ...body, updatedAt: now }).where(eq(privacyPreferences.userId, req.user!.id)).returning();
			res.status(200).json({ success: true, data: { ...body, userId: req.user!.id, updatedAt: updated.updatedAt } });
		} else {
			const [created] = await db.insert(privacyPreferences).values({
				userId: req.user!.id,
				...body,
				updatedAt: now,
			}).returning();
			res.status(200).json({ success: true, data: { ...body, userId: req.user!.id, updatedAt: created.updatedAt } });
		}
	} catch (err) {
		next(err);
	}
});

// ─── Persona ─────────────────────────────────────────────────────────────────

router.get('/persona', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const [persona] = await db.select().from(personas).where(eq(personas.userId, req.user!.id)).limit(1);

		if (persona) {
			res.status(200).json({
				success: true,
				data: {
					name: persona.name,
					personality: persona.personality,
					voiceSpeed: persona.voiceSpeed,
					voiceTone: persona.voiceTone,
					languagePolicy: persona.languagePolicy,
					wakeWordEnabled: persona.wakeWordEnabled,
				},
			});
		} else {
			res.status(200).json({
				success: true,
				data: {
					name: 'Assistant',
					personality: 'friendly',
					voiceSpeed: 100,
					voiceTone: 'neutral',
					languagePolicy: 'auto',
					wakeWordEnabled: true,
				},
			});
		}
	} catch (err) {
		next(err);
	}
});

router.put('/persona', authenticate, validate(PersonaSchema), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof PersonaSchema>;
		const db = getDb();
		const now = new Date();

		const [existing] = await db.select().from(personas).where(eq(personas.userId, req.user!.id)).limit(1);

		if (existing) {
			const [updated] = await db.update(personas).set({ ...body, updatedAt: now }).where(eq(personas.userId, req.user!.id)).returning();
			res.status(200).json({ success: true, data: { ...body, userId: req.user!.id, updatedAt: updated.updatedAt } });
		} else {
			const [created] = await db.insert(personas).values({
				userId: req.user!.id,
				...body,
				updatedAt: now,
			}).returning();
			res.status(200).json({ success: true, data: { ...body, userId: req.user!.id, updatedAt: created.updatedAt } });
		}
	} catch (err) {
		next(err);
	}
});

// ─── Avatars ──────────────────────────────────────────────────────────────────

router.get('/avatars', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const avatarList = await db.select().from(avatars).where(eq(avatars.userId, req.user!.id));

		res.status(200).json({
			success: true,
			data: avatarList,
		});
	} catch (err) {
		next(err);
	}
});

// The `avatars` table stores an asset reference plus appearance settings —
// `assetId`, `emotion`, `animationDensity` — and `userId` is UNIQUE (one avatar
// per user). The previous body accepted `name` / `avatarUrl` / `isActive`,
// which are not columns: drizzle silently dropped all three, so the route
// answered 201 having stored nothing the caller sent, and a second call hit the
// unique constraint and surfaced as a 500. It is an upsert on the real columns.
const AvatarBodySchema = z.object({
	assetId: z.string().uuid().nullable().optional(),
	emotion: z.string().min(1).max(50).optional(),
	animationDensity: z.enum(['low', 'medium', 'high']).optional(),
});

router.post('/avatars', authenticate, validate(AvatarBodySchema), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof AvatarBodySchema>;
		const db = getDb();
		const now = new Date();

		const [saved] = await db
			.insert(avatars)
			.values({
				userId: req.user!.id,
				assetId: body.assetId ?? null,
				emotion: body.emotion ?? 'neutral',
				animationDensity: body.animationDensity ?? 'medium',
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: avatars.userId,
				set: {
					...(body.assetId !== undefined ? { assetId: body.assetId } : {}),
					...(body.emotion !== undefined ? { emotion: body.emotion } : {}),
					...(body.animationDensity !== undefined
						? { animationDensity: body.animationDensity }
						: {}),
					updatedAt: now,
				},
			})
			.returning();

		res.status(200).json({ success: true, data: saved });
	} catch (err) {
		next(err);
	}
});

router.delete('/avatars/:id', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const avatarId = req.params.id;
		if (!avatarId) {
			throw new HttpError(400, 'Invalid avatar ID', 'BAD_REQUEST');
		}

		const [existing] = await db.select().from(avatars)
			.where(and(eq(avatars.id, avatarId), eq(avatars.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Avatar not found', 'NOT_FOUND');
		}

		await db.delete(avatars).where(eq(avatars.id, avatarId));
		res.status(200).json({ success: true, data: existing });
	} catch (err) {
		next(err);
	}
});

// ─── Companion ────────────────────────────────────────────────────────────────

router.get('/companion', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const [config] = await db.select().from(companionConfigs).where(eq(companionConfigs.userId, req.user!.id)).limit(1);

		if (config) {
			res.status(200).json({
				success: true,
				data: {
					companionMode: config.companionMode,
					wakeWordEnabled: config.wakeWordEnabled,
					notificationFilter: config.notificationFilter,
				},
			});
		} else {
			res.status(200).json({
				success: true,
				data: {
					companionMode: 'passive',
					wakeWordEnabled: false,
					notificationFilter: {
						otpBlocked: false,
						bankingBlocked: false,
						spamBlocked: false,
						blockedKeywords: [],
						allowedPackages: [],
						blockedPackages: [],
					},
				},
			});
		}
	} catch (err) {
		next(err);
	}
});

router.patch('/companion', authenticate, validate(CompanionSchema), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CompanionSchema>;
		const db = getDb();
		const now = new Date();

		const [existing] = await db.select().from(companionConfigs).where(eq(companionConfigs.userId, req.user!.id)).limit(1);

		if (existing) {
			const [updated] = await db.update(companionConfigs).set({ ...body, updatedAt: now }).where(eq(companionConfigs.userId, req.user!.id)).returning();
			res.status(200).json({ success: true, data: { ...body, userId: req.user!.id, updatedAt: updated.updatedAt } });
		} else {
			const [created] = await db.insert(companionConfigs).values({
				userId: req.user!.id,
				companionMode: body.companionMode ?? 'passive',
				wakeWordEnabled: body.wakeWordEnabled ?? false,
				notificationFilter: body.notificationFilter ?? {
					otpBlocked: false,
					bankingBlocked: false,
					spamBlocked: false,
					blockedKeywords: [],
					allowedPackages: [],
					blockedPackages: [],
				},
				updatedAt: now,
			}).returning();
			res.status(200).json({ success: true, data: { ...body, userId: req.user!.id, updatedAt: created.updatedAt } });
		}
	} catch (err) {
		next(err);
	}
});

// ─── Org / Admin Settings ─────────────────────────────────────────────────────

router.get('/organization', requireRole('admin'), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const orgList = await db.select().from(organizations).limit(1);
		const org = orgList[0];

		res.status(200).json({
			success: true,
			data: org ?? {
				name: 'Default Organization',
				slug: 'default',
				settings: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
	} catch (err) {
		next(err);
	}
});

router.patch('/organization', requireRole('admin'), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const updates = req.body;
		const now = new Date();

		const [updated] = await db.update(organizations).set({ ...updates, updatedAt: now }).returning();

		res.status(200).json({ success: true, data: updated });
	} catch (err) {
		next(err);
	}
});

// ─── Feature Flags ────────────────────────────────────────────────────────────

router.get('/feature-flags', requireRole('admin'), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const flags = await db.select().from(featureFlags);

		res.status(200).json({
			success: true,
			data: flags,
		});
	} catch (err) {
		next(err);
	}
});

router.patch('/feature-flags/:id', requireRole('admin'), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const flagId = parseInt(req.params.id);
		if (Number.isNaN(flagId)) {
			throw new HttpError(400, 'Invalid feature flag ID', 'BAD_REQUEST');
		}

		const { enabled } = req.body as { enabled: boolean };
		const [updated] = await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.id, flagId)).returning();

		res.status(200).json({ success: true, data: updated });
	} catch (err) {
		next(err);
	}
});

// ─── Rate Limits (Admin) ──────────────────────────────────────────────────────

router.get('/rate-limits', requireRole('admin'), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		res.status(200).json({
			success: true,
			data: [],
		});
	} catch (err) {
		next(err);
	}
});

router.patch('/rate-limits/:id', requireRole('admin'), async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		res.status(200).json({ success: true, data: null });
	} catch (err) {
		next(err);
	}
});

// ─── Export ───────────────────────────────────────────────────────────────────

router.get('/export', authenticate, async (req: AuthenticatedRequest, res, next: NextFunction) => {
	try {
		const db = getDb();
		const profile = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
		const userPreferences = await db.select().from(privacyPreferences).where(eq(privacyPreferences.userId, req.user!.id)).limit(1);
		const userPersona = await db.select().from(personas).where(eq(personas.userId, req.user!.id)).limit(1);

		res.status(200).json({
			success: true,
			data: {
				profile: profile[0] ?? null,
				preferences: userPreferences[0] ?? null,
				persona: userPersona[0] ?? null,
				exportedAt: new Date(),
			},
		});
	} catch (err) {
		next(err);
	}
});

export { router as settingsRouter };
