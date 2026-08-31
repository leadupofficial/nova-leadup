/**
 * @nova/tools — Tool input/output validation utilities.
 *
 * Per blueprint Section 10: "JSON-schema validation; every model-produced tool
 * input is schema-validated".
 *
 * Uses Zod for runtime schema validation with clear error messages.
 */

import { z } from 'zod';

// ─── Common field validators ──────────────────────────────────────────────────

export const NonEmptyString = z.string().min(1).max(500);
export const IsoDateString = z.string().refine((s) => !isNaN(Date.parse(s)), {
	message: 'Must be a valid ISO 8601 date string',
});
export const PositiveNumber = z.number().positive();
export const ConfidenceScore = z.number().int().min(0).max(100);

// ─── Tool-specific schemas ────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
	title: NonEmptyString,
	description: z.string().max(500).optional(),
	dueAt: IsoDateString.optional(),
	tags: z.array(z.string()).max(10).optional(),
	source: z.string().optional(),
	aiConfidence: ConfidenceScore.optional(),
});

export const SetReminderSchema = z.object({
	title: NonEmptyString,
	triggerAt: IsoDateString,
	timezone: z.string().default('Asia/Kolkata'),
	repeatRule: z.string().optional(),
	linkedTaskId: z.string().uuid().optional(),
});

export const SearchMemorySchema = z.object({
	query: NonEmptyString,
	category: z.enum(['fact', 'preference', 'event', 'contact', 'decision']).optional(),
	limit: z.number().int().min(1).max(50).default(10),
});

export const UpdateMemorySchema = z.object({
	content: NonEmptyString,
	category: z.enum(['fact', 'preference', 'event', 'contact', 'decision']),
	visibility: z.enum(['private', 'shared']).default('private'),
	confidence: ConfidenceScore.default(50),
});

export const TranslateSchema = z.object({
	text: NonEmptyString,
	sourceLanguage: z.string().default('auto'),
	targetLanguage: z.enum(['en', 'ta']),
});

export const RecordMeetingSchema = z.object({
	action: z.enum(['start', 'stop']),
	title: NonEmptyString,
	participants: z.array(z.string()).optional(),
	language: z.string().default('auto'),
});

// ─── Validation types ─────────────────────────────────────────────────────────

export interface ValidationResult<T> {
	readonly valid: boolean;
	readonly data?: T;
	readonly errors: readonly string[];
}

export type ToolValidationResult = ValidationResult<Record<string, unknown>>;

// ─── Validator registry ───────────────────────────────────────────────────────

const VALIDATORS: Record<string, z.ZodSchema> = {
	create_task: CreateTaskSchema,
	set_reminder: SetReminderSchema,
	search_memory: SearchMemorySchema,
	update_memory: UpdateMemorySchema,
	translate: TranslateSchema,
	record_meeting: RecordMeetingSchema,
};

/**
 * Validate tool input against its Zod schema.
 */
export function validateToolInput(toolName: string, input: unknown): ToolValidationResult {
	const schema = VALIDATORS[toolName];
	if (!schema) {
		return { valid: true, data: input as Record<string, unknown>, errors: [] };
	}

	const result = schema.safeParse(input);
	if (result.success) {
		return { valid: true, data: result.data as Record<string, unknown>, errors: [] };
	}

	return {
		valid: false,
		errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
	};
}

/**
 * Validate and throw on error. Useful in server-side execution paths.
 */
export function validateOrThrow<T>(toolName: string, input: unknown): T {
	const result = validateToolInput(toolName, input);
	if (!result.valid) {
		throw new Error(`Tool "${toolName}" validation failed: ${result.errors.join(', ')}`);
	}
	return result.data as T;
}
