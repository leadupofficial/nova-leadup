/**
 * NOVA API — Zod validation middleware factory.
 * Wraps route handlers to validate req.body, req.query, or req.params
 * against a Zod schema. On failure, passes a 400 HttpError to next().
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { HttpError } from './error-handler.js';

type SchemaSource = 'body' | 'query' | 'params';

export function validate<T extends z.ZodTypeAny>(
	schema: T,
	source: SchemaSource = 'body'
) {
	return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
		try {
			let raw: unknown;
			switch (source) {
				case 'body':
					raw = req.body;
					break;
				case 'query':
					raw = req.query;
					break;
				case 'params':
					raw = req.params;
					break;
				default:
					raw = req.body;
			}

			const result = schema.safeParse(raw);
			if (!result.success) {
				const fieldErrors: Record<string, string> = {};
				for (const issue of result.error.issues) {
					const path = issue.path.join('.') || '_root';
					if (fieldErrors[path]) {
						fieldErrors[path] += `; ${issue.message}`;
					} else {
						fieldErrors[path] = issue.message;
					}
				}
				throw new HttpError(
					400,
					Object.keys(fieldErrors).length === 1
						? Object.values(fieldErrors)[0]
						: 'Multiple validation errors',
					'VALIDATION_ERROR'
				);
			}

			// Store validated data with a source-specific key for type-safe access
			const key = source === 'body' ? 'validatedBody' : source === 'query' ? 'validatedQuery' : 'validatedParams';
			(req as unknown as Record<string, unknown>)[key] = result.data;
			next();
		} catch (err) {
			next(err instanceof Error ? err : new HttpError(400, 'Validation failed', 'VALIDATION_ERROR'));
		}
	};
}

export function uuidParam(paramName: string) {
	const schema = z.object({ [paramName]: z.string().uuid(`Invalid ${paramName}: must be a UUID`) });
	return validate(schema, 'params');
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
	const result = schema.safeParse(data);
	if (!result.success) {
		const fieldErrors: Record<string, string> = {};
		for (const issue of result.error.issues) {
			const path = issue.path.join('.') || '_root';
			fieldErrors[path] = issue.message;
		}
		const err = new Error(JSON.stringify(fieldErrors)) as Error & { statusCode: number };
		err.name = 'ValidationError';
		err.statusCode = 400;
		throw err;
	}
	return result.data;
}

export function getValidatedData<T>(req: Request): T {
	return (req as unknown as Record<string, unknown>).validatedData as T;
}
