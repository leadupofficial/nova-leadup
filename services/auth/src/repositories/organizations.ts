import { generateId } from '@nova/utils';
import { q, qOne } from './db';

export interface OrganizationRow {
 id: string;
 name: string;
 slug: string;
 plan: string;
 created_at: string;
 updated_at: string;
}

export interface NewOrganizationInput {
 name: string;
 slug: string;
 plan?: string;
}

export async function createOrganization(input: NewOrganizationInput): Promise<OrganizationRow> {
 const id = generateId('org');
 const { rows } = await q<OrganizationRow>(
 `INSERT INTO organizations (id, name, slug, plan) VALUES ($1, $2, $3, $4)
 RETURNING id, name, slug, plan, created_at, updated_at`,
 [id, input.name, input.slug, input.plan ?? 'free']
 );
 return rows[0];
}

export async function findOrganizationBySlug(slug: string): Promise<OrganizationRow | null> {
 return qOne<OrganizationRow>(
 'SELECT id, name, slug, plan, created_at, updated_at FROM organizations WHERE slug = $1 AND deleted_at IS NULL',
 [slug]
 );
}

export async function findOrganizationById(id: string): Promise<OrganizationRow | null> {
 return qOne<OrganizationRow>(
 'SELECT id, name, slug, plan, created_at, updated_at FROM organizations WHERE id = $1 AND deleted_at IS NULL',
 [id]
 );
}

export async function updateOrganization(
 id: string,
 patch: Partial<Pick<OrganizationRow, 'name' | 'plan'>>
): Promise<OrganizationRow | null> {
 const sets: string[] = [];
 const values: unknown[] = [];
 let idx = 1;

 if (patch.name !== undefined) {
 sets.push(`name = $${idx++}`);
 values.push(patch.name);
 }
 if (patch.plan !== undefined) {
 sets.push(`plan = $${idx++}`);
 values.push(patch.plan);
 }
 sets.push(`updated_at = now()`);
 values.push(id);

 return qOne<OrganizationRow>(
 `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, plan, created_at, updated_at`,
 values
 );
}

export async function softDeleteOrganization(id: string): Promise<boolean> {
 const { rows } = await q(
 'UPDATE organizations SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
 [id]
 );
 return (rows as unknown[]).length > 0;
}
