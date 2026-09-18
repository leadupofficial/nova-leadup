import { Request, Response, NextFunction } from 'express';
import { HttpError } from './error-handler.js';
import { eq } from 'drizzle-orm';

/**
 * Ownership validation middleware.
 *
 * Verifies that the authenticated user owns the requested resource.
 * Looks up the resource by `id` param and confirms `userId` matches `req.user.id`.
 *
 * Usage:
 *   router.get('/:id', authenticate, requireOwnership(ResourceModel, 'id', 'userId'), ...)
 */

type OwnedModel = {
	userId: { toString(): string };
	id: { toString(): string };
};

/**
 * Generic ownership middleware for models exposing `findFirst`.
 */
export function requireOwnership<T extends OwnedModel>(
	Model: { findFirst: (opts: { where: { id: { equals: string } } }) => Promise<T | undefined> },
	paramName = 'id',
	ownerField = 'userId',
) {
	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			const resourceId = req.params[paramName];
			const userId = (req as any).user?.id as string | undefined;

			if (!userId) {
				return next(new HttpError(401, 'Authentication required', 'UNAUTHENTICATED'));
			}

			const resource = await Model.findFirst({
				where: { id: { equals: resourceId } },
			});

			if (!resource) {
				return next(new HttpError(404, 'Resource not found', 'NOT_FOUND'));
			}

			const ownerValue = resource[ownerField as keyof T];
			if (!ownerValue || ownerValue.toString() !== userId) {
				return next(new HttpError(403, 'You do not have permission to access this resource', 'FORBIDDEN'));
			}

			next();
		} catch (err) {
			next(err);
		}
	};
}

/**
 * Drizzle-style ownership middleware.
 *
 * Works with queries of the form:
 *   db.select().from(Model).where(eq(Model.ownerField, req.user!.id))
 *
 * The lookup query is executed once per request; if the resource does not exist or
 * does not belong to the caller, the request is rejected before business logic runs.
 */
export type DrizzleOwnedModel = {
	userId?: { toString(): string };
	ownerId?: { toString(): string };
	organizationId?: { toString(): string };
	conversationId?: { toString(): string };
	user: { toString(): string };
	id: { toString(): string };
};

export function withOwnership<T extends DrizzleOwnedModel>(
	Model: {
		findFirst: (opts: {
			where: ReturnType<typeof eq>;
			limit?: number;
		}) => Promise<T | undefined>;
	},
	options: {
		paramName?: string;
		ownerField: 'userId' | 'ownerId' | 'organizationId' | 'conversationId' | 'user';
		paramField?: string;
	},
) {
	const { paramName = 'id', ownerField, paramField = 'id' } = options;

	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			const rawResourceId = req.params[paramName];
			const userId = (req as any).user?.id as string | undefined;

			if (!userId) {
				return next(new HttpError(401, 'Authentication required', 'UNAUTHENTICATED'));
			}

			const modelField = (Model as any)[ownerField];
			if (!modelField) {
				return next(new HttpError(500, `Model does not have field ${ownerField}`, 'INTERNAL_ERROR'));
			}

			const resource = await Model.findFirst({
				where: eq(modelField as any, userId),
				limit: 1,
			});

			if (!resource) {
				return next(new HttpError(404, 'Resource not found', 'NOT_FOUND'));
			}

			if ((resource as any)[paramField]?.toString() !== rawResourceId) {
				return next(new HttpError(403, 'You do not have permission to access this resource', 'FORBIDDEN'));
			}

			next();
		} catch (err) {
			next(err);
		}
	};
}
