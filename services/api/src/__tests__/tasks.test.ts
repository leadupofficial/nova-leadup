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
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';

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

describe('task priority', () => {
  // Regression: the API required, validated and accepted `priority`, then
  // dropped it before the INSERT because `tasks` had no such column. The
  // in-memory builder echoes the inserted `values`, so these assertions fail
  // if the route ever omits the field again.
  it('persists the priority sent on create', async () => {
    const token = createToken();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Urgent task', priority: 'urgent', status: 'pending' });
    expect(res.status).toBe(201);
    expect(res.body.data.priority).toBe('urgent');
  });

  it('rejects an invalid priority on create', async () => {
    const token = createToken();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Bad priority', priority: 'super-urgent', status: 'pending' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  it('updates the priority of an existing task', async () => {
    const token = createToken();
    const res = await request(app)
      .patch(`/api/v1/tasks/${VALID_TASK_ID}`)
      .set(authHeader(token))
      .send({ priority: 'low' });
    expect(res.status).toBe(200);
    expect(res.body.data.priority).toBe('low');
  });

  it('rejects an invalid priority on update', async () => {
    const token = createToken();
    const res = await request(app)
      .patch(`/api/v1/tasks/${VALID_TASK_ID}`)
      .set(authHeader(token))
      .send({ priority: 'whenever' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  it('filters the list query by priority', async () => {
    // The shared in-memory builder ignores `where`, so the rows it returns can
    // never prove the predicate was applied. Capture the `where` Drizzle hands
    // the driver and stringify it with a real Postgres dialect instead.
    const captured: unknown[] = [];
    const capturingDb = {
      select: () => ({
        from: () => ({
          where: (where: unknown) => {
            captured.push(where);
            const chain: Record<string, unknown> = {
              orderBy: () => chain,
              limit: () => Promise.resolve([]),
              then: (onFulfilled?: unknown, onRejected?: unknown) =>
                Promise.resolve([]).then(onFulfilled as never, onRejected as never),
              catch: (onRejected?: unknown) => Promise.resolve([]).catch(onRejected as never),
            };
            return chain;
          },
        }),
      }),
    } as unknown as ReturnType<typeof getDb>;
    vi.mocked(getDb).mockReturnValueOnce(capturingDb);

    const token = createToken();
    const res = await request(app)
      .get('/api/v1/tasks?priority=urgent')
      .set(authHeader(token));
    expect(res.status).toBe(200);

    const compiled = captured.map((where) => new PgDialect().sqlToQuery(where as never));
    const priorityQuery = compiled.find((c) => c.sql.includes('"priority"'));
    expect(priorityQuery).toBeDefined();
    expect(priorityQuery!.params).toContain('urgent');
  });
});

describe('task assignee', () => {
  // Regression: `CreateTaskSchema`/`UpdateTaskSchema`/`TaskListQuerySchema`
  // accepted `assigneeId`, the PATCH route copied it into the update payload,
  // and `tasks` had no such column — so Drizzle dropped it and the API answered
  // 200. The assignment was silently thrown away. These assertions fail if the
  // route stops passing the field to the insert/update, and the two
  // "does not exist" tests pin the foreign-key check the column now relies on.
  const ASSIGNEE_ID = uuidv4();

  it('persists the assignee sent on create', async () => {
    const token = createToken();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Delegated task', priority: 'medium', status: 'pending', assigneeId: ASSIGNEE_ID });
    expect(res.status).toBe(201);
    expect(res.body.data.assigneeId).toBe(ASSIGNEE_ID);
  });

  it('rejects an invalid assignee uuid on create', async () => {
    const token = createToken();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Bad assignee', priority: 'medium', status: 'pending', assigneeId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  it('rejects an assignee whose user does not exist on create', async () => {
    // The in-memory builder answers every `users` lookup with a fixture row, so
    // an explicit empty result is the only way to express "no such user".
    const noUsersDb = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    } as unknown as ReturnType<typeof getDb>;
    vi.mocked(getDb).mockReturnValueOnce(noUsersDb);

    const token = createToken();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set(authHeader(token))
      .send({ title: 'Dangling', priority: 'medium', status: 'pending', assigneeId: uuidv4() });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'ASSIGNEE_NOT_FOUND');
  });

  it('updates the assignee of an existing task', async () => {
    const token = createToken();
    const res = await request(app)
      .patch(`/api/v1/tasks/${VALID_TASK_ID}`)
      .set(authHeader(token))
      .send({ assigneeId: ASSIGNEE_ID });
    expect(res.status).toBe(200);
    expect(res.body.data.assigneeId).toBe(ASSIGNEE_ID);
  });

  it('clears the assignee when null is sent', async () => {
    const token = createToken();
    const res = await request(app)
      .patch(`/api/v1/tasks/${VALID_TASK_ID}`)
      .set(authHeader(token))
      .send({ assigneeId: null });
    expect(res.status).toBe(200);
    expect(res.body.data.assigneeId).toBeNull();
  });

  it('rejects an assignee that does not exist on update', async () => {
    const existingTask = { id: VALID_TASK_ID, userId: 'user-123', title: 'Existing', status: 'pending' };
    const missingAssigneeDb = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              Promise.resolve(getTableName(table as never) === 'users' ? [] : [existingTask]),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof getDb>;
    vi.mocked(getDb).mockReturnValueOnce(missingAssigneeDb);

    const token = createToken();
    const res = await request(app)
      .patch(`/api/v1/tasks/${VALID_TASK_ID}`)
      .set(authHeader(token))
      .send({ assigneeId: uuidv4() });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'ASSIGNEE_NOT_FOUND');
  });

  it('filters the list query by assignee', async () => {
    // Same approach as the priority filter test: capture the `where` Drizzle
    // builds and compile it with a real Postgres dialect, because the shared
    // builder ignores predicates.
    const captured: unknown[] = [];
    const capturingDb = {
      select: () => ({
        from: () => ({
          where: (where: unknown) => {
            captured.push(where);
            const chain: Record<string, unknown> = {
              orderBy: () => chain,
              limit: () => Promise.resolve([]),
              then: (onFulfilled?: unknown, onRejected?: unknown) =>
                Promise.resolve([]).then(onFulfilled as never, onRejected as never),
              catch: (onRejected?: unknown) => Promise.resolve([]).catch(onRejected as never),
            };
            return chain;
          },
        }),
      }),
    } as unknown as ReturnType<typeof getDb>;
    vi.mocked(getDb).mockReturnValueOnce(capturingDb);

    const token = createToken();
    const res = await request(app)
      .get(`/api/v1/tasks?assigneeId=${ASSIGNEE_ID}`)
      .set(authHeader(token));
    expect(res.status).toBe(200);

    const compiled = captured.map((where) => new PgDialect().sqlToQuery(where as never));
    const assigneeQuery = compiled.find((c) => c.sql.includes('"assignee_id"'));
    expect(assigneeQuery).toBeDefined();
    expect(assigneeQuery!.params).toContain(ASSIGNEE_ID);
  });

  it('rejects an invalid assignee uuid in the list filter', async () => {
    const token = createToken();
    const res = await request(app)
      .get('/api/v1/tasks?assigneeId=not-a-uuid')
      .set(authHeader(token));
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });
});
