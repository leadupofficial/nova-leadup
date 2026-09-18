/**
 * NOVA API — Tool definitions and the human confirmation queue.
 *
 * `tool_definitions` is platform configuration (not user-owned), so the
 * catalogue is returned to any authenticated caller but limited to enabled
 * tools and to the fields a client needs. `tool_approvals` *is* user-owned and
 * every statement is scoped to `req.user!.id`; another user's approval is a
 * 404, never a 403.
 *
 * The blueprint requires a side-effecting tool to be confirmed by the user
 * before it runs (§5.7), so deciding an approval is the only mutation here and
 * an already-decided approval is rejected with 409.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { toolDefinitions, toolApprovals } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	ToolApprovalListQuerySchema,
	DecideToolApprovalSchema,
	parseCursorPagination,
	decodeCursor,
	encodeCursor,
} from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

const IdSchema = z.object({ id: z.string().uuid() });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseId(raw: string): string {
	const parsed = IdSchema.safeParse({ id: raw });
	if (!parsed.success) {
		throw new HttpError(400, 'Invalid approval ID format', 'INVALID_ID');
	}
	return parsed.data.id;
}

function parseCursor(raw: string): string {
	let id: string;
	try {
		id = decodeCursor(raw);
	} catch {
		throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
	}
	if (!UUID_RE.test(id)) {
		throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
	}
	return id;
}

/**
 * Approval columns plus the resolved tool name. Clients render "which tool is
 * asking" from the same payload, so the join is part of the shape rather than a
 * second round trip.
 */
const approvalSelection = {
	id: toolApprovals.id,
	userId: toolApprovals.userId,
	tenantId: toolApprovals.tenantId,
	toolId: toolApprovals.toolId,
	toolInput: toolApprovals.toolInput,
	permissionLevel: toolApprovals.permissionLevel,
	status: toolApprovals.status,
	expiresAt: toolApprovals.expiresAt,
	decidedAt: toolApprovals.decidedAt,
	createdAt: toolApprovals.createdAt,
	toolName: toolDefinitions.name,
};

// ─── /tools ──────────────────────────────────────────────────────────────────

router.get('/', authenticate, async (_req: AuthenticatedRequest, res, next) => {
	try {
		const db = getDb();

		const tools = await db.select({
			id: toolDefinitions.id,
			name: toolDefinitions.name,
			version: toolDefinitions.version,
			description: toolDefinitions.description,
			permissionLevel: toolDefinitions.permissionLevel,
			confirmationRequired: toolDefinitions.confirmationRequired,
		})
			.from(toolDefinitions)
			.where(eq(toolDefinitions.enabled, true))
			.orderBy(asc(toolDefinitions.name));

		res.status(200).json({ success: true, data: { tools } });
	} catch (err) { next(err); }
});

// ─── /tools/approvals ────────────────────────────────────────────────────────

router.get('/approvals', authenticate, validate(ToolApprovalListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const validatedQuery = (req as unknown as { validatedQuery?: z.infer<typeof ToolApprovalListQuerySchema> }).validatedQuery;
		const q = validatedQuery ?? (parseCursorPagination(req) as z.infer<typeof ToolApprovalListQuerySchema>);
		const db = getDb();
		const userId = req.user!.id;

		// Pending by default — that is the Tool Confirmation queue. `all`
		// explicitly asks for every status.
		const statusFilter = q.status ?? 'pending';
		const whereClauses = [eq(toolApprovals.userId, userId)];
		if (statusFilter !== 'all') whereClauses.push(eq(toolApprovals.status, statusFilter));

		if (q.cursor) {
			const decoded = parseCursor(q.cursor);
			whereClauses.push(q.direction === 'backward'
				? lt(toolApprovals.id, decoded)
				: gt(toolApprovals.id, decoded));
		}

		const where = and(...whereClauses);

		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(toolApprovals)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		const orderBy = q.direction === 'backward' ? asc(toolApprovals.createdAt) : desc(toolApprovals.createdAt);
		const rows = await db.select(approvalSelection)
			.from(toolApprovals)
			.leftJoin(toolDefinitions, eq(toolApprovals.toolId, toolDefinitions.id))
			.where(where)
			.orderBy(orderBy)
			.limit(q.limit + 1); // +1 to detect hasMore

		const hasMore = rows.length > q.limit;
		const pageData = hasMore ? rows.slice(0, q.limit) : rows;
		const lastId = pageData[pageData.length - 1]?.id;
		const firstId = pageData[0]?.id;

		res.status(200).json({
			success: true,
			data: {
				approvals: pageData,
				pagination: {
					nextCursor: hasMore ? encodeCursor(lastId) : null,
					prevCursor: firstId ? encodeCursor(firstId) : null,
					hasMore,
					limit: q.limit,
					total,
				},
			},
		});
	} catch (err) { next(err); }
});

router.post('/approvals/:id/decide', authenticate, validate(DecideToolApprovalSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const body = (req as any).validatedBody as z.infer<typeof DecideToolApprovalSchema>;
		const db = getDb();
		const userId = req.user!.id;

		// Distinguish "not mine / missing" (404) from "already decided" (409)
		// before attempting the write.
		const [existing] = await db.select({ id: toolApprovals.id, status: toolApprovals.status })
			.from(toolApprovals)
			.where(and(eq(toolApprovals.id, id), eq(toolApprovals.userId, userId)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Approval not found', 'NOT_FOUND');
		}
		if (existing.status !== 'pending') {
			throw new HttpError(409, `Approval already ${existing.status}`, 'ALREADY_DECIDED');
		}

		const decidedStatus = body.decision === 'approve' ? 'approved' : 'denied';

		// The status predicate is repeated in the UPDATE so two concurrent
		// decisions cannot both win — the loser updates zero rows and gets 409.
		const [updated] = await db.update(toolApprovals)
			.set({ status: decidedStatus, decidedAt: new Date() })
			.where(and(
				eq(toolApprovals.id, id),
				eq(toolApprovals.userId, userId),
				eq(toolApprovals.status, 'pending'),
			))
			.returning({ id: toolApprovals.id });
		if (!updated) {
			throw new HttpError(409, 'Approval has already been decided', 'ALREADY_DECIDED');
		}

		const [approval] = await db.select(approvalSelection)
			.from(toolApprovals)
			.leftJoin(toolDefinitions, eq(toolApprovals.toolId, toolDefinitions.id))
			.where(eq(toolApprovals.id, id))
			.limit(1);

		logger.info({ approvalId: id, userId, decision: body.decision }, 'Tool approval decided');
		res.status(200).json({ success: true, data: approval });
	} catch (err) { next(err); }
});

export { router as toolsRoutes };
