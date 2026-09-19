import type { Response } from 'express';
import { HttpError } from '../middleware.js';

export function problem(status: number, title: string, code: string, detail?: string): HttpError {
	const err = new HttpError(status, title) as HttpError & { code?: string; detail?: string };
	err.code = code;
	err.detail = detail;
	return err;
}
