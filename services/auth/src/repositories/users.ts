import { generateId } from '@nova/utils';
import { hashPassword as _hashPassword, verifyPassword as _verifyPassword } from '../crypto';
import { q, qOne } from './db';

export interface UserRow {
 id: string;
 email: string;
 phone_number: string | null;
 email_verified: boolean;
 phone_verified: boolean;
 password_hash: string | null;
 primary_organization_id: string | null;
 primary_workspace_id: string | null;
 created_at: string;
 updated_at: string;
}

export async function createUser(input: {
 email: string;
 phoneNumber?: string;
 password?: string;
}): Promise<UserRow> {
 const id = generateId('usr');
 const passwordHash = input.password ? await _hashPassword(input.password) : null;
 const { rows } = await q<UserRow>(
 `INSERT INTO users (id, email, phone_number, password_hash)
 VALUES ($1, $2, $3, $4)
 RETURNING id, email, phone_number, email_verified, phone_verified, password_hash, primary_organization_id, primary_workspace_id, created_at, updated_at`,
 [id, input.email, input.phoneNumber ?? null, passwordHash]
 );
 return rows[0];
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
 return qOne<UserRow>(
 'SELECT * FROM users WHERE email = lower($1) AND deleted_at IS NULL',
 [email]
 );
}

export async function findUserById(id: string): Promise<UserRow | null> {
 return qOne<UserRow>(
 'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
 [id]
 );
}

export async function verifyEmail(userId: string): Promise<void> {
 await q(
 'UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1',
 [userId]
 );
}

export async function setPrimaryOrg(userId: string, orgId: string): Promise<void> {
 await q(
 'UPDATE users SET primary_organization_id = $1, updated_at = now() WHERE id = $2',
 [orgId, userId]
 );
}

export async function setPrimaryWorkspace(userId: string, workspaceId: string): Promise<void> {
 await q(
 'UPDATE users SET primary_workspace_id = $1, updated_at = now() WHERE id = $2',
 [workspaceId, userId]
 );
}

export async function verifyPasswordForUser(
 plaintext: string,
 hash: string
): Promise<boolean> {
 return _verifyPassword(plaintext, hash);
}

export async function updatePassword(userId: string, newPassword: string): Promise<void> {
 const hash = await _hashPassword(newPassword);
 await q(
 'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
 [hash, userId]
 );
}

export async function markDeleted(userId: string): Promise<void> {
 await q(
 'UPDATE users SET deleted_at = now(), email = null, password_hash = null WHERE id = $1',
 [userId]
 );
}
