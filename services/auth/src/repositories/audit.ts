import { generateId } from '@nova/utils';
import { q } from './db';

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
 created_at: string;
}

export async function logAudit(input: {
 organizationId: string;
 actorUserId?: string;
 action: string;
 resourceType?: string;
 resourceId?: string;
 changes?: Record<string, unknown>;
 ipAddress?: string;
 userAgent?: string;
}): Promise<AuditRow> {
 const id = generateId('aud');
 const { rows } = await q<AuditRow>(
 `INSERT INTO audit_log (id, organization_id, actor_user_id, action, resource_type, resource_id, changes, ip_address, user_agent)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
 RETURNING id, organization_id, actor_user_id, action, resource_type, resource_id, changes, ip_address, user_agent, created_at`,
 [id, input.organizationId, input.actorUserId ?? null, input.action, input.resourceType ?? null, input.resourceId ?? null, input.changes ? JSON.stringify(input.changes) : null, input.ipAddress ?? null, input.userAgent ?? null]
 );
 return rows[0];
}

export async function queryAuditLog(organizationId: string, options: {
 page?: number;
 pageSize?: number;
 actorUserId?: string;
 resourceType?: string;
 action?: string;
 from?: Date;
 to?: Date;
} = {}): Promise<{ rows: AuditRow[]; totalItems: number }> {
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
 `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id, changes, ip_address, user_agent, created_at
 FROM audit_log
 WHERE ${where}
 ORDER BY created_at DESC
 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
 [...params, pageSize, offset]
 );

 return { rows, totalItems: rowCount ?? 0 };
}
