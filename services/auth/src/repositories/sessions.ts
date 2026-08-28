import { generateId } from '@nova/utils';
import { hashToken, compareTokenHash } from '../crypto';
import { q, qOne, closePool } from './db';

export interface SessionRow {
 id: string;
 user_id: string;
 organization_id: string;
 workspace_id: string;
 token_hash: string;
 refresh_token_hash: string | null;
 status: string;
 mfa_verified: boolean;
 expires_at: string;
 created_at: string;
}

export interface NewSessionInput {
 userId: string;
 organizationId: string;
 workspaceId: string;
 accessToken: string;
 refreshToken: string;
 userAgent?: string;
 ipAddress?: string;
 expiresAt: Date;
}

export async function createSession(input: NewSessionInput): Promise<SessionRow> {
 const id = generateId('ses');
 const tokenHash = await hashToken(input.accessToken);
 const refreshTokenHash = await hashToken(input.refreshToken);
 const { rows } = await q<SessionRow>(
 `INSERT INTO sessions (id, user_id, organization_id, workspace_id, token_hash, refresh_token_hash, user_agent, ip_address, expires_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
 RETURNING id, user_id, organization_id, workspace_id, token_hash, refresh_token_hash, status, mfa_verified, expires_at, created_at`,
 [id, input.userId, input.organizationId, input.workspaceId, tokenHash, refreshTokenHash, input.userAgent ?? null, input.ipAddress ?? null, input.expiresAt.toISOString()]
 );
 return rows[0];
}

export async function findSessionByToken(token: string): Promise<SessionRow | null> {
 const { rows } = await q<SessionRow>(
 'SELECT * FROM sessions WHERE status = $1 AND expires_at > now() ORDER BY created_at DESC',
 ['active']
 );
 for (const row of rows) {
 if (await compareTokenHash(token, row.token_hash)) return row;
 }
 return null;
}

export async function findSessionByRefreshToken(refreshToken: string): Promise<SessionRow | null> {
 const { rows } = await q<SessionRow>(
 'SELECT * FROM sessions WHERE status = $1 AND refresh_token_hash IS NOT NULL AND expires_at > now()',
 ['active']
 );
 for (const row of rows) {
 if (await compareTokenHash(refreshToken, row.refresh_token_hash ?? '')) return row;
 }
 return null;
}

export async function revokeSession(id: string): Promise<void> {
 await q(
 'UPDATE sessions SET status = $1, revoked_at = now() WHERE id = $2',
 ['revoked', id]
 );
}

export async function revokeAllUserSessions(userId: string, orgId: string): Promise<void> {
 await q(
 'UPDATE sessions SET status = $1, revoked_at = now() WHERE user_id = $2 AND organization_id = $3 AND status = $4',
 ['revoked', userId, orgId, 'active']
 );
}

export async function rotateRefreshToken(
 sessionId: string,
 newAccessToken: string,
 newRefreshToken: string,
 newExpiresAt: Date
): Promise<void> {
 const newAccessHash = await hashToken(newAccessToken);
 const newRefreshHash = await hashToken(newRefreshToken);
 await q(
 'UPDATE sessions SET token_hash = $1, refresh_token_hash = $2, last_used_at = now(), expires_at = $3 WHERE id = $4',
 [newAccessHash, newRefreshHash, newExpiresAt.toISOString(), sessionId]
 );
}
