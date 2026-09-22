/**
 * @nova/tools/builtin/notes — Note taking tool for NOVA.
 *
 * Provides create, read, update, and delete operations for user notes.
 * Notes are in-memory for MVP; production would persist to the database.
 */

import type { NovaToolDefinition, ToolExecutionContext, ToolResult } from '../types.js';
import { z } from 'zod';

// ─── Zod Schemas ───────────────────────────────────────────────────────────────

export const CreateNoteSchema = z.object({
	title: z.string().min(1).max(200),
	content: z.string().min(1).max(200),
	tags: z.array(z.string().max(50)).max(20).optional(),
	category: z.enum(['personal', 'work', 'meeting', 'idea', 'other']).default('personal'),
});

export const UpdateNoteSchema = z.object({
	noteId: z.string().uuid(),
	title: z.string().min(1).max(200).optional(),
	content: z.string().min(1).max(200).optional(),
	tags: z.array(z.string().max(50)).max(20).optional(),
	category: z.enum(['personal', 'work', 'meeting', 'idea', 'other']).optional(),
});

export const DeleteNoteSchema = z.object({
	noteId: z.string().uuid(),
});

export const ListNotesSchema = z.object({
	category: z.enum(['personal', 'work', 'meeting', 'idea', 'other']).optional(),
	tags: z.array(z.string().max(50)).optional(),
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().min(0).default(0),
});

export type CreateNoteInput = z.infer<typeof CreateNoteSchema>;
export type UpdateNoteInput = z.infer<typeof UpdateNoteSchema>;
export type DeleteNoteInput = z.infer<typeof DeleteNoteSchema>;
export type ListNotesInput = z.infer<typeof ListNotesSchema>;

// ─── In-Memory Store ──────────────────────────────────────────────────────────

interface StoredNote {
	readonly id: string;
	readonly userId: string;
	readonly title: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly category: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly _marker?: boolean;
}

const NOTE_STORE = new Map<string, StoredNote>();

function seedNotes(): void {
	const now = new Date().toISOString();
	const notes: StoredNote[] = [
		{
			id: 'note-001',
			userId: 'demo-user',
			title: 'Welcome to NOVA Notes',
			content: 'This is your personal note-taking companion.',
			tags: ['welcome', 'getting-started'],
			category: 'personal',
			createdAt: now,
			updatedAt: now,
		},
	];
	for (const note of notes) {
		NOTE_STORE.set(note.id, note);
	}
}
seedNotes();

// ─── Note Tools ───────────────────────────────────────────────────────────────

export const CREATE_NOTE_TOOL: NovaToolDefinition = {
	id: 'create_note',
	name: 'create_note',
	description: 'Create a new note with title, content, optional tags, and category.',
	version: '1.0.0',
	permissionLevel: 1,
	confirmationRequired: false,
	idempotencyRequired: false,
	inputSchema: {
		type: 'object',
		properties: {
			title: { type: 'string', description: 'Note title (1-200 chars)' },
			content: { type: 'string', description: 'Note body (1-5000 chars)' },
			tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
			category: { type: 'string', description: 'Category: personal, work, meeting, idea, or other' },
		},
		required: ['title', 'content'],
	},
	execute: async (input, _context): Promise<ToolResult> => {
		const parsed = CreateNoteSchema.safeParse(input);
		if (!parsed.success) {
			return {
				success: false,
				error: `Invalid input: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
				errorCode: 'VALIDATION_ERROR',
			};
		}

		const note: StoredNote = {
			id: `note-${Date.now()}`,
			userId: 'demo-user',
			title: parsed.data.title,
			content: parsed.data.content,
			tags: parsed.data.tags ?? [],
			category: parsed.data.category,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		NOTE_STORE.set(note.id, note);

		return {
			success: true,
			data: { note: { ...note, _marker: undefined } },
		};
	},
};

export const UPDATE_NOTE_TOOL: NovaToolDefinition = {
	id: 'update_note',
	name: 'update_note',
	description: 'Update an existing note by id. Only provided fields are changed.',
	version: '1.0.0',
	permissionLevel: 1,
	confirmationRequired: false,
	idempotencyRequired: false,
	inputSchema: {
		type: 'object',
		properties: {
			noteId: { type: 'string', description: 'UUID of the note to update' },
			title: { type: 'string', description: 'New title (1-200 chars)' },
			content: { type: 'string', description: 'New content (1-5000 chars)' },
			tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing)' },
			category: { type: 'string', description: 'New category' },
		},
		required: ['noteId'],
	},
	execute: async (input, context): Promise<ToolResult> => {
		const parsed = UpdateNoteSchema.safeParse(input);
		if (!parsed.success) {
			return {
				success: false,
				error: `Invalid input: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
				errorCode: 'VALIDATION_ERROR',
			};
		}

		const existing = NOTE_STORE.get(parsed.data.noteId);
		if (!existing || existing.userId !== context.userId) {
			return {
				success: false,
				error: 'Note not found or access denied',
				errorCode: 'NOT_FOUND',
			};
		}

		const updated: StoredNote = {
			...existing,
			title: parsed.data.title ?? existing.title,
			content: parsed.data.content ?? existing.content,
			tags: parsed.data.tags ?? existing.tags,
			category: parsed.data.category ?? existing.category,
			updatedAt: new Date().toISOString(),
			_marker: true,
		};

		NOTE_STORE.set(updated.id, updated);

		return {
			success: true,
			data: { note: { ...updated, _marker: undefined } },
		};
	},
};

