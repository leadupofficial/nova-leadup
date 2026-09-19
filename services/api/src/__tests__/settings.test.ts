/**
 * NOVA API — Settings routes tests.
 *
 * Covers: GET /api/v1/settings, PUT /api/v1/settings
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';

import app from '../server.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

function createToken(
  payload: Record<string, unknown> = { sub: 'user-123', email: 'test@example.com', role: 'user' },
): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('GET /api/v1/settings', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/settings');
    expect(res.status).toBe(401);
  });

  it('returns 200 with the authenticated user settings', async () => {
    const token = createToken();
    const res = await request(app).get('/api/v1/settings').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-123');
    expect(res.body.settings).toBeDefined();
  });
});

describe('PUT /api/v1/settings', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).put('/api/v1/settings').send({ theme: 'dark' });
    expect(res.status).toBe(401);
  });

  it('updates settings for the authenticated user', async () => {
    const token = createToken();
    const res = await request(app)
      .put('/api/v1/settings')
      .set(authHeader(token))
      .send({ theme: 'dark', language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-123');
    expect(res.body.settings.theme).toBe('dark');
    expect(res.body.settings.language).toBe('en');
  });

  it('ignores userId in the request body and uses the authenticated user', async () => {
    const token = createToken();
    const res = await request(app)
      .put('/api/v1/settings')
      .set(authHeader(token))
      .send({ userId: 'other-user-id', theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-123');
  });
});
