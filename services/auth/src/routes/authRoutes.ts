/**
 * Authentication routes for @nova/auth.
 */
import type { Request, Response, NextFunction } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import { createOrganization } from '../repositories/organizations';
import { createWorkspace } from '../repositories/workspaces';
import { createUser, findUserByEmail, verifyEmail, updatePassword } from '../repositories/users';
import { createSession, findSessionByRefreshToken, rotateRefreshToken } from '../repositories/sessions';
import { createOtpRecord, findActiveOtp, markOtpConsumed, incrementOtpAttempts } from '../repositories/otp';
import { findRoleByKey, assignRoleToUser } from '../repositories/roles';
import { logAudit } from '../repositories/audit';
import { q } from '../repositories/db';
import { hashPassword, verifyPassword, generateOtp } from '../crypto';
import { signAccessToken, signRefreshToken } from '../jwt';
import { authenticateJwt, AuthContext, AuthHttpError } from '../middleware';
import {
 RegisterEmailSchema, LoginSchema, PhoneOtpRequestSchema, PhoneOtpVerifySchema,
 PasswordResetRequestSchema, PasswordResetSchema, RefreshTokenSchema,
 MfaEnrollSchema, MfaVerifySchema,
} from '@nova/auth-types';

const router = createRouter();

function generateSecret(): string {
 const bytes = crypto.getRandomValues(new Uint8Array(20));
 return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function problem(status: number, title: string, detail: string, type = 'https://api.nova.leadup.in/problems/unknown'): Error {
 return new AuthHttpError(detail, status, title, type);
}

// ---- POST /auth/register ----

router.post('/register', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = RegisterEmailSchema.parse(req.body);

 const existing = await findUserByEmail(parsed.email);
 if (existing) {
 return next(problem(409, 'Conflict', 'An account with this email already exists', 'https://api.nova.leadup.in/problems/email-exists'));
 }

 const passwordHash = await hashPassword(parsed.password);
 const slugBase = parsed.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30);
 const org = await createOrganization({
 name: `${parsed.name}'s Organization`,
 slug: `${slugBase}-${Math.random().toString(36).slice(2, 6)}`,
 plan: 'free',
 });

 const user = await createUser({ email: parsed.email, password: passwordHash });
 await verifyEmail(user.id);

 const ws = await createWorkspace(org.id, 'Default Workspace');

 const ownerRole = await findRoleByKey('owner');
 if (ownerRole) {
 await assignRoleToUser(user.id, ws.id, ownerRole.id, user.id);
 }

 const payload = { sub: user.id, orgId: org.id, workspaceId: ws.id, role: 'owner', email: user.email };
 const { token: accessToken, expiresIn } = signAccessToken(payload);
 const { token: refreshToken, expiresAt } = signRefreshToken();

 await createSession({
 userId: user.id, organizationId: org.id, workspaceId: ws.id,
 accessToken, refreshToken,
 userAgent: req.headers['user-agent'] ?? undefined,
 ipAddress: req.ip ?? undefined, expiresAt,
 });

 await logAudit({ organizationId: org.id, actorUserId: user.id, action: 'user.register', resourceType: 'user', resourceId: user.id });

 res.status(201).json({
 user: { id: user.id, email: user.email, name: parsed.name, orgId: org.id, role: 'owner', hasMfa: false, mfaMethods: [] },
 tokens: { accessToken, refreshToken, expiresIn },
 });
 } catch (err) {
 if (err instanceof z.ZodError) {
 next(problem(400, 'Validation Error', err.issues.map((i: any) => i.message).join(', ')));
 return;
 }
 next(err instanceof Error ? err : new Error('Registration failed'));
 }
});

// ---- POST /auth/login ----

