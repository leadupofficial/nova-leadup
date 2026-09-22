/**
 * Centralized error handling for NOVA Leadup
 */

export interface ApiErrorResponse {
 error: string;
 message: string;
 statusCode: number;
 details?: Record<string, string[]>;
 timestamp: string;
 path?: string;
}

export class AppError extends Error {
 public readonly statusCode: number;
 public readonly isOperational: boolean;
 public readonly details?: Record<string, string[]>;

 constructor(
 message: string,
 statusCode: number,
 isOperational = true,
 details?: Record<string, string[]>
 ) {
 super(message);
 this.name = this.constructor.name;
 this.statusCode = statusCode;
 this.isOperational = isOperational;
 this.details = details;

 Error.captureStackTrace(this, this.constructor);
 }
}

export class ValidationError extends AppError {
 constructor(message: string, details?: Record<string, string[]>) {
 super(message, 400, true, details);
 }
}

export class AuthenticationError extends AppError {
 constructor(message = 'Authentication required') {
 super(message, 401, true);
 }
}

export class AuthorizationError extends AppError {
 constructor(message = 'Insufficient permissions') {
 super(message, 403, true);
 }
}

export class NotFoundError extends AppError {
 constructor(message = 'Resource not found') {
 super(message, 404, true);
 }
}

export class ConflictError extends AppError {
 constructor(message = 'Resource conflict') {
 super(message, 409, true);
 }
}

export class RateLimitError extends AppError {
 constructor(message = 'Too many requests, please try again later') {
 super(message, 429, true);
 }
}

export class InternalServerError extends AppError {
 constructor(message = 'An internal server error occurred') {
 super(message, 500, false);
 }
}

/**
 * Formats an error into a standardized API response
 */
export function formatErrorResponse(
 error: unknown,
 path?: string
 ): ApiErrorResponse {
 if (error instanceof AppError) {
 return {
 error: error.name,
 message: error.message,
 statusCode: error.statusCode,
 details: error.details,
 timestamp: new Date().toISOString(),
 path,
 };
 }

 if (error instanceof Error) {
 return {
 error: 'InternalServerError',
 message: 'An unexpected error occurred',
 statusCode: 500,
 timestamp: new Date().toISOString(),
 path,
 };
 }

 return {
 error: 'UnknownError',
 message: 'An unknown error occurred',
 statusCode: 500,
 timestamp: new Date().toISOString(),
 path,
 };
}

/**
 * Async error handler wrapper for route handlers
 */
export function asyncHandler<T extends (...args: any[]) => Promise<any>>(
 handler: T
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
 return async (...args: Parameters<T>) => {
 try {
 return await handler(...args);
 } catch (error) {
 throw error;
 }
 };
}

/**
 * Wraps an Express handler with async error handling
 */
export function asyncExpressHandler(
 handler: (req: any, res: any, next: any) => Promise<void>
) {
 return async (req: any, res: any, next: any) => {
 try {
 await handler(req, res, next);
 } catch (error) {
 next(error);
 }
 };
}
