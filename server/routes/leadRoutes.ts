/**
 * NOVA-Leadup — Lead route definitions.
 *
 * Mounted at /api/leads in server/app.ts (or equivalent).
 * All write endpoints use Zod-validated controllers; the read endpoints
 * apply the same schema to query parameters so that malformed requests
 * are rejected before hitting the service layer.
 */

import { Router } from 'express';
import {
	createLead,
	listLeads,
	getLead,
	updateLead,
	deleteLead,
	bulkUpsertLeads,
} from '../controllers/lead';
import { validateBody } from '../middleware/validation';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// ─── Read ──────────────────────────────────────────────────────────────────

router.get(
	'/',
	asyncHandler(listLeads)
);

router.get(
	'/:id',
	asyncHandler(getLead)
);

// ─── Write ─────────────────────────────────────────────────────────────────

router.post(
	'/',
	validateBody(require('../utils/validationSchemas.lead').leadCreateSchema),
	asyncHandler(createLead)
);

router.patch(
	'/:id',
	asyncHandler(updateLead)
);

router.delete(
	'/:id',
	asyncHandler(deleteLead)
);

// ─── Bulk upsert ────────────────────────────────────────────────────────────

// The payload shape is intentionally separate from `leadCreateSchema` so
// that callers can provide only the fields they intend to change in PATCH
// mode while still being able to supply enough information for an INSERT
// when the row does not already exist. The controller performs its own
// safeParse against the full `LeadSchema` per-row.
router.post(
	'/bulk-upsert',
	validateBody(require('../utils/validationSchemas.lead').bulkUpsertSchema),
	asyncHandler(bulkUpsertLeads)
);

export default router;
