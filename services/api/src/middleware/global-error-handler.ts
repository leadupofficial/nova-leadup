import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

export interface ApiError extends Error {
	statusCode?: number;
	isOperational?: boolean;
}

export class AppError extends Error {
	public statusCode: number;
	public isOperational: boolean;

	constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
		super(message);
		this.statusCode = statusCode;
		this.isOperational = isOperational;

		Error.captureStackTrace(this, this.constructor);
	}
}

const errorHandler = (
	err: ApiError,
	req: Request,
	res: Response,
	_next: NextFunction,
) => {
	let statusCode = err.statusCode || 500;
	let message = err.message || 'Internal Server Error';

	// Zod validation error
	if (err instanceof ZodError) {
		statusCode = 400;
		message = 'Validation failed';
		const details = err.errors.map((e) => ({
			path: e.path.join('.'),
			message: e.message,
		}));
		logger.warn(`Validation error: ${JSON.stringify(details)}`);
		return res.status(statusCode).json({
			success: false,
			error: message,
			...(process.env.NODE_ENV === 'development' && { details }),
		});
	}

	// JWT errors
	if (err.name === 'JsonWebTokenError') {
		statusCode = 401;
		message = 'Invalid token';
	} else if (err.name === 'TokenExpiredError') {
		statusCode = 401;
		message = 'Token expired';
	}

	// Prisma errors
	if (err.name === 'PrismaClientKnownRequestError') {
		if ((err as any).code === 'P2002') {
			statusCode = 409;
			message = 'Resource already exists';
		} else if ((err as any).code === 'P2025') {
			statusCode = 404;
			message = 'Resource not found';
		}
	}

	// Log full error server-side
	logger.error(
		{
			error: err.message,
			stack: err.stack,
			path: req.path,
			method: req.method,
			statusCode,
		},
		'Unhandled error',
	);

	// Never leak stack traces in production
	const response: any = {
		success: false,
		error: message,
	};

	if (process.env.NODE_ENV === 'development') {
		response.stack = err.stack;
	}

	res.status(statusCode).json(response);
};

export { errorHandler };
