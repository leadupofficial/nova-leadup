import { Router } from 'express';
import { z } from 'zod';
import { authenticateJwt, errorHandler } from '../middleware.js';

export const incidentsRouter = Router();

const CreateIncidentSchema = z.object({
 severity: z.enum(['info', 'warning', 'error', 'critical']),
 category: z.string().min(1).max(50),
 title: z.string().min(1).max(255),
 description: z.string().optional(),
 source: z.string().max(100).optional(),
});

const UpdateIncidentSchema = z.object({
 status: z.enum(['open', 'acknowledged', 'resolved', 'closed']).optional(),
 severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
});

// GET /
incidentsRouter.get('/', authenticateJwt, async (req, res, next) => {
 try {
 const page = Number(req.query.page ?? 1);
 const limit = Number(req.query.limit ?? 20);
 const offset = (page - 1) * limit;

 // Stub: replace with real DB query
 const data: unknown[] = [];
 const total = 0;

 res.json({
 data,
 page,
 limit,
 total,
 totalPages: Math.ceil(total / limit) || 1,
 });
 } catch (err) {
 next(err);
 }
});

// POST / - create incident
incidentsRouter.post('/', authenticateJwt, async (req, res, next) => {
 try {
 const parsed = CreateIncidentSchema.safeParse(req.body);
 if (!parsed.success) {
 return res.status(400).json({ error: 'Validation error', details: parsed.error.message });
 }

 // Stub: replace with real DB insert
 const incident = { id: crypto.randomUUID(), ...parsed.data };

 res.status(201).json(incident);
 } catch (err) {
 next(err);
 }
});

// PATCH /:id - update status/severity
incidentsRouter.patch('/:id', authenticateJwt, async (req, res, next) => {
 try {
 const parsed = UpdateIncidentSchema.safeParse(req.body);
 if (!parsed.success) {
 return res.status(400).json({ error: 'Validation error', details: parsed.error.message });
 }

 // Stub: replace with real DB update
 const updated = { id: req.params.id, ...parsed.data };

 res.json(updated);
 } catch (err) {
 next(err);
 }
});
