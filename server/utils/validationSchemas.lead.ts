/**
 * Validation schemas for lead endpoints
 */

import { z } from 'zod';
import { LeadStatus } from '../types/lead';

/**
 * Body accepted by POST /api/leads.
 */
export const leadCreateSchema = z.object({
 firstName: z.string().min(1, 'First name is required').max(100),
 lastName: z.string().min(1, 'Last name is required').max(100),
 email: z.string().email('Invalid email address'),
 phone: z.string().max(20).optional().nullable(),
 company: z.string().max(200).optional().nullable(),
 source: z.string().max(100).optional().default('unknown'),
 status: z.nativeEnum(LeadStatus).optional().default(LeadStatus.NEW),
 score: z.number().int().min(0).max(100).optional().nullable(),
 notes: z.string().max.optional().nullable(),
 metadata: z.record(z.unknown()).optional().nullable(),
});

export const updateLeadSchema = leadCreateSchema.partial();

/**
 * Query parameters accepted by GET /api/leads.
 */
export const leadSearchSchema = z.object({
 query: z.string().max(200).optional(),
 status: z.nativeEnum(LeadStatus).optional(),
 source: z.string().max(100).optional(),
 company: z.string().max(200).optional(),
 minScore: z.coerce.number().int().min(0).max(100).optional(),
 maxScore: z.coerce.number().int().min(0).max(100).optional(),
 createdAfter: z.string().datetime().optional(),
 createdBefore: z.string().datetime().optional(),
 limit: z.coerce.number().int().positive().max(100).default(20),
 offset: z.coerce.number().int().nonnegative().default(0),
});

/**
 * Body accepted by POST /api/leads/bulk-upsert.
 */
export const bulkUpsertSchema = z.object({
 leads: z.array(z.object({
 id: z.string().uuid().optional(),
 email: z.string().email().optional(),
 phone: z.string().max(30).optional().nullable(),
 firstName: z.string().max(100).optional(),
 lastName: z.string().max(100).optional().nullable(),
 company: z.string().max(200).optional().nullable(),
 source: z.string().max(100).optional().nullable(),
 status: z.nativeEnum(LeadStatus).optional(),
 notes: z.string().optional().nullable(),
 metadata: z.record(z.unknown()).optional(),
 })).min(1, 'leads array must not be empty').max(500, 'Maximum 500 leads per batch'),
});
