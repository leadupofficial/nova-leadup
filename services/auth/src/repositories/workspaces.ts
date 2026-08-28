import { generateId } from '@nova/utils';
import { q, qOne } from './db';

export interface WorkspaceRow {
 id: string;
 organization_id: string;
 name: string;
 created_at: string;
 updated_at: string;
}

export async function createWorkspace(organizationId: string, name: string): Promise<WorkspaceRow> {
 const id = generateId('ws');
 const { rows } = await q<WorkspaceRow>(
 `INSERT INTO workspaces (id, organization_id, name) VALUES ($1, $2, $3)
 RETURNING id, organization_id, name, created_at, updated_at`,
 [id, organizationId, name]
 );
 return rows[0];
}

export async function findWorkspaceById(id: string): Promise<WorkspaceRow | null> {
 return qOne<WorkspaceRow>(
 'SELECT id, organization_id, name, created_at, updated_at FROM workspaces WHERE id = $1 AND deleted_at IS NULL',
 [id]
 );
}

export async function findWorkspacesByOrg(orgId: string): Promise<WorkspaceRow[]> {
 const { rows } = await q<WorkspaceRow>(
 'SELECT id, organization_id, name, created_at, updated_at FROM workspaces WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY name',
 [orgId]
 );
 return rows;
}

export async function softDeleteWorkspace(id: string): Promise<boolean> {
 const { rows } = await q(
 'UPDATE workspaces SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
 [id]
 );
 return (rows as unknown[]).length > 0;
}
