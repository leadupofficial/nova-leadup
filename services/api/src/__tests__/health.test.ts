/**
 * NOVA API — Health endpoint tests.
 *
 * Covers: GET /health, GET /health/live, GET /health/ready, and security
 * headers set by the securityHeaders() middleware.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';

import app from '../server.js';

describe('GET /health', () => {
 it('returns status 200 with status "ok"', async () => {
 const res = await request(app).get('/health');
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('status', 'ok');
 });

 it('includes a timestamp', async () => {
 const res = await request(app).get('/health');
 expect(res.body).toHaveProperty('timestamp');
 expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
 });
});

describe('GET /health/live', () => {
 it('returns status 200 with status "alive"', async () => {
 const res = await request(app).get('/health/live');
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('status', 'alive');
 });

 it('includes a timestamp', async () => {
 const res = await request(app).get('/health/live');
 expect(res.body).toHaveProperty('timestamp');
 expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 });
});

describe('GET /health/ready', () => {
 it('returns status 200 with status "ready"', async () => {
 const res = await request(app).get('/health/ready');
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('status', 'ready');
 });

 it('includes a timestamp', async () => {
 const res = await request(app).get('/health/ready');
 expect(res.body).toHaveProperty('timestamp');
 expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 });
});

describe('security headers', () => {
 it('sets X-Content-Type-Options: nosniff on all responses', async () => {
 const endpoints = ['/health', '/health/live', '/health/ready'];
 for (const endpoint of endpoints) {
 const res = await request(app).get(endpoint);
 expect(res.headers['x-content-type-options']).toBe('nosniff');
 }
 });
});
