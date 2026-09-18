/**
 * NOVA API — Centralized Zod validation schemas.
 *
 * All route-level validation schemas live here. Routes import the schemas
 * they need and use the `validate()` middleware to enforce them.
 *
 * This file covers schemas for routes that previously had NO validation,
 * or had incomplete validation on query params / sub-resources.
 */
import { z } from 'zod';

// ─── Shared primitives ────────────────────────────────────────────────────────

const PaginationSchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const CursorPaginationSchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
});

export type CursorPaginationInput = z.infer<typeof CursorPaginationSchema>;

export function decodeCursor(cursor: string): string {
	try {
		const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
		const parsed = JSON.parse(decoded);
		if (typeof parsed.id !== 'string') {
			throw new Error('Invalid cursor format');
		}
		return parsed.id;
	} catch {
		throw new Error('Invalid cursor');
	}
}

export function encodeCursor(id: string): string {
	return Buffer.from(JSON.stringify({ id }), 'utf-8').toString('base64');
}

export function parseCursorPagination(req: { query: { cursor?: string; limit?: string; direction?: string } }): CursorPaginationInput {
	const { cursor, limit, direction } = req.query;
	return {
		cursor: typeof cursor === 'string' ? cursor : undefined,
		limit: typeof limit === 'string' ? Math.min(Number(limit), 100) : 20,
		direction: (typeof direction === 'string' && ['forward', 'backward'].includes(direction) ? direction : 'forward') as 'forward' | 'backward',
	};
}

const DateRangeSchema = z.object({
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
});

// ─── Auth schemas ─────────────────────────────────────────────────────────────

export const RegisterSchema = z.object({
	email: z.string().email(),
	password: z.string().min(12),
	name: z.string().min(1).max(255).optional(),
});

export const LoginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
});

export const RefreshTokenSchema = z.object({
	refreshToken: z.string().min(1),
});

export const ForgotPasswordSchema = z.object({
	email: z.string().email(),
});

export const ResetPasswordSchema = z.object({
	token: z.string().min(1),
	password: z.string().min(12),
});

export const VerifyEmailSchema = z.object({
	token: z.string().min(1),
});

// ─── Conversation schemas ─────────────────────────────────────────────────────

export const CreateConversationSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	mode: z.enum(['text', 'voice']).default('text'),
});

export const UpdateConversationSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	mode: z.enum(['text', 'voice']).optional(),
});

export const ConversationListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
});

export const SendMessageSchema = z.object({
	role: z.enum(['user', 'assistant']),
	content: z.string().min(1),
	model: z.string().max(100).optional(),
	toolCalls: z.any().optional(),
	toolResults: z.any().optional(),
});

// ─── Memory schemas ───────────────────────────────────────────────────────────

export const CreateMemorySchema = z.object({
	content: z.string().min(1),
	category: z.enum(['fact', 'preference', 'event', 'contact', 'decision']),
	sourceType: z.enum(['conversation', 'recording', 'manual', 'imported']),
	visibility: z.enum(['private', 'shared', 'team']).default('private'),
	sensitivity: z.enum(['normal', 'sensitive', 'confidential']).default('normal'),
	importance: z.coerce.number().int().min(0).max(100).default(50),
	confidence: z.coerce.number().int().min(0).max(100).default(50),
	sourceIds: z.array(z.string()).optional(),
	normalizedFacts: z.record(z.unknown()).optional(),
});

export const UpdateMemorySchema = z.object({
	content: z.string().min(1).optional(),
	category: z.enum(['fact', 'preference', 'event', 'contact', 'decision']).optional(),
	visibility: z.enum(['private', 'shared', 'team']).optional(),
	sensitivity: z.enum(['normal', 'sensitive', 'confidential']).optional(),
	importance: z.coerce.number().int().min(0).max(100).optional(),
	confidence: z.coerce.number().int().min(0).max(100).optional(),
	status: z.enum(['proposed', 'approved', 'rejected', 'archived', 'active', 'corrected']).optional(),
	normalizedFacts: z.record(z.unknown()).optional(),
});

export const MemorySearchSchema = z.object({
	query: z.string().min(1),
	category: z.enum(['fact', 'preference', 'event', 'contact', 'decision']).optional(),
	visibility: z.enum(['private', 'shared', 'team']).optional(),
	limit: z.coerce.number().int().min(1).max(50).default(10),
	offset: z.coerce.number().int().min(0).default(0),
	minConfidence: z.coerce.number().int().min(0).max(100).optional(),
	status: z.enum(['proposed', 'approved', 'rejected', 'archived', 'active', 'corrected']).optional(),
});

export const MemoryListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	category: z.enum(['fact', 'preference', 'event', 'contact', 'decision']).optional(),
	visibility: z.enum(['private', 'shared', 'team']).optional(),
	status: z.enum(['proposed', 'approved', 'rejected', 'archived', 'active', 'corrected']).optional(),
});

