/**
 * NOVA API — Tasks routes tests.
 *
 * Covers: POST /api/v1/tasks, GET /api/v1/tasks, DELETE /api/v1/tasks/:id
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import './setup.js';

import app from '../server.js';
import { getDb } from '../db/connection.js';
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
    // `CreateTaskSchema` has no defaults for `priority` and `status`: a body
    // with only a title/description is a 400, which is what the mobile client
    // documents and works around by always sending both fields.
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Test task', description: 'Description', priority: 'medium', status: 'pending' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.data.title).toBe('Test task');
    expect(res.body.data.userId).toBe('user-123');
  });

  it('returns 400 when the required priority and status are missing', async () => {
    const token = createToken();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Test task', description: 'Description' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/tasks', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(401);
  });

  it('returns the paginated task envelope for the authenticated user', async () => {
    // The route answers `{ success, data: { tasks, pagination } }` — the shape
    // the Dart client reads (`data.tasks[]`, see
    // apps/mobile/lib/core/api/nova_api.dart). Per-user scoping happens in the
    // SQL `where` clause; this suite's in-memory query builder ignores `where`,
    // so it is not observable from here.
    const token = createToken();
    const res = await request(app).get('/api/v1/tasks').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(Array.isArray(res.body.data.tasks)).toBe(true);
    expect(res.body.data.pagination).toMatchObject({
      hasMore: expect.any(Boolean),
      limit: expect.any(Number),
      total: expect.any(Number),
    });
  });
});

describe('DELETE /api/v1/tasks/:id', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).delete(`/api/v1/tasks/${VALID_TASK_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 (not 403) when the task belongs to another user', async () => {
    // Every lookup is scoped by (id, userId) and answers 404 when the pair does
    // not match, so another user's task id is never confirmed to exist. A 403
    // would leak that the id is real. The shared in-memory query builder
    // ignores `where` and would report the fixture row as owned, so this one
    // override models the real ownership filter.
    const otherToken = createToken({ sub: 'other-user', email: 'other@example.com', role: 'user' });
    const noRowsDb = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    } as unknown as ReturnType<typeof getDb>;
    vi.mocked(getDb).mockReturnValueOnce(noRowsDb);

    const res = await request(app)
      .delete(`/api/v1/tasks/${VALID_TASK_ID}`)
      .set(authHeader(otherToken));
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');
  });

  it('deletes the task when it belongs to the authenticated user', async () => {
    const token = createToken();
    const res = await request(app)
      .delete(`/api/v1/tasks/${OTHER_TASK_ID}`)
      .set(authHeader(token));
    expect(res.status).toBe(204);
  });
});
