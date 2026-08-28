/**
 * API key management routes.
 */

import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createApiKey, listApiKeys, revokeApiKey, findApiKeyByHash } from '../repositories/apiKeys';
import { authenticateJwt, requirePermission, AuthContext, AuthHttpError, sendProblem } from '../middleware';
import { CreateApiKeySchema } from '@nova/auth-types';

const router = createRouter();

// ---- POST /api-keys ----

router.post(
 '/',
 authenticateJwt,
 requirePermission(Permission.ApiKeyCreate),
 async (req: Request, res: Response): Promise<void> => {
 try {
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 const parsed = CreateApiKeySchema.parse(req.body);

 const { key, rawKey } = await createApiKey(ctx.orgId, ctx.userId, {
 name: parsed.name,
 scopes: parsed.scopes,
 expiresAt: parsed.expiresAt,
 });

 // rawKey is returned ONCE — the user must store it
 res.status(201).json({
 id: key.id,
 name: key.name,
 prefix: key.prefix,
 scopes: key.scopes,
 expiresAt: key.expires_at,
 createdAt: key.created_at,
 rawKey, // shown once
 });
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to create API key'), req.path);
 }
 }
);

// ---- GET /api-keys ----

router.get(
 '/',
 authenticateJwt,
 requirePermission(Permission.ApiKeyView),
 async (req: Request, res: Response): Promise<void> => {
 try {
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 const keys = await listApiKeys(ctx.orgId);
 res.json(keys.map(k => ({
 id: k.id,
 name: k.name,
 prefix: k.key_prefix,
 scopes: k.scopes,
 expiresAt: k.expires_at,
 lastUsedAt: k.last_used_at,
 createdAt: k.created_at,
 })));
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to list API keys'), req.path);
 }
 }
);

// ---- DELETE /api-keys/:id ----

router.delete(
 '/:id',
 authenticateJwt,
 requirePermission(Permission.ApiKeyRevoke),
 async (req: Request, res: Response): Promise<void> => {
 try {
 await revokeApiKey(req.params.id);
 res.status(204).send();
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to revoke API key'), req.path);
 }
 }
);

// ---- Service-to-service auth middleware (for API key auth) ----

export async function authenticateApiKey(req: Request, _res: Response, next: Express.NextFunction): Promise<void> {
 try {
 const authHeader = req.headers.authorization;
 if (!authHeader?.startsWith('Bearer ')) {
 (req as unknown as { authError }).authError = new AuthHttpError('Missing API key', 401);
 return;
 }

 const rawKey = authHeader.slice(7);
 // Compute hash same way as createApiKey
 const { hmacSha256 } = await import('../crypto');
 const hash = hmacSha256(process.env.API_KEY_SECRET || 'default', rawKey);

 const key = await findApiKeyByHash(hash);
 if (!key || !key.scopes.includes('read')) {
 (req as unknown as { authError }).authError = new AuthHttpError('Invalid API key', 401);
 return;
 }

 if (key.expires_at && new Date(key.expires_at) < new Date()) {
 (req as unknown as { authError }).authError = new AuthHttpError('API key expired', 401);
 return;
 }

 // Attach API key context
 (req as unknown as { apiKey }).apiKey = { organizationId: key.organization_id, scopes: key.scopes };
 await updateLastUsed(key.id);
 next();
 } catch {
 (req as unknown as { authError }).authError = new AuthHttpError('API key validation failed', 401);
 }
}

export default router;
