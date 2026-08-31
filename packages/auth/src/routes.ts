/**
 * NOVA — Auth Routes
 *
 * Database-backed authentication endpoints:
 * - POST /register — create user + issue tokens
 * - POST /login — email/password or OTP login
 * - POST /otp/request — request OTP via SMS
 * - POST /otp/verify — verify OTP code
 * - POST /refresh — rotate refresh token
 * - POST /logout — revoke session
 * - GET /session — get current session
 */

import type { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, signRefreshToken, generateSessionId, verifyRefreshToken, type AccessTokenPayload } from './jwt';
import { authMiddleware, type AuthenticatedRequest } from './middleware';
import { userRepo, sessionRepo, type StoredUser } from './repositories';
import { Redis } from 'ioredis';

// ─── OTP Store (Redis-backed for multi-instance deployments) ────────────────
// Falls back to in-memory Map if Redis is unavailable (development).

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
 maxRetriesPerRequest: 3,
 connectTimeout: 5000,
});

const OTP_PREFIX = 'nova:otp:';
const MAX_OTP_ATTEMPTS = 5;
const OTP_TTL_SECONDS = 10 * 60; // 10 minutes

// In-memory fallback for development without Redis
const memoryOtpStore = new Map<string, { code: string; expiresAt: Date; attempts: number }>();

async function getOtpEntry(phone: string): Promise<{ code: string; expiresAt: Date; attempts: number } | null> {
 try {
 const key = `${OTP_PREFIX}${phone}`;
 const raw = await redis.get(key);
 if (!raw) return null;
 return JSON.parse(raw);
 } catch {
 // Fallback to memory store
 return memoryOtpStore.get(phone) ?? null;
 }
}

async function setOtpEntry(phone: string, entry: { code: string; expiresAt: Date; attempts: number }): Promise<void> {
 try {
 const key = `${OTP_PREFIX}${phone}`;
 await redis.setex(key, OTP_TTL_SECONDS, JSON.stringify(entry));
 } catch {
 // Fallback to memory store
 memoryOtpStore.set(phone, entry);
 }
}

async function deleteOtpEntry(phone: string): Promise<void> {
 try {
 await redis.del(`${OTP_PREFIX}${phone}`);
 } catch {
 memoryOtpStore.delete(phone);
 }
}

async function incrementOtpAttempts(phone: string): Promise<number> {
 try {
 const key = `${OTP_PREFIX}${phone}`;
 const current = await redis.get(key);
 if (!current) return 0;
 const entry = JSON.parse(current);
 entry.attempts = (entry.attempts ?? 0) + 1;
 await redis.setex(key, Math.max(1, Math.floor((new Date(entry.expiresAt).getTime() - Date.now()) / 1000)), JSON.stringify(entry));
 return entry.attempts;
 } catch {
 const entry = memoryOtpStore.get(phone);
 if (!entry) return 0;
 entry.attempts = (entry.attempts ?? 0) + 1;
 return entry.attempts;
 }
}

// ─── Schemas ────────────────────────────────────────────────────

const RegisterSchema = z.object({
 email: z.string().email().optional(),
 phone: z.string().regex(/^\+?[1-9]\d{9,14}$/).optional(),
 password: z.string().min(8, 'Password must be at least 8 characters').optional(),
 name: z.string().min(1, 'Name is required'),
}).refine((d) => d.email || d.phone, { message: 'Either email or phone is required' })
 .refine((d) => d.email ? d.password : true, { message: 'Password required for email registration' });

const LoginSchema = z.object({
 email: z.string().email().optional(),
 phone: z.string().optional(),
 password: z.string().optional(),
 otpCode: z.string().optional(),
}).refine((d) => d.email || d.phone, { message: 'Email or phone required' });

const OTPRequestSchema = z.object({
 phone: z.string().regex(/^\+?[1-9]\d{9,14}$/),
});

