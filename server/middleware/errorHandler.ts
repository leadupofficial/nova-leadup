import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

export class AppError extends Error {
 constructor(
 message: string,
 statusCode: number = 500,
 code?: string,
 isOperational: boolean = true
 ) {
 super(message);
 this.statusCode = statusCode;
 this.code = code;
 this.isOperational = isOperational;

 Error.captureStackTrace(this, this.constructor);
 }

 statusCode: number;
 code?: string;
 isOperational: boolean;
}

export function globalErrorHandler(
 err: Error,
 req: Request,
 res: Response,
 next: NextFunction
) {
 let statusCode = 500;
 let message = 'Internal server error';
 let code = 'INTERNAL_ERROR';

 // Handle custom AppError
 if (err instanceof AppError) {
 statusCode = err.statusCode;
 message = err.message;
 code = err.code || 'APP_ERROR';
 } else if (err.name === 'ValidationError') {
 // Mongoose validation error
 statusCode = 400;
 message = 'Validation error';
 code = 'VALIDATION_ERROR';
 } else if (err.name === 'CastError') {
 // MongoDB cast error
 statusCode = 400;
 message = 'Invalid ID format';
 code = 'INVALID_ID';
 } else if (err.name === 'JsonWebTokenError') {
 statusCode = 401;
 message = 'Invalid token';
 code = 'INVALID_TOKEN';
 } else if (err.name === 'TokenExpiredError') {
 statusCode = 401;
 message = 'Token expired';
 code = 'TOKEN_EXPIRED';
 } else if ((err as any).code === '23505') {
 // PostgreSQL unique constraint violation
 statusCode = 409;
 message = 'Resource already exists';
 code = 'DUPLICATE_ENTRY';
 } else if ((err as any).code === '23503') {
 // PostgreSQL foreign key constraint violation
 statusCode = 400;
 message = 'Referenced resource not found';
 code = 'INVALID_REFERENCE';
 } else if ((err as any).code === '23502') {
 // PostgreSQL not null violation
 statusCode = 400;
 message = 'Required field is missing';
 code = 'MISSING_FIELD';
 }

 // Log error details (full details for operational errors)
 const errorDetails = {
 name: err.name,
 message: err.message,
 code: code,
 statusCode,
 stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
 url: req.originalUrl,
 method: req.method,
 ip: req.ip,
 userId: (req as any).user?.id || 'anonymous',
 };

 if (statusCode >= 500) {
 logger.error('Server error:', errorDetails);
 } else if (statusCode >= 400) {
 logger.warn('Client error:', errorDetails);
 }

 // In production, don't send error details to client
 const response: any = {
 success: false,
 message: statusCode >= 500 && process.env.NODE_ENV === 'production'
 ? 'Internal server error'
 : message,
 code,
 };

 // Only include error details in development
 if (process.env.NODE_ENV === 'development') {
 response.error = {
 name: err.name,
 message: err.message,
 stack: err.stack,
 };
 }

 res.status(statusCode).json(response);
}

export function notFoundHandler(req: Request, res: Response) {
 res.status(404).json({
 success: false,
 message: 'Route ' + req.originalUrl + ' not found',
 code: 'ROUTE_NOT_FOUND',
 });
}

export function asyncHandler(fn: Function) {
 return (req: Request, res: Response, next: NextFunction) => {
 Promise.resolve(fn(req, res, next)).catch(next);
 };
}

export async function cleanupConnections() {
 try {
 await pool.end();
 logger.info('Database connections closed');
 } catch (error) {
 logger.error('Error closing database connections:', error);
 }
}

export function setupProcessErrorHandlers(server: any) {
 process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
 logger.error('Unhandled Rejection at:', promise, 'reason:', reason);

 // Graceful shutdown
 server.close(() => {
 process.exit(1);
 });

 setTimeout(() => {
 process.exit(1);
 }, 5000);
 });

 process.on('uncaughtException', (error: Error) => {
 logger.error('Uncaught Exception:', error);

 // Graceful shutdown
 server.close(() => {
 process.exit(1);
 });

 setTimeout(() => {
 process.exit(1);
 }, 5000);
 });
}