export const DELETE_NOTE_TOOL: NovaToolDefinition = {
	id: 'delete_note',
	name: 'delete_note',
	description: 'Delete a note permanently by id.',
	version: '1.0.0',
	permissionLevel: 3,
	confirmationRequired: true,
	idempotencyRequired: false,
	inputSchema: {
		type: 'object',
		properties: {
			noteId: { type: 'string', description: 'UUID of the note to delete' },
		},
		required: ['noteId'],
	},
	execute: async (input): Promise<ToolResult> => {
		const parsed = DeleteNoteSchema.safeParse(input);
		if (!parsed.success) {
			return {
				success: false,
				error: `Invalid input: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
				errorCode: 'VALIDATION_ERROR',
			};
		}

		const existing = NOTE_STORE.get(parsed.data.noteId);
		if (!existing) {
			return {
				success: false,
				error: 'Note not found',
				errorCode: 'NOT_FOUND',
			};
		}

		NOTE_STORE.delete(parsed.data.noteId);

		return {
			success: true,
			data: { deleted: true, noteId: parsed.data.noteId },
		};
	},
};

export const LIST_NOTES_TOOL: NovaToolDefinition = {
	id: 'list_notes',
	name: 'list_notes',
	description: 'List notes for the current user, optionally filtered by category or tags.',
	version: '1.0.0',
	permissionLevel: 0,
	confirmationRequired: false,
	idempotencyRequired: true,
	inputSchema: {
		type: 'object',
		properties: {
			category: { type: 'string', description: 'Filter by category' },
			tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
			limit: { type: 'number', description: 'Max results (default 20, max 100)' },
			offset: { type: 'number', description: 'Pagination offset (default 0)' },
		},
		required: [],
	},
	execute: async (input): Promise<ToolResult> => {
		const parsed = ListNotesSchema.safeParse(input);
		if (!parsed.success) {
			return {
				success: false,
				error: `Invalid input: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
				errorCode: 'VALIDATION_ERROR',
			};
		}

		const data = parsed.data;
		let results = [...NOTE_STORE.values()];

		if (data.category) {
			results = results.filter((n) => n.category === data.category);
		}
		if (data.tags?.length) {
			results = results.filter((n) => data.tags!.some((t) => n.tags.includes(t)));
		}

		const start = data.offset ?? 0;
		const end = start + (data.limit ?? 20);
		const paged = results.slice(start, end);

		return {
			success: true,
			data: {
				notes: paged.map((n) => ({ ...n, _marker: undefined })),
				total: results.length,
				limit: data.limit ?? 20,
				offset: data.offset ?? 0,
			},
		};
	},
};

export const NOTE_TOOLS: readonly NovaToolDefinition[] = [
	CREATE_NOTE_TOOL,
	UPDATE_NOTE_TOOL,
	DELETE_NOTE_TOOL,
	LIST_NOTES_TOOL,
];