const OTPVerifySchema = z.object({
 phone: z.string().regex(/^\+?[1-9]\d{9,14}$/),
 code: z.string().length(6),
});

// ─── Helpers ────────────────────────────────────────────────────

function generateOTP(): string {
 return Math.floor(100000 + Math.random() * 900000).toString();
}

async function findUserByIdentifier(identifier: string): Promise<StoredUser | null> {
 const byEmail = await userRepo.findByEmail(identifier);
 if (byEmail) return byEmail;
 return userRepo.findByPhone(identifier);
}

function userToResponse(user: StoredUser) {
 return {
 id: user.id,
 email: user.email,
 phone: user.phone,
 name: user.name,
 emailVerified: user.emailVerified,
 phoneVerified: user.phoneVerified,
 };
}

// ─── Routes ─────────────────────────────────────────────────────

export function authRoutes(router: Router): void {
 // POST /auth/register
 router.post('/register', async (req: Request, res: Response) => {
 try {
 const body = RegisterSchema.parse(req.body);

 if (body.email) {
 const existing = await userRepo.findByEmail(body.email);
 if (existing) {
 res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Email already registered' } });
 return;
 }
 }
 if (body.phone) {
 const existing = await userRepo.findByPhone(body.phone);
 if (existing) {
 res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Phone already registered' } });
 return;
 }
 }

 const user = await userRepo.create({
 email: body.email,
 phone: body.phone,
 password: body.password,
 name: body.name,
 });

 const accessToken = signAccessToken({ sub: user.id, email: user.email ?? undefined, type: 'access' });
 const sessionId = generateSessionId();
 const refreshToken = signRefreshToken(user.id, sessionId);

 const refreshTokenHash = await bcrypt.hash(refreshToken, 12);
 await sessionRepo.create({
 userId: user.id,
 refreshTokenHash,
 expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 });

 res.status(201).json({
 success: true,
 data: {
 user: userToResponse(user),
 accessToken,
 refreshToken,
 },
 });
 } catch (err) {
 if (err instanceof z.ZodError) {
 res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.errors.map((e) => (e as { message: string }).message).join(', ') } });
 return;
 }
 console.error('[auth] Registration error:', err);
 res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Registration failed' } });
 }
 });

 // POST /auth/login
 router.post('/login', async (req: Request, res: Response) => {
 try {
 const body = LoginSchema.parse(req.body);

 let user: StoredUser | null = null;
 if (body.email) user = await userRepo.findByEmail(body.email);
 if (!user && body.phone) user = await userRepo.findByPhone(body.phone);
 if (!user) {
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
 return;
 }

 if (!body.password && body.otpCode) {
 if (!user.phone) {
 res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'OTP not available for this account' } });
 return;
 }
 const otpEntry = await getOtpEntry(user.phone);
 if (!otpEntry || new Date(otpEntry.expiresAt) < new Date()) {
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'OTP expired or not requested' } });
 return;
 }
 if (otpEntry.attempts >= MAX_OTP_ATTEMPTS) {
 await deleteOtpEntry(user.phone);
 res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many OTP attempts' } });
 return;
 }
 if (otpEntry.code !== body.otpCode) {
 await incrementOtpAttempts(user.phone);
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid OTP' } });
 return;
 }
 await deleteOtpEntry(user.phone);
 } else if (body.password) {
 if (!user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
 return;
 }
 } else {
 res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Provide password or OTP code' } });
 return;
 }

 const accessToken = signAccessToken({ sub: user.id, email: user.email ?? undefined, type: 'access' });
 const sessionId = generateSessionId();
 const refreshToken = signRefreshToken(user.id, sessionId);

 const refreshTokenHash = await bcrypt.hash(refreshToken, 12);
 await sessionRepo.create({
 userId: user.id,
 refreshTokenHash,
 expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 });

 await userRepo.recordLogin(user.id);

 res.json({
 success: true,
 data: {
 user: userToResponse(user),
 accessToken,
 refreshToken,
 },
 });
 } catch (err) {
 if (err instanceof z.ZodError) {
 res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.errors.map((e) => (e as { message: string }).message).join(', ') } });
 return;
 }
 console.error('[auth] Login error:', err);
 res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Login failed' } });
 }
 });

 // POST /auth/otp/request
