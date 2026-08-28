/**
 * Audit log repository — queries against audit_log with full filtering.
 */
import { q, qOne } from '../db';

export interface AuditRow {
 id: string;
 organization_id: string;
 actor_user_id: string | null;
 action: string;
 resource_type: string | null;
 resource_id: string | null;
 changes: Record<string, unknown> | null;
 ip_address: string | null;
 user_agent: string | null;
 request_id: string | null;
 tool_name: string | null;
 tool_input: Record<string, unknown> | null;
 tool_output: Record<string, unknown> | null;
 decision: string | null;
 correlation_id: string | null;
 created_at: string;
}

export interface AuditQueryOptions {
 page?: number;
 pageSize?: number;
 actorUserId?: string;
 resourceType?: string;
 action?: string;
 toolName?: string;
 decision?: string;
 from?: Date;
 to?: Date;
}

export async function queryAuditLog(organizationId: string, options: AuditQueryOptions = {}): Promise<{ rows: AuditRow[]; totalItems: number }> {
 const page = options.page ?? 1;
 const pageSize = options.pageSize ?? 20;
 const offset = (page - 1) * pageSize;

 const whereClauses: string[] = ['organization_id = $1'];
 const params: unknown[] = [organizationId];
 let paramIdx = 2;

 if (options.actorUserId) {
 whereClauses.push(`actor_user_id = $${paramIdx++}`);
 params.push(options.actorUserId);
 }
 if (options.resourceType) {
 whereClauses.push(`resource_type = $${paramIdx++}`);
 params.push(options.resourceType);
 }
 if (options.action) {
 whereClauses.push(`action = $${paramIdx++}`);
 params.push(options.action);
 }
 if (options.toolName) {
 whereClauses.push(`tool_name = $${paramIdx++}`);
 params.push(options.toolName);
 }
 if (options.decision) {
 whereClauses.push(`decision = $${paramIdx++}`);
 params.push(options.decision);
 }
 if (options.from) {
 whereClauses.push(`created_at >= $${paramIdx++}`);
 params.push(options.from.toISOString());
 }
 if (options.to) {
 whereClauses.push(`created_at <= $${paramIdx++}`);
 params.push(options.to.toISOString());
 }

 const where = whereClauses.join(' AND ');
 const { rows, rowCount } = await q<AuditRow>(
 `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id,
 changes, ip_address, user_agent, request_id, tool_name, tool_input, tool_output,
 decision, correlation_id, created_at
 FROM audit_log
 WHERE ${where}
 ORDER BY created_at DESC
 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
 [...params, pageSize, offset]
 );

 return { rows, totalItems: rowCount ?? 0 };
}

export async function getAuditEventById(id: string): Promise<AuditRow | null> {
 return qOne<AuditRow>(
 `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id,
 changes, ip_address, user_agent, request_id, tool_name, tool_input, tool_output,
 decision, correlation_id, created_at
 FROM audit_log WHERE id = $1`,
 [id]
 );
}

export async function getAuditStats(organizationId: string, from?: Date, to?: Date): Promise<{
 totalEvents: number;
 actionCounts: Record<string, number>;
 toolCounts: Record<string, number>;
 decisions: Record<string, number>;
 }> {
 const whereClauses: string[] = ['organization_id = $1'];
 const params: unknown[] = [organizationId];
 let paramIdx = 2;

 if (from) {
 whereClauses.push(`created_at >= $${paramIdx++}`);
 params.push(from.toISOString());
 }
 if (to) {
 whereClauses.push(`created_at <= $${paramIdx++}`);
 params.push(to.toISOString());
 }
 const where = whereClauses.join(' AND ');

 const { rowCount: totalCount } = await q(`SELECT COUNT(*) FROM audit_log WHERE ${where}`, params);
 const total = totalCount ?? 0;

 const { rows: actionRows } = await q(
 `SELECT action, COUNT(*) as cnt FROM audit_log WHERE ${where} GROUP BY action ORDER BY cnt DESC LIMIT 20`,
 params
 );
 const actionCounts: Record<string, number> = {};
 for (const r of actionRows) actionCounts[r.action] = r.cnt;

 const { rows: toolRows } = await q(
 `SELECT tool_name, COUNT(*) as cnt FROM audit_log WHERE ${where} AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY cnt DESC LIMIT 20`,
 params
 );
 const toolCounts: Record<string, number> = {};
 for (const r of toolRows) toolCounts[r.tool_name] = r.cnt;

 const { rows: decisionRows } = await q(
 `SELECT decision, COUNT(*) as cnt FROM audit_log WHERE ${where} GROUP BY decision ORDER BY cnt DESC`,
 params
 );
 const decisions: Record<string, number> = {};
 for (const r of decisionRows) decisions[r.decision] = r.cnt;

 return { totalEvents: total, actionCounts, toolCounts, decisions };
}
