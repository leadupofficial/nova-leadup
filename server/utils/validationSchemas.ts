/**
 * Validation schemas used by user routes and other server routes.
 */

import { z } from 'zod';

export const paginationSchema = z.object({
 page: z.coerce.number().int().positive().default(1),
 pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const createUserSchema = z.object({
 email: z.string().email(),
 password: z.string().min(8),
 name: z.string().min(1),
 role: z.enum(['admin', 'user', 'moderator']).optional(),
});

export const updateUserSchema = z.object({
 email: z.string().email().optional(),
 name: z.string().min(1).optional(),
 role: z.enum(['admin', 'user', 'moderator']).optional(),
});

export const updateUserStatusSchema = z.object({
 active: z.boolean(),
});