router.post('/otp/request', async (req: Request, res: Response) => {
 try {
 const body = OTPRequestSchema.parse(req.body);
 const code = generateOTP();
 await setOtpEntry(body.phone, { code, expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000), attempts: 0 });
 console.log(`[DEV OTP] ${body.phone}: ${code}`);
 res.json({ success: true, data: { message: 'OTP sent', expiresIn: OTP_TTL_SECONDS } });
 } catch (err) {
 if (err instanceof z.ZodError) {
 res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.errors.map((e) => (e as { message: string }).message).join(', ') } });
 return;
 }
 res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'OTP request failed' } });
 }
});

// POST /auth/otp/verify
router.post('/otp/verify', async (req: Request, res: Response) => {
 try {
 const body = OTPVerifySchema.parse(req.body);
 const entry = await getOtpEntry(body.phone);
 if (!entry || new Date(entry.expiresAt) < new Date()) {
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'OTP expired' } });
 return;
 }
 if (entry.attempts >= MAX_OTP_ATTEMPTS) {
 await deleteOtpEntry(body.phone);
 res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts' } });
 return;
 }
 if (entry.code !== body.code) {
 await incrementOtpAttempts(body.phone);
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid OTP' } });
 return;
 }
 await deleteOtpEntry(body.phone);
 res.json({ success: true, data: { verified: true } });
 } catch (err) {
 if (err instanceof z.ZodError) {
 res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.errors.map((e) => (e as { message: string }).message).join(', ') } });
 return;
 }
 res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'OTP verify failed' } });
 }
});

 // POST /auth/refresh
 router.post('/refresh', async (req: Request, res: Response) => {
 try {
 const { refreshToken } = req.body as { refreshToken?: string };
 if (!refreshToken) {
 res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'refreshToken required' } });
 return;
 }

 const payload = verifyRefreshToken(refreshToken);
 if (!payload) {
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid refresh token' } });
 return;
 }

 const session = await sessionRepo.findByTokenHash(refreshToken);
 if (!session || session.revokedAt) {
 res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session revoked' } });
 return;
 }

 const accessToken = signAccessToken({ sub: payload.sub, type: 'access' });
 const newRefreshToken = signRefreshToken(payload.sub, generateSessionId());

 const newTokenHash = await bcrypt.hash(newRefreshToken, 12);
 await sessionRepo.create({
 userId: payload.sub,
 refreshTokenHash: newTokenHash,
 expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 });

 res.json({ success: true, data: { accessToken, refreshToken: newRefreshToken } });
 } catch (err) {
 console.error('[auth] Refresh error:', err);
 res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Token refresh failed' } });
 }
 });

 // POST /auth/logout
 router.post('/logout', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
 try {
 const { refreshToken } = req.body as { refreshToken?: string };
 if (refreshToken) {
 const session = await sessionRepo.findByTokenHash(refreshToken);
 if (session) {
 await sessionRepo.revoke(session.id);
 }
 }
 res.status(204).send();
 } catch {
 res.status(204).send();
 }
 });

 // GET /auth/session
 router.get('/session', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
 try {
 const user = await userRepo.findById(req.user!.sub);
 if (!user) {
 res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
 return;
 }
 res.json({
 success: true,
 data: {
 userId: user.id,
 email: user.email,
 phone: user.phone,
 name: user.name,
 emailVerified: user.emailVerified,
 phoneVerified: user.phoneVerified,
 role: req.user!.role,
 tenantId: req.user!.tenantId,
 },
 });
 } catch (err) {
 console.error('[auth] Session error:', err);
 res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get session' } });
 }
 });
}
