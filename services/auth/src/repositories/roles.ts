import { generateId } from '@nova/utils';
import { q, qOne } from './db';

export interface RoleRow {
 id: string;
 key: string;
 display_name: string;
 description: string;
 is_system: boolean;
}

export async function findRoleByKey(key: string): Promise<RoleRow | null> {
 return qOne<RoleRow>(
 'SELECT id, key, display_name, description, is_system FROM roles WHERE key = $1',
 [key]
 );
}

export async function getAllRoles(): Promise<RoleRow[]> {
 const { rows } = await q<RoleRow>(
 'SELECT id, key, display_name, description, is_system FROM roles ORDER BY key'
 );
 return rows;
}

export async function assignRoleToUser(
 userId: string,
 workspaceId: string,
 roleId: string,
 grantedBy: string
): Promise<{ id: string }> {
 const bindingId = crypto.randomUUID();
 const { rows } = await q<{ id: string }>(
 `INSERT INTO role_bindings (id, user_id, workspace_id, role_id, granted_by)
 VALUES ($1, $2, $3, $4, $5)
 RETURNING id`,
 [bindingId, userId, workspaceId, roleId, grantedBy]
 );
 return rows[0];
}

export async function findRoleBinding(
 userId: string,
 workspaceId: string
): Promise<{ id: string; role: RoleRow } | null> {
 return qOne<{ id: string; role: RoleRow }>(
 `SELECT rb.id, r.id as "role.id", r.key as "role.key", r.display_name as "role.display_name",
 r.description as "role.description", r.is_system as "role.is_system"
 FROM role_bindings rb
 JOIN roles r ON r.id = rb.role_id
 WHERE rb.user_id = $1 AND rb.workspace_id = $2 AND rb.deleted_at IS NULL`,
 [userId, workspaceId]
 );
}
