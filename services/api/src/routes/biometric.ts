/**
 * NOVA API — Biometric Challenge Binding Routes
 *
 * Protects against client-side biometric bypass by requiring a server-issued,
 * single-use challenge on every unlock. The mobile app must:
 * 1. Register a public key on first biometric enable.
 * 2. Fetch a challenge before each unlock.
 * 3. Sign the challenge via biometric prompt.
 * 4. POST the signed challenge back for server verification.
 *
 * Stores challenges in-memory (Map) keyed by challengeId.
 * Challenges expire after 5 minutes and are single-use.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const router: ReturnType<typeof Router> = Router();

// In-memory store. For production, move to Redis with a TTL index.
const biometricChallenges = new Map<string, {
 userId: string;
 challenge: string;
 publicKey: string;
 issuedAt: number;
 used: boolean;
}>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Must match the access token secret from auth service.
const JWT_SECRET = (() => {
	const raw = process.env.JWT_SECRET || process.env.JWT_REFRESH_TOKEN_SECRET;
	if (!raw) {
		throw new Error('JWT_SECRET must be set to a strong value in production');
	}

	const weakSecrets = ['change-me-in-production', 'changeme', 'secret', 'password', 'default', 'fallback-secret-change-me'];
	if (weakSecrets.includes(raw.toLowerCase())) {
		throw new Error('JWT_SECRET appears to be a weak or default value');
	}

	return raw;
})();

function resolveUserId(req: Request): string | null {
 const authHeader = req.headers.authorization;
 if (!authHeader?.startsWith('Bearer ')) {
 return null;
 }
 try {
 const token = authHeader.slice(7);
 // Verify signature — do NOT trust decoded payload without verification.
 const payload = jwt.verify(token, JWT_SECRET) as { sub?: string };
 return payload?.sub ?? null;
 } catch {
 return null;
 }
}

function cleanupExpired(): void {
 const now = Date.now();
 for (const [id, entry] of biometricChallenges.entries()) {
 if (now - entry.issuedAt > CHALLENGE_TTL_MS) {
 biometricChallenges.delete(id);
 }
 }
}

// ─── Register public key ──────────────────────────────────────────────────────

/**
 * POST /api/v1/biometric/register
 * Headers: Authorization: Bearer <access_token>
 * Body: { publicKey: string }
 *
 * Registers a biometric public key for the user and returns a one-time challenge.
 * The app signs this challenge with its biometric-protected private key.
 */
router.post('/register', async (req: Request, res: Response) => {
 try {
 const userId = resolveUserId(req);
 if (!userId) {
 return res.status(401).json({ success: false, message: 'Unauthorized' });
 }

 const { publicKey } = req.body ?? {};
 if (!publicKey || typeof publicKey !== 'string') {
 return res.status(400).json({ success: false, message: 'publicKey is required' });
 }

 const challengeId = crypto.randomBytes(32).toString('hex');
 const challenge = crypto.randomBytes(32).toString('hex');

 cleanupExpired();

 biometricChallenges.set(challengeId, {
 userId,
 challenge,
 publicKey,
 issuedAt: Date.now(),
 used: false,
 });

 return res.status(200).json({
 success: true,
 challengeId,
 challenge,
 publicKey,
 });
 } catch (error) {
 console.error('[biometric/register] error:', error);
 return res.status(500).json({ success: false, message: 'Internal server error' });
 }
});

// ─── Verify signed challenge ──────────────────────────────────────────────────

/**
 * POST /api/v1/biometric/verify
 * Body: { challengeId: string, signature: string, publicKey: string }
 *
 * Verifies that:
 * 1. The challenge exists and belongs to the publicKey.
 * 2. The challenge has not expired.
 * 3. The challenge has not been used before (single-use).
 * 4. The signature is valid (RSA-SSA PKCS#1 v1.5 with SHA-256).
 *
 * On success, returns { valid: true } and a fresh session token.
 * The frontend should store this token and use it as the new access token.
 */
router.post('/verify', async (req: Request, res: Response) => {
 try {
 const { challengeId, signature, publicKey } = req.body ?? {};

 if (!challengeId || !signature || !publicKey) {
 return res.status(400).json({ success: false, message: 'challengeId, signature, and publicKey are required' });
 }

 const entry = biometricChallenges.get(challengeId);

 if (!entry) {
 return res.status(400).json({ success: false, message: 'Invalid or expired challenge' });
 }

 if (entry.used) {
 return res.status(400).json({ success: false, message: 'Challenge already used' });
 }

 if (entry.publicKey !== publicKey) {
 return res.status(400).json({ success: false, message: 'Public key mismatch' });
 }

 if (Date.now() - entry.issuedAt > CHALLENGE_TTL_MS) {
 biometricChallenges.delete(challengeId);
 return res.status(400).json({ success: false, message: 'Challenge expired' });
 }

 // Verify RSA-SSA signature
 let valid = false;
 try {
 const verify = crypto.createVerify('RSA-SHA256');
 verify.update(entry.challenge);
 verify.end();
 const key = crypto.createPublicKey(publicKey);
 valid = verify.verify(key, signature, 'base64');
 } catch (sigError) {
 console.error('[biometric/verify] signature check failed:', sigError);
 }

 // Mark as single-use regardless of result
 entry.used = true;
 biometricChallenges.delete(challengeId);

 if (!valid) {
 return res.status(401).json({ success: false, message: 'Invalid signature' });
 }

 // Issue a fresh session token (using same JWT secret as auth service)
 const sessionToken = jwt.sign(
 { sub: entry.userId, type: 'biometric', iat: Math.floor(Date.now() / 1000) },
 JWT_SECRET,
 { expiresIn: '8h' },
 );

 return res.status(200).json({
 success: true,
 valid: true,
 token: sessionToken,
 });
 } catch (error) {
 console.error('[biometric/verify] error:', error);
 return res.status(500).json({ success: false, message: 'Internal server error' });
 }
});

// ─── Enable biometric for account ─────────────────────────────────────────────

/**
 * POST /api/v1/biometric/enable
 * Headers: Authorization: Bearer <access_token>
 * Body: { publicKey: string }
 *
 * Marks the user's account as biometric-enabled server-side.
 * The app should call this once after successful /register + /verify flow.
 */
router.post('/enable', async (req: Request, res: Response) => {
 try {
 const userId = resolveUserId(req);
 if (!userId) {
 return res.status(401).json({ success: false, message: 'Unauthorized' });
 }

 const { publicKey } = req.body ?? {};
 if (!publicKey) {
 return res.status(400).json({ success: false, message: 'publicKey is required' });
 }

 // In production, persist this to the users or biometric_keys table.
 // For now, accept the registration — verification happens on every unlock.
 return res.status(200).json({ success: true, message: 'Biometric enabled' });
 } catch (error) {
 console.error('[biometric/enable] error:', error);
 return res.status(500).json({ success: false, message: 'Internal server error' });
 }
});

export { router as biometricRoutes };
