import { generateId } from '@nova/utils';
import { generateApiKey } from '../crypto';
import { q, qOne } from './db';

export interface ApiKeyRow {
 id: string;
 organization_id: string;
 created_by: string;
 name: string;
 key_prefix: string;
 scopes: string[];
 expires_at: string | null;
 last_used_at: string | null;
 created_at: string;
}

export interface NewApiKeyResult {
 key: ApiKeyRow;
 rawKey: string;
}

export async function createApiKey(
 organizationId: string,
 createdBy: string,
 input: { name: string; scopes: string[]; expiresAt?: Date }
): Promise<NewApiKeyResult> {
 const id = generateId('key');
 const { prefix, key, hash } = generateApiKey();

 const { rows } = await q<ApiKeyRow>(
 `INSERT INTO api_keys (id, organization_id, created_by, name, key_prefix, key_hash, scopes, expires_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 RETURNING id, organization_id, created_by, name, key_prefix, scopes, expires_at, last_used_at, created_at`,
 [id, organizationId, createdBy, input.name, prefix, hash, input.scopes, input.expiresAt?.toISOString() ?? null]
 );

 return { key: rows[0], rawKey: key };
}

export async function findApiKeyByHash(hash: string): Promise<ApiKeyRow | null> {
 return qOne<ApiKeyRow>(
 'SELECT id, organization_id, created_by, name, key_prefix, scopes, expires_at, last_used_at, created_at FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
 [hash]
 );
}

export async function listApiKeys(organizationId: string): Promise<ApiKeyRow[]> {
 const { rows } = await q<ApiKeyRow>(
 'SELECT id, organization_id, created_by, name, key_prefix, scopes, expires_at, last_used_at, created_at FROM api_keys WHERE organization_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
 [organizationId]
 );
 return rows;
}

export async function revokeApiKey(id: string): Promise<void> {
 await q('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [id]);
}

export async function updateLastUsed(id: string): Promise<void> {
 await q('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
}
