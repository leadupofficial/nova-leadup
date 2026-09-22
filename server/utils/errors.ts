/**
 * Application error class and error factory
 */

export class AppError extends Error {
 public statusCode: number;
 public isOperational: boolean;
 public code?: string;

 constructor(message: string, statusCode: number, isOperational = false, code?: string) {
 super(message);
 this.statusCode = statusCode;
 this.isOperational = isOperational;
 this.code = code;

 Error.captureStackTrace(this, this.constructor);
 }
}

export function createError(message: string, statusCode: number, code?: string): AppError {
 return new AppError(message, statusCode, true, code);
}
