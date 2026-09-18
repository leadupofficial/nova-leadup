/**
 * NOVA API — Error-handler middleware tests.
 *
 * Covers: HttpError, ZodError, generic Error, and RFC 7807 ProblemDetails format.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import request from 'supertest';
import { errorHandler, HttpError } from '../middleware/error-handler.js';
import express from 'express';

function createApp(): express.Express {
 const app: ReturnType<typeof express> = express();

 app.get('/http-error', (_req, _res, next) => next(new HttpError(404, 'Resource not found', 'NOT_FOUND')));

 const schema = z.object({ name: z.string(), age: z.number() });
 app.get('/zod-error', (_req, _res, next) => {
 try {
 schema.parse({ name: 'Alice' });
 } catch (err) {
 next(err);
 }
 });

 app.get('/generic-error', (_req, _res, next) => next(new Error('Something broke')));

 app.get('/generic-status-error', (_req, _res, next) => {
 const err = new Error('Bad input') as Error & { statusCode?: number };
 err.statusCode = 422;
 next(err);
 });

 app.use(errorHandler);
 return app;
}

describe('errorHandler middleware', () => {
 describe('HttpError', () => {
 it('returns the status code from the HttpError', async () => {
 const res = await request(createApp()).get('/http-error');
 expect(res.status).toBe(404);
 expect(res.body.title).toBe('Resource not found');
 expect(res.body.status).toBe(404);
 expect(res.body.detail).toBe('Resource not found');
 expect(res.body.instance).toBe('/http-error');
 expect(res.body.type).toBe('https://api.nova.leadup.in/problems/not_found');
 });

 it('uses the HttpError message as the title for 4xx errors', async () => {
 const res = await request(createApp()).get('/http-error');
 expect(res.body.title).toBe('Resource not found');
 expect(res.body.status).toBe(404);
 expect(res.body.detail).toBe('Resource not found');
 });

 it('uses the HttpError code in the type URL', async () => {
 const res = await request(createApp()).get('/http-error');
 expect(res.body.type).toBe('https://api.nova.leadup.in/problems/not_found');
 });

 it('includes the request path as the instance field', async () => {
 const res = await request(createApp()).get('/http-error');
 expect(res.body.instance).toBe('/http-error');
 });
 });

 describe('ZodError', () => {
 it('returns status 400', async () => {
 const res = await request(createApp()).get('/zod-error');
 expect(res.status).toBe(400);
 });

 it('returns title "Validation Error"', async () => {
 const res = await request(createApp()).get('/zod-error');
 expect(res.body.title).toBe('Validation Error');
 });

 it('includes an errors array with field-level details', async () => {
 const res = await request(createApp()).get('/zod-error');
 expect(res.body).toHaveProperty('errors');
 expect(Array.isArray(res.body.errors)).toBe(true);
 const paths = (res.body.errors as Array<{ path: string }>).map((e: { path: string }) => e.path);
 expect(paths).toContain('age');
 });
 });

 describe('generic Error (non-operational)', () => {
 it('returns status 500', async () => {
 const res = await request(createApp()).get('/generic-error');
 expect(res.status).toBe(500);
 });

 it('hides the raw error message and returns "Internal Server Error"', async () => {
 const res = await request(createApp()).get('/generic-error');
 expect(res.body.title).toBe('Internal Server Error');
 expect(res.body.detail).toBe('Something broke');
 });
 });

 describe('generic Error with custom statusCode', () => {
 it('returns the custom status code', async () => {
 const res = await request(createApp()).get('/generic-status-error');
 expect(res.status).toBe(422);
 });

 it('uses the error message as title for 4xx', async () => {
 const res = await request(createApp()).get('/generic-status-error');
 expect(res.body.title).toBe('Bad input');
 expect(res.body.detail).toBe('Bad input');
 });
 });

 describe('RFC 7807 ProblemDetails format', () => {
 it('all error responses contain the required type, title, status, detail fields', async () => {
 const paths = ['/http-error', '/zod-error', '/generic-error'];
 for (const path of paths) {
 const res = await request(createApp()).get(path);
 expect(res.body).toHaveProperty('type');
 expect(res.body).toHaveProperty('title');
 expect(res.body).toHaveProperty('status');
 expect(res.body).toHaveProperty('detail');
 expect(res.body).toHaveProperty('instance');
 }
 });

 it('uses the correct problem-details URI for each error code', async () => {
 const res = await request(createApp()).get('/http-error');
 expect(res.body.type).toBe('https://api.nova.leadup.in/problems/not_found');

 const zodRes = await request(createApp()).get('/zod-error');
 expect(zodRes.body.type).toBe('https://api.nova.leadup.in/problems/validation-error');
 });
 });
});
