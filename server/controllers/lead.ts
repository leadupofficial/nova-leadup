/**
 * NOVA-Leadup — Lead controller with Zod validation + duplicate detection.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
	checkDuplicate,
	normalizeEmail,
	normalizePhone,
	insertLead,
	findLeadById,
	findLeadByEmail,
	findLeadByPhone,
	listAllLeads,
	updateLeadById,
	deleteLeadById,
} from '../services/lead';
import { logger } from '../utils/logger';

// ─── Zod schema for lead creation ──────────────────────────────────────

const LeadSchema = z.object({
	email: z
		.string()
		.min(1, 'Email is required')
		.email('Invalid email format'),
	firstName: z
		.string()
		.min(1, 'First name is required')
		.max(100, 'First name must be ≤ 100 characters')
		.regex(/^[\p{L}\p{M} '.-]+$/u, 'First name contains invalid characters'),
	lastName: z
		.string()
		.max(100, 'Last name must be ≤ 100 characters')
		.regex(/^[\p{L}\p{M} '.-]*$/u, 'Last name contains invalid characters')
		.optional(),
	phone: z
		.string()
		.max(30, 'Phone must be ≤ 30 characters')
		.regex(/^[+]?[\d\s()-]+$/, 'Phone contains invalid characters')
		.optional()
		.nullable(),
	company: z
		.string()
		.max(200, 'Company must be ≤ 200 characters')
		.optional()
		.nullable(),
	source: z
		.string()
		.max(100, 'Source must be ≤ 100 characters')
		.optional()
		.nullable(),
	status: z
		.enum(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'])
		.default('new'),
	notes: z
		.string()
		.max(5000, 'Notes must be ≤ 5000 characters')
		.optional()
		.nullable(),
	metadata: z
		.record(z.string(), z.unknown())
		.optional()
		.default({}),
});

type LeadInput = z.infer<typeof LeadSchema>;

// ─── POST /api/leads — create lead with validation + duplicate detection ─

export async function createLead(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		// 1. Zod validation
		const parsed = LeadSchema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({
				success: false,
				error: 'Validation failed',
				details: parsed.error.issues.map((issue) => ({
					field: issue.path.join('.'),
					message: issue.message,
				})),
			});
			return;
		}
		const input: LeadInput = parsed.data;

		// 2. Duplicate detection (exact + fuzzy)
		const duplicate = await checkDuplicate({
			email: input.email,
			phone: input.phone ?? null,
			firstName: input.firstName,
			lastName: input.lastName,
		});

		if (duplicate.existingLeadId && duplicate.similarityScore >= 0.95) {
			logger.warn(
				{ existingLeadId: duplicate.existingLeadId, similarity: duplicate.similarityScore },
				'Duplicate lead detected — rejecting creation'
			);
			res.status(409).json({
				success: false,
				error: 'Duplicate lead detected',
				existingLeadId: duplicate.existingLeadId,
				matchType: duplicate.emailMatch ? 'email' : duplicate.phoneMatch ? 'phone' : 'fuzzy',
				similarityScore: duplicate.similarityScore,
			});
			return;
		}

		// 3. Persist via service layer (keeps store + duplicate check in sync)
		const record = await insertLead({
			email: input.email,
			firstName: input.firstName,
			lastName: input.lastName,
			phone: input.phone ?? null,
			company: input.company,
			source: input.source,
			status: input.status,
			notes: input.notes,
			metadata: input.metadata,
		});

		logger.info({ leadId: record.id, email: record.email }, 'Lead created');

		res.status(201).json({
			success: true,
			data: record,
			meta: {
				duplicateCheck: {
					wasNearDuplicate: duplicate.similarityScore > 0.7 && !duplicate.existingLeadId,
					similarityScore: duplicate.similarityScore,
				},
			},
		});
	} catch (err) {
		next(err);
	}
}

// ─── GET /api/leads — list leads with normalized filters ───────────────

export async function listLeads(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		const schema = z.object({
			status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost']).optional(),
			source: z.string().optional(),
			search: z.string().max(200).optional(),
			page: z.coerce.number().int().positive().default(1),
			limit: z.coerce.number().int().min(1).max(100).default(20),
		});

		const query = schema.parse(req.query);

		const results = await listAllLeads();

		if (query.status) {
			results = results.filter((l) => l.status === query.status);
		}
		if (query.source) {
			results = results.filter((l) => l.source === query.source);
		}
		if (query.search) {
			const term = query.search.toLowerCase();
			results = results.filter(
				(l) =>
					l.firstName.toLowerCase().includes(term) ||
					l.lastName?.toLowerCase().includes(term) ||
					l.email.toLowerCase().includes(term)
			);
		}

		const total = results.length;
		const offset = (query.page - 1) * query.limit;
		const paginated = results.slice(offset, offset + query.limit);

		res.json({
			success: true,
			data: paginated,
			meta: { total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) },
		});
	} catch (err) {
		next(err);
	}
}

// ─── GET /api/leads/:id — get single lead ──────────────────────────────

export async function getLead(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		const idSchema = z.object({ id: z.string().uuid() });
		const { id } = idSchema.parse(req.params);

		const lead = findLeadById(id);
		if (!lead) {
			res.status(404).json({ success: false, error: 'Lead not found' });
			return;
		}

		res.json({ success: true, data: lead });
	} catch (err) {
		next(err);
	}
}

// ─── PATCH /api/leads/:id — update lead ────────────────────────────────

const LeadUpdateSchema = LeadSchema.partial();

export async function updateLead(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		const idSchema = z.object({ id: z.string().uuid() });
		const { id } = idSchema.parse(req.params);

		const parsed = LeadUpdateSchema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({
				success: false,
				error: 'Validation failed',
				details: parsed.error.issues.map((issue) => ({
					field: issue.path.join('.'),
					message: issue.message,
				})),
			});
			return;
		}

		const updated = await updateLeadById(id, parsed.data);
		if (!updated) {
			res.status(404).json({ success: false, error: 'Lead not found' });
			return;
		}

		res.json({ success: true, data: updated });
	} catch (err) {
		next(err);
	}
}

// ─── DELETE /api/leads/:id ─────────────────────────────────────────────

export async function deleteLead(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		const idSchema = z.object({ id: z.string().uuid() });
		const { id } = idSchema.parse(req.params);

		const removed = await deleteLeadById(id);
		if (!removed) {
			res.status(404).json({ success: false, error: 'Lead not found' });
			return;
		}

		res.status(204).end();
	} catch (err) {
		next(err);
	}
}

// ─── POST /api/leads/bulk-upsert — idempotent bulk create/update ───────────
// Strategy: "find-or-create". Each row is matched by existing id (if supplied)
// or by exact email / normalized phone. If found → PATCH. If not → POST.
// The operation is atomic per-row — a failure in one entry does not block
// processing of the remaining entries; each result carries its own status.

const BulkUpsertItemSchema = z.object({
	id: z.string().uuid().optional(),
	email: z.string().email().optional(),
	phone: z.string().max(30).optional().nullable(),
	// allow any additional fields so partial rows are accepted at the
	// boundary; the inner LeadSchema will still validate on PATCH/POST.
});

const BulkUpsertSchema = z.object({
	leads: z.array(BulkUpsertItemSchema).min(1, 'leads array must not be empty').max(500, 'Maximum 500 leads per batch'),
});

export async function bulkUpsertLeads(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		const { leads: incoming } = BulkUpsertSchema.parse(req.body);

		const results: Array<{ index: number; status: 'created' | 'updated' | 'skipped'; leadId?: string; error?: string }> = [];

		for (let i = 0; i < incoming.length; i++) {
			const row = incoming[i];

			try {
				// 1. Locate an existing lead.
				let existing = findLeadById(row.id ?? '');
				if (!existing && row.email) {
					existing = await findLeadByEmail(normalizeEmail(row.email));
				}
				if (!existing && row.phone) {
					existing = await findLeadByPhone(normalizePhone(row.phone));
				}

				if (existing) {
					// PATCH the matched row.
					const partial = LeadSchema.partial().safeParse(row);
					if (!partial.success) {
						results.push({ index: i, status: 'skipped', error: 'Validation failed' });
						continue;
					}
					const updated = await updateLeadById(existing.id, partial.data);
					results.push({ index: i, status: 'updated', leadId: updated.id });
				} else {
					// POST a brand-new row.
					const full = LeadSchema.safeParse(row);
					if (!full.success) {
						results.push({ index: i, status: 'skipped', error: 'Validation failed' });
						continue;
					}
					const created = await insertLead(full.data);
					results.push({ index: i, status: 'created', leadId: created.id });
				}
			} catch (rowErr) {
				results.push({ index: i, status: 'skipped', error: rowErr instanceof Error ? rowErr.message : 'Unknown error' });
			}
		}

		res.status(207).json({ success: true, data: results });
	} catch (err) {
		next(err);
	}
}