// ─── Call log schemas ─────────────────────────────────────────────────────────

export const CreateCallLogSchema = z.object({
	phoneNumber: z.string().min(1).max(20),
	type: z.enum(['incoming', 'outgoing', 'missed']),
	duration: z.coerce.number().int().min(0).optional(),
	timestamp: z.coerce.date().optional(),
	transcript: z.string().optional(),
	recordingUrl: z.string().url().optional().or(z.literal('')),
	summary: z.string().optional(),
	contactName: z.string().max(100).optional(),
});

export const CallLogListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	type: z.enum(['incoming', 'outgoing', 'missed']).optional(),
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
});

export const UpdateCallLogSchema = z.object({
	transcript: z.string().optional(),
	summary: z.string().optional(),
	contactName: z.string().max(100).optional(),
	duration: z.coerce.number().int().min(0).optional(),
});

// ─── Lead schemas ─────────────────────────────────────────────────────────────

export const CreateLeadSchema = z.object({
	name: z.string().min(1).max(255),
	email: z.string().email().optional().or(z.literal('')),
	phone: z.string().min(10).max(20).optional(),
	source: z.string().max(100).optional(),
	status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost']).default('new'),
	notes: z.string().optional(),
	value: z.coerce.number().positive().optional(),
	tags: z.array(z.string().max(50)).optional(),
});

export const UpdateLeadSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	email: z.string().email().optional().or(z.literal('')),
	phone: z.string().min(10).max(20).optional(),
	source: z.string().max(100).optional(),
	status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost']).optional(),
	notes: z.string().optional(),
	value: z.coerce.number().positive().optional(),
	tags: z.array(z.string().max(50)).optional(),
});

export const LeadListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost']).optional(),
	source: z.string().max(100).optional(),
	search: z.string().max(200).optional(),
});

// ─── Notification schemas ─────────────────────────────────────────────────────

export const CreateNotificationSchema = z.object({
	userId: z.string().uuid(),
	title: z.string().min(1).max(255),
	body: z.string().min(1).max(255),
	type: z.enum(['info', 'success', 'warning', 'error', 'system']),
	category: z.string().max(100).optional(),
	actionUrl: z.string().url().optional().nullable(),
	metadata: z.record(z.unknown()).optional().nullable(),
});

export const NotificationListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	unreadOnly: z.coerce.boolean().default(false),
	category: z.string().max(100).optional(),
});

// ─── Task schemas ─────────────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
	title: z.string().min(1).max(500),
	description: z.string().max(10000).optional(),
	priority: z.enum(['low', 'medium', 'high', 'urgent']),
	status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
	dueAt: z.coerce.date().optional(),
	assigneeId: z.string().uuid().optional(),
	tags: z.array(z.string().max(50)).optional(),
});

export const UpdateTaskSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	description: z.string().max(10000).optional(),
	priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
	status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
	dueAt: z.coerce.date().optional(),
	assigneeId: z.string().uuid().optional().nullable(),
	tags: z.array(z.string().max(50)).optional(),
});

export const TaskListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
	priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
	assigneeId: z.string().uuid().optional(),
});

// ─── Reminder schemas ─────────────────────────────────────────────────────────

export const REMINDER_CHANNELS = ['push', 'sms', 'call', 'email'] as const;

export const CreateReminderSchema = z.object({
	title: z.string().min(1).max(500),
	// `triggerAt` is canonical (reminders.trigger_at). `dueAt` is the field name
	// the old inline stub accepted; it is kept as an alias for compatibility.
	triggerAt: z.coerce.date().optional(),
	dueAt: z.coerce.date().optional(),
	timezone: z.string().max(50).default('Asia/Kolkata'),
	repeatRule: z.string().max(1000).optional().nullable(),
	notificationChannel: z.array(z.enum(REMINDER_CHANNELS)).optional(),
	linkedTaskId: z.string().uuid().optional().nullable(),
	linkedContactId: z.string().uuid().optional().nullable(),
	sourceAudit: z.string().max(2000).optional().nullable(),
}).refine((value) => value.triggerAt !== undefined || value.dueAt !== undefined, {
	message: 'triggerAt is required',
	path: ['triggerAt'],
});

export const UpdateReminderSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	triggerAt: z.coerce.date().optional(),
	timezone: z.string().max(50).optional(),
	repeatRule: z.string().max(1000).optional().nullable(),
	notificationChannel: z.array(z.enum(REMINDER_CHANNELS)).optional(),
	linkedTaskId: z.string().uuid().optional().nullable(),
	linkedContactId: z.string().uuid().optional().nullable(),
	sourceAudit: z.string().max(2000).optional().nullable(),
	dismissed: z.boolean().optional(),
});

export const ReminderListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	// Explicit enum rather than z.coerce.boolean(), which turns the string
	// "false" into `true`.
	dismissed: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
});

// ─── Admin / audit schemas ────────────────────────────────────────────────────

