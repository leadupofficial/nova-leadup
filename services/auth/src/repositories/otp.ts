import { q, qOne } from './db';

export interface OtpRow {
 id: string;
 phone_number: string;
 code_hash: string;
 channel: string;
 purpose: string;
 consumed: boolean;
 consumed_at: string | null;
 expires_at: string;
 attempts: number;
 max_attempts: number;
}

export async function createOtpRecord(input: {
 phoneNumber: string;
 codeHash: string;
 channel: string;
 purpose: string;
 expiresAt: Date;
 maxAttempts?: number;
}): Promise<OtpRow> {
 const id = crypto.randomUUID();
 const { rows } = await q<OtpRow>(
 `INSERT INTO phone_otp_codes (id, phone_number, code_hash, channel, purpose, expires_at, max_attempts)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 RETURNING id, phone_number, code_hash, channel, purpose, consumed, consumed_at, expires_at, attempts, max_attempts`,
 [id, input.phoneNumber, input.codeHash, input.channel, input.purpose, input.expiresAt.toISOString(), input.maxAttempts ?? 5]
 );
 return rows[0];
}

export async function findActiveOtp(
 phoneNumber: string,
 purpose: string
): Promise<OtpRow | null> {
 return qOne<OtpRow>(
 `SELECT * FROM phone_otp_codes
 WHERE phone_number = $1 AND purpose = $2 AND consumed = false AND expires_at > now()
 ORDER BY created_at DESC LIMIT 1`,
 [phoneNumber, purpose]
 );
}

export async function incrementOtpAttempts(id: string): Promise<void> {
 await q(
 'UPDATE phone_otp_codes SET attempts = attempts + 1 WHERE id = $1',
 [id]
 );
}

export async function markOtpConsumed(id: string): Promise<void> {
 await q(
 'UPDATE phone_otp_codes SET consumed = true, consumed_at = now() WHERE id = $1',
 [id]
 );
}

export async function cleanupExpiredOtps(): Promise<number> {
 const { rowCount } = await q(
 "DELETE FROM phone_otp_codes WHERE expires_at < now() - interval '1 hour'"
 );
 return rowCount ?? 0;
}
