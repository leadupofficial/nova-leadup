/**
 * NOVA API — Tasks routes tests.
 *
 * Covers: POST /api/v1/tasks, GET /api/v1/tasks, DELETE /api/v1/tasks/:id
 */
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
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

const VALID_TASK_ID = uuidv4();
const OTHER_TASK_ID = uuidv4();

describe('POST /api/v1/tasks', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/v1/tasks').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });

  it('creates a task for the authenticated user', async () => {
    const token = createToken();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Test task', description: 'Description' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Test task');
    expect(res.body.userId).toBe('user-123');
  });
});

describe('GET /api/v1/tasks', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(401);
  });

  it('returns only tasks for the authenticated user', async () => {
    const token = createToken();
    const res = await request(app).get('/api/v1/tasks').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
    for (const task of res.body.tasks) {
      expect(task.userId).toBe('user-123');
    }
  });
});

describe('DELETE /api/v1/tasks/:id', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).delete(`/api/v1/tasks/${VALID_TASK_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the task belongs to another user', async () => {
    // Token for a different user
    const otherToken = createToken({ sub: 'other-user', email: 'other@example.com', role: 'user' });
    // The task ID that belongs to user-123
    const res = await request(app)
      .delete(`/api/v1/tasks/${VALID_TASK_ID}`)
      .set(authHeader(otherToken));
    expect(res.status).toBe(403);
  });

  it('deletes the task when it belongs to the authenticated user', async () => {
    const token = createToken();
    const res = await request(app)
      .delete(`/api/v1/tasks/${OTHER_TASK_ID}`)
      .set(authHeader(token));
    expect(res.status).toBe(204);
  });
});