export const AdminAuditQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	organizationId: z.string().uuid().optional(),
	action: z.string().max(100).optional(),
	severity: z.string().max(50).optional(),
	resolved: z.coerce.boolean().optional(),
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
});

export const AdminUserQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	organizationId: z.string().uuid().optional(),
	search: z.string().max(200).optional(),
	disabled: z.coerce.boolean().optional(),
});

export const AdminIncidentQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	severity: z.enum(['critical', 'error', 'warning', 'info']).optional(),
	resolved: z.coerce.boolean().optional(),
});

export const AdminFlagQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	key: z.string().max(100).optional(),
	enabled: z.coerce.boolean().optional(),
});

export const AdminUsageQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	organizationId: z.string().uuid().optional(),
	metric: z.string().max(50).optional(),
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
});

// ─── Settings / profile schemas ───────────────────────────────────────────────

export const UpdateProfileSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	avatarUrl: z.string().url().optional().or(z.literal('')),
	locale: z.string().max(10).optional(),
	timezone: z.string().max(50).optional(),
});

export const PersonaSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	personality: z.string().max(50).optional(),
	voiceSpeed: z.coerce.number().int().min(50).max(200).optional(),
	voiceTone: z.string().max(50).optional(),
	languagePolicy: z.enum(['auto', 'en', 'ta', 'tanglish']).optional(),
	wakeWordEnabled: z.boolean().optional(),
});

export const CompanionConfigSchema = z.object({
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

export const PrivacyPrefsSchema = z.object({
	saveConversations: z.boolean().optional(),
	saveRecordings: z.boolean().optional(),
	saveTranscripts: z.boolean().optional(),
	saveMemories: z.boolean().optional(),
	autoDeleteRecordingsDays: z.coerce.number().int().positive().optional(),
	autoDeleteTranscriptsDays: z.coerce.number().int().positive().optional(),
	cloudProcessing: z.boolean().optional(),
	localProcessing: z.boolean().optional(),
});

export const NotificationPrefsSchema = z.object({
	push: z.boolean().optional(),
	email: z.boolean().optional(),
	sms: z.boolean().optional(),
	inApp: z.boolean().optional(),
});

// ─── AI service schemas ───────────────────────────────────────────────────────

export const AISummarizeSchema = z.object({
	text: z.string().min(1),
	maxLength: z.coerce.number().int().positive().optional(),
});

export const AIEmbedSchema = z.object({
	text: z.string().min(1),
});

// ─── Biometric schemas ────────────────────────────────────────────────────────

export const BiometricEnrollSchema = z.object({
	type: z.enum(['fingerprint', 'face', 'voice']),
	publicKey: z.string().min(1),
});

export const BiometricAuthSchema = z.object({
	type: z.enum(['fingerprint', 'face', 'voice']),
	signature: z.string().min(1),
});

// ─── Recording schemas ────────────────────────────────────────────────────────

export const CreateRecordingSchema = z.object({
	title: z.string().min(1).max(500),
	language: z.string().max(50).optional(),
	// The Recording screen sends a flat list of display names; objects are
	// tolerated so a future speaker-labelled payload does not need a new route.
	participants: z.array(z.union([z.string().max(500), z.record(z.unknown())])).optional(),
	// `audio_recordings.storage_key` is NOT NULL with no database default. The
	// route synthesises a placeholder when the upload pipeline has not supplied
	// the real object-store key yet.
	storageKey: z.string().min(1).max(1000).optional(),
	durationSeconds: z.coerce.number().int().min(0).optional(),
	consentRecorded: z.boolean().optional(),
});

export const UpdateRecordingSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	durationSeconds: z.coerce.number().int().min(0).optional(),
	// Free-form rather than an enum: the client's capture pipeline owns the
	// vocabulary (recording | processing | completed | failed) and the column is
	// a varchar(50).
	status: z.string().min(1).max(50).optional(),
	consentRecorded: z.boolean().optional(),
});

export const RecordingListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
});

// ─── Activity centre schemas ──────────────────────────────────────────────────

export const ActivityListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	// Matched case-insensitively as a substring, so the Activity Centre's
	// "Approvals" tab (`action=approval`) catches `tool.approval.requested`.
	action: z.string().min(1).max(100).optional(),
	outcome: z.string().min(1).max(50).optional(),
});

// ─── Tool definition / approval schemas ───────────────────────────────────────

export const ToolApprovalListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	// Absent means "pending only". `all` explicitly disables that default.
	status: z.enum(['pending', 'approved', 'denied', 'expired', 'all']).optional(),
});

export const DecideToolApprovalSchema = z.object({
	decision: z.enum(['approve', 'deny']),
});

// ─── Consent schemas ──────────────────────────────────────────────────────────

export const CreateConsentSchema = z.object({
	purpose: z.string().min(1).max(100),
	granted: z.boolean(),
	// `consent_records.method` is NOT NULL; the route defaults it to 'app'.
	method: z.string().min(1).max(50).optional(),
});