router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = LoginSchema.parse(req.body);
 const user = await findUserByEmail(parsed.email);

 if (!user || !user.password_hash) {
 return next(problem(401, 'Unauthorized', 'Invalid email or password', 'https://api.nova.leadup.in/problems/invalid-credentials'));
 }

 const valid = await verifyPassword(parsed.password, user.password_hash);
 if (!valid) {
 return next(problem(401, 'Unauthorized', 'Invalid email or password', 'https://api.nova.leadup.in/problems/invalid-credentials'));
 }

 if (!user.email_verified) {
 return next(problem(403, 'Email Not Verified', 'Email not verified', 'https://api.nova.leadup.in/problems/email-not-verified'));
 }

 const orgId = user.primary_organization_id;
 const wsId = user.primary_workspace_id;
 if (!orgId || !wsId) {
 return next(problem(500, 'Server Error', 'Account incomplete'));
 }

 const roleRow = await findRoleByKey('member');
 const roleKey = roleRow?.key ?? 'member';

 const payload = { sub: user.id, orgId, workspaceId: wsId, role: roleKey, email: user.email };
 const { token: accessToken, expiresIn } = signAccessToken(payload);
 const { token: refreshToken, expiresAt } = signRefreshToken();

 await createSession({ userId: user.id, organizationId: orgId, workspaceId: wsId, accessToken, refreshToken,
 userAgent: req.headers['user-agent'] ?? undefined, ipAddress: req.ip ?? undefined, expiresAt });

 await logAudit({ organizationId: orgId, actorUserId: user.id, action: 'user.login', resourceType: 'session' });

 res.json({
 user: { id: user.id, email: user.email, orgId, workspaceId: wsId, role: roleKey, hasMfa: false, mfaMethods: [] },
 tokens: { accessToken, refreshToken, expiresIn },
 });
 } catch (err) {
 next(err instanceof Error ? err : new Error('Login failed'));
 }
});

// ---- POST /auth/refresh ----

router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = RefreshTokenSchema.parse(req.body);
 const session = await findSessionByRefreshToken(parsed.refreshToken);
 if (!session || session.status !== 'active') {
 return next(problem(401, 'Unauthorized', 'Invalid or expired refresh token', 'https://api.nova.leadup.in/problems/invalid-refresh-token'));
 }

 const payload = { sub: session.user_id, orgId: session.organization_id, workspaceId: session.workspace_id, role: 'member' };
 const { token: accessToken, expiresIn } = signAccessToken(payload);
 const { token: refreshToken, expiresAt } = signRefreshToken();
 await rotateRefreshToken(session.id, accessToken, refreshToken, expiresAt);
 res.json({ accessToken, refreshToken, expiresIn });
 } catch (err) {
 next(err instanceof Error ? err : new Error('Token refresh failed'));
 }
});

// ---- POST /auth/phone/otp/request ----

router.post('/phone/otp/request', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = PhoneOtpRequestSchema.parse(req.body);
 const otp = generateOtp(6);
 console.log(`[OTP] SMS to ${parsed.phoneNumber}: ${otp}`);

 const codeHash = await hashPassword(otp);
 const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
 await createOtpRecord({ phoneNumber: parsed.phoneNumber, codeHash, channel: parsed.channel, purpose: 'login', expiresAt });

 res.status(202).json({ message: 'OTP sent', expiresIn: 300 });
 } catch (err) {
 if (err instanceof z.ZodError) {
 next(problem(400, 'Validation Error', err.issues.map((i: any) => i.message).join(', ')));
 return;
 }
 next(err instanceof Error ? err : new Error('OTP request failed'));
 }
});

// ---- POST /auth/phone/otp/verify ----

router.post('/phone/otp/verify', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = PhoneOtpVerifySchema.parse(req.body);
 const otpRecord = await findActiveOtp(parsed.phoneNumber, 'login');
 if (!otpRecord) {
 return next(problem(400, 'Bad Request', 'No active OTP found'));
 }
 if (otpRecord.attempts >= otpRecord.max_attempts) {
 return next(problem(429, 'Too Many Requests', 'Too many attempts'));
 }

 const valid = await verifyPassword(parsed.code, otpRecord.code_hash);
 if (!valid) {
 await incrementOtpAttempts(otpRecord.id);
 return next(problem(401, 'Unauthorized', 'Invalid OTP code'));
 }

 await markOtpConsumed(otpRecord.id);

 let user = await findUserByEmail(parsed.phoneNumber);
 let orgId: string, wsId: string, userId: string;

 if (user) {
 orgId = user.primary_organization_id!;
 wsId = user.primary_workspace_id!;
 userId = user.id;
 } else {
 const org = await createOrganization({ name: 'Phone User', slug: `phone-${parsed.phoneNumber.replace(/\+/g, '')}`, plan: 'free' });
 orgId = org.id;
 const ws = await createWorkspace(org.id, 'Default Workspace');
 wsId = ws.id;
 user = await createUser({ email: parsed.phoneNumber, phoneNumber: parsed.phoneNumber });
 userId = user.id;
 await verifyEmail(userId);
 const ownerRole = await findRoleByKey('owner');
 if (ownerRole) await assignRoleToUser(userId, wsId, ownerRole.id, userId);
 }

 const payload = { sub: userId, orgId, workspaceId: wsId, role: 'member' };
 const { token: accessToken, expiresIn } = signAccessToken(payload);
 const { token: refreshToken, expiresAt } = signRefreshToken();
 await createSession({ userId, organizationId: orgId, workspaceId: wsId, accessToken, refreshToken, expiresAt });

 res.json({ tokens: { accessToken, refreshToken, expiresIn } });
 } catch (err) {
 next(err instanceof Error ? err : new Error('OTP verification failed'));
 }
});

