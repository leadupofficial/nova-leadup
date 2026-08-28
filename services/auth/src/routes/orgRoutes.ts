/**
 * Organization routes — require org:view or higher.
 */
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { createOrganization, findOrganizationById, updateOrganization, softDeleteOrganization } from '../repositories/organizations';
import { createWorkspace, findWorkspacesByOrg } from '../repositories/workspaces';
import { assignRoleToUser, findRoleBinding, findRoleByKey, getAllRoles } from '../repositories/roles';
import { findUserById } from '../repositories/users';
import { logAudit } from '../repositories/audit';
import { authenticateJwt, requirePermission, requireRole, AuthContext, AuthHttpError, sendProblem } from '../middleware';
import { CreateOrganizationSchema } from '@nova/auth-types';

const router = createRouter();
const ROLE_OWNER = 'owner';
const ROLE_ADMIN = 'admin';
const PERM_ORG_VIEW = 'org:view';
const PERM_ORG_UPDATE = 'org:update';
const PERM_USER_INVITE = 'user:invite';

router.post(
 '/',
 authenticateJwt,
 requirePermission(PERM_ORG_UPDATE),
 async (req: Request, res: Response): Promise<void> => {
 try {
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 const parsed = CreateOrganizationSchema.parse(req.body);

 const org = await createOrganization({
 name: parsed.name,
 slug: parsed.slug,
 plan: parsed.plan,
 });

 const ws = await createWorkspace(org.id, 'Default Workspace');
 const ownerRole = await findRoleByKey(ROLE_OWNER);
 if (ownerRole) {
 await assignRoleToUser(ctx.userId, ws.id, ownerRole.id, ctx.userId);
 }

 await logAudit({
 organizationId: org.id,
 actorUserId: ctx.userId,
 action: 'organization.create',
 resourceType: 'organization',
 resourceId: org.id,
 });

 res.status(201).json({
 id: org.id,
 name: org.name,
 slug: org.slug,
 plan: org.plan,
 workspaceId: ws.id,
 createdAt: org.created_at,
 });
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to create organization'), req.path);
 }
 }
);

router.get(
 '/:id',
 authenticateJwt,
 requirePermission(PERM_ORG_VIEW),
 async (req: Request, res: Response): Promise<void> => {
 try {
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 const org = await findOrganizationById(req.params.id);
 if (!org) {
 return sendProblem(res, new AuthHttpError('Organization not found', 404, 'Not Found'), req.path);
 }

 const workspaces = await findWorkspacesByOrg(org.id);
 const roles = await getAllRoles();

 res.json({
 ...org,
 workspaces: workspaces.map((ws) => ({ id: ws.id, name: ws.name })),
 roles,
 });
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to fetch organization'), req.path);
 }
 }
);

router.patch(
 '/:id',
 authenticateJwt,
 requirePermission(PERM_ORG_UPDATE),
 async (req: Request, res: Response): Promise<void> => {
 try {
 const parsed = CreateOrganizationSchema.partial().parse(req.body);
 const org = await updateOrganization(req.params.id, parsed);
 if (!org) {
 return sendProblem(res, new AuthHttpError('Organization not found', 404, 'Not Found'), req.path);
 }
 res.json(org);
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to update organization'), req.path);
 }
 }
);

router.delete(
 '/:id',
 authenticateJwt,
 requireRole(ROLE_OWNER),
 async (req: Request, res: Response): Promise<void> => {
 try {
 await softDeleteOrganization(req.params.id);
 res.status(204).send();
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to delete organization'), req.path);
 }
 }
);

router.post(
 '/:id/members',
 authenticateJwt,
 requirePermission(PERM_USER_INVITE),
 async (req: Request, res: Response): Promise<void> => {
 try {
 const body = req.body as { userId: string; role: string };
 const binding = await assignRoleToUser(body.userId, req.params.id, body.role, (req as unknown as { auth: AuthContext }).auth.userId);
 res.status(201).json({ id: binding.id, userId: body.userId, role: body.role });
 } catch (err) {
 sendProblem(res, err instanceof Error ? err : new Error('Failed to assign role'), req.path);
 }
 }
);

export default router;
