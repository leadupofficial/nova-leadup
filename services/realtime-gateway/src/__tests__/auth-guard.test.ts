/**
 * @nova/realtime-gateway — auth-guard unit tests.
 *
 * Mocks @nova/auth at the module level to avoid validateEnv side-effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';

// Mock @nova/auth BEFORE importing the module under test so validateEnv never runs.
vi.mock('@nova/auth', () => ({
 verifyAccessToken: vi.fn(),
}));

// Mock the logger to keep test output clean.
vi.mock('../utils/logger.js', () => ({
 logger: {
 info: vi.fn(),
 warn: vi.fn(),
 error: vi.fn(),
 debug: vi.fn(),
 },
}));

import { verifyAccessToken } from '@nova/auth';
import { createAuthGuard } from '../middleware/auth-guard.js';
import type { JwtPayload } from '@nova/auth-types';

function makeReq(headers: Record<string, string> = {}): http.IncomingMessage {
 const req = new http.IncomingMessage(null as any);
 req.headers = headers;
 req.url = '/';
 return req;
}

describe('createAuthGuard', () => {
 let authGuard: ReturnType<typeof createAuthGuard>;
 let mockUserService: { findById: ReturnType<typeof vi.fn> };

 beforeEach(() => {
 vi.clearAllMocks();
 mockUserService = { findById: vi.fn().mockResolvedValue({ id: 'user-1' }) };
 authGuard = createAuthGuard({ authSecret: 'test-secret', userService: mockUserService as any });
 });

 describe('authenticateConnection', () => {
 it('accepts a valid token and returns the payload', async () => {
 const payload: JwtPayload = { sub: 'user-1', role: 'user', exp: 9999999999, iat: 1000000000 };
 vi.mocked(verifyAccessToken).mockResolvedValue(payload);

 const req = makeReq({ authorization: 'Bearer valid-token' });
 const result = await authGuard.authenticateConnection(req);
 expect(result.sub).toBe('user-1');
 });

 it('rejects requests with no Authorization header', async () => {
 const req = makeReq({});
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Missing authentication token');
 });

 it('rejects requests with an empty Authorization header', async () => {
 const req = makeReq({ authorization: '' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Missing authentication token');
 });

 it('rejects requests with an obviously malformed token (non-base64 chars)', async () => {
 const req = makeReq({ authorization: 'Bearer not!!!valid' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Missing authentication token');
 });

 it('rejects requests with a non-Bearer scheme', async () => {
 const req = makeReq({ authorization: 'Basic abc' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Missing authentication token');
 });

 it('maps expired-token errors to "Token expired"', async () => {
 vi.mocked(verifyAccessToken).mockRejectedValue(new Error('jwt expired'));
 const req = makeReq({ authorization: 'Bearer expired-token' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Token expired');
 });

 it('maps invalid-signature errors to "Invalid token"', async () => {
 vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid signature'));
 const req = makeReq({ authorization: 'Bearer bad-token' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Invalid token');
 });

 it('maps generic errors to "Token verification failed"', async () => {
 vi.mocked(verifyAccessToken).mockRejectedValue(new Error('something weird'));
 const req = makeReq({ authorization: 'Bearer weird-token' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Token verification failed');
 });

 it('rejects a token whose payload has no sub', async () => {
 vi.mocked(verifyAccessToken).mockResolvedValue({ sub: '', role: 'user' } as any);
 const req = makeReq({ authorization: 'Bearer no-sub-token' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('Token missing subject claim');
 });

 it('rejects a token for a user that does not exist', async () => {
 mockUserService.findById.mockResolvedValue(null);
 vi.mocked(verifyAccessToken).mockResolvedValue({ sub: 'ghost-user', role: 'user' } as any);
 const req = makeReq({ authorization: 'Bearer ghost-token' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('User not found');
 });

 it('handles user-service errors gracefully and rejects', async () => {
 mockUserService.findById.mockRejectedValue(new Error('db down'));
 vi.mocked(verifyAccessToken).mockResolvedValue({ sub: 'user-1', role: 'user' } as any);
 const req = makeReq({ authorization: 'Bearer valid-token' });
 await expect(authGuard.authenticateConnection(req)).rejects.toThrow('User not found');
 });
 });
});