// ---- POST /auth/password-reset/request ----

router.post('/password-reset/request', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = PasswordResetRequestSchema.parse(req.body);
 const user = await findUserByEmail(parsed.email);
 if (user) {
 const resetToken = crypto.randomUUID();
 const tokenHash = await hashPassword(resetToken);
 const expiresAt = new Date(Date.now() + 3600_000);
 await q('INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
 [crypto.randomUUID(), user.id, tokenHash, expiresAt.toISOString()]
 );
 console.log(`[PASSWORD_RESET] Token for ${user.email}: ${resetToken}`);
 await logAudit({ organizationId: user.primary_organization_id ?? '', actorUserId: user.id, action: 'password.reset.request' });
 }
 res.status(202).json({ message: 'If the email exists, a reset link was sent' });
 } catch (err) {
 next(err instanceof Error ? err : new Error('Reset request failed'));
 }
});

// ---- POST /auth/password-reset/confirm ----

router.post('/password-reset/confirm', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = PasswordResetSchema.parse(req.body);
 const rows = await q<{ id: string; user_id: string; token_hash: string }>(
 'SELECT id, user_id, token_hash FROM password_reset_tokens WHERE consumed = false AND expires_at > now() LIMIT 200'
 );

 let tokenRow: { id: string; user_id: string } | null = null;
 for (const row of rows) {
 if (await verifyPassword(parsed.token, row.token_hash)) {
 tokenRow = { id: row.id, user_id: row.user_id };
 break;
 }
 }
 if (!tokenRow) {
 return next(problem(400, 'Bad Request', 'Invalid or expired token'));
 }

 await updatePassword(tokenRow.user_id, parsed.newPassword);
 await q('UPDATE password_reset_tokens SET consumed = true, consumed_at = now() WHERE id = $1', [tokenRow.id]);
 res.status(204).send();
 } catch (err) {
 next(err instanceof Error ? err : new Error('Reset failed'));
 }
});

// ---- POST /auth/mfa/enroll ----

router.post('/mfa/enroll', authenticateJwt, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = MfaEnrollSchema.parse(req.body);
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 const secret = generateSecret();
 res.json({ method: parsed.method, secret, otpauthUrl: `otpauth://totp/NOVA:${ctx.userId}?secret=${secret}&issuer=NOVA` });
 } catch (err) {
 next(err instanceof Error ? err : new Error('MFA enrollment failed'));
 }
});

// ---- POST /auth/mfa/verify ----

router.post('/mfa/verify', authenticateJwt, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const parsed = MfaVerifySchema.parse(req.body);
 res.json({ verified: true });
 } catch (err) {
 next(err instanceof Error ? err : new Error('MFA verification failed'));
 }
});

// ---- GET /auth/me ----

router.get('/me', authenticateJwt, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 try {
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 const user = (req as unknown as { user }).user;
 res.json({
 id: user.id, email: user.email,
 orgId: ctx.orgId, workspaceId: ctx.workspaceId,
 role: ctx.role, permissions: ctx.permissions,
 hasMfa: false,
 });
 } catch (err) {
 next(err instanceof Error ? err : new Error('Failed to fetch profile'));
 }
});

export default router;
