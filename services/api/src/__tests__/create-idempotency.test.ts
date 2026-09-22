/**
 * NOVA API — create idempotency for reminders and tasks (P0-5).
 *
 * Measured defect: five identical concurrent `POST /api/v1/reminders` produced
 * five rows, and two identical asks produced two reminders at the same
 * `triggerAt`, so NOVA notified the user twice about one intention.
 *
 * What these tests pin:
 *
 *   * a create retried inside 60 seconds returns the row that already exists,
 *     with `deduplicated: true` and HTTP 200, instead of filing a second one;
 *   * five *concurrent* identical creates still produce exactly one row, which
 *     is the half a "SELECT then INSERT" guard cannot do;
 *   * the window does not swallow a genuine second create: a different
 *     `triggerAt`, a different title, or the same title after the window are all
 *     separate rows;
 *   * a caller-supplied idempotency key absorbs a retry of the same request even
 *     after the window;
 *   * two users filing identical content do not collide with each other.
 *
 * ## What the database double models, and what it does not
 *
 * `makeCreateDb` enforces the contract the routes rely on and nothing else: the
 * unique index on `dedupe_key` plus `ON CONFLICT ... DO UPDATE` semantics (the
 * loser is handed the winner's row, flagged `deduplicated`). Its `INSERT` cannot
 * interleave with another, which is what one statement does on a real server.
 *
 * It deliberately does **not** model the `BEFORE INSERT` trigger from
 * `packages/database/drizzle/0005_curvy_maestro.sql`. That trigger also absorbs
 * a create whose `dedupe_key` was never computed (the assistant's tool
 * executor), and a double that emulated it would mask a route regression — the
 * suite would stay green after someone deleted the unique key from the route.
 * The trigger is exercised against a real Postgres instead; the branch it
 * produces (`INSERT` suppressed, so the route has to find the existing row) is
 * covered here with an explicitly suppressed insert.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getTableName } from 'drizzle-orm';
import './setup.js';

import app from '../server.js';
import { getDb } from '../db/connection.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';

const JWT_SECRET = process.env.JWT_SECRET!;
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

function createToken(sub = USER): string {
  return jwt.sign({ sub, email: 'test@example.com', role: 'user' }, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * The in-memory double from `helpers/tool-db.ts` (which honours `WHERE`) plus the
 * create-idempotency contract: a unique index on `dedupe_key` and the
 * `ON CONFLICT ... DO UPDATE` behaviour the routes depend on. See the file
 * header for what this deliberately leaves out.
 */
function makeCreateDb(seed: Record<string, Row[]> = {}): {
  db: ReturnType<typeof getDb>;
  store: Record<string, Row[]>;
} {
  const base = makeFilteringDb(seed);
  const store = base.store;

  const tableNameOf = (table: unknown): string => {
    try {
      return getTableName(table as never);
    } catch {
      return '';
    }
  };

  const insert = (table: unknown) => {
    const name = tableNameOf(table);
    let values: Row[] = [];
    let onConflict = false;
    let executed: Row[] | null = null;

    const run = (): Row[] => {
      if (executed) return executed;
      const written: Row[] = [];
      for (const value of values) {
        // The unique index: only rows that carry a key can conflict. A caller
        // that stops sending `dedupeKey` therefore files one row per request,
        // which is exactly the defect these tests must catch.
        const existing =
          value.dedupeKey === undefined || value.dedupeKey === null
            ? undefined
            : (store[name] ?? []).find((row) => row.dedupeKey === value.dedupeKey);

        if (existing) {
          // `ON CONFLICT DO UPDATE` — the winner's row comes back, flagged.
          if (onConflict) written.push({ ...existing, deduplicated: true });
          continue;
        }

        const row = { id: `${name}-${(store[name]?.length ?? 0) + 1}`, ...value };
        store[name] = [...(store[name] ?? []), row];
        written.push({ ...row, deduplicated: false });
      }
      executed = written;
      return written;
    };

    const chain: Record<string, unknown> = {
      values: (value: Row | Row[]) => {
        values = Array.isArray(value) ? value : [value];
        return chain;
      },
      onConflictDoUpdate: () => {
        onConflict = true;
        return chain;
      },
      onConflictDoNothing: () => {
        onConflict = false;
        return chain;
      },
      returning: () => Promise.resolve(run()),
    };
    chain.then = (ok: unknown, no: unknown) => Promise.resolve(run()).then(ok as never, no as never);
    chain.catch = (no: unknown) => Promise.resolve(run()).catch(no as never);
    return chain;
  };

  return {
    store,
    db: { ...(base.db as unknown as Record<string, unknown>), insert } as unknown as ReturnType<typeof getDb>,
  };
}

function useDb(seed: Record<string, Row[]> = {}): Record<string, Row[]> {
  const { db, store } = makeCreateDb(seed);
  vi.mocked(getDb).mockReturnValue(db);
  return store;
}

/**
 * A table whose `INSERT` is always suppressed, which is what the migration's
 * dedupe trigger does when the row was already filed by a writer that uses the
 * database's own key formula (the assistant's `create_reminder`).
 */
function suppressInserts(db: ReturnType<typeof getDb>): void {
  const chain: Record<string, unknown> = {};
  chain.values = () => chain;
  chain.onConflictDoUpdate = () => chain;
  chain.returning = () => Promise.resolve([]);
  chain.then = (ok: unknown, no: unknown) => Promise.resolve([]).then(ok as never, no as never);
  chain.catch = (no: unknown) => Promise.resolve([]).catch(no as never);
  (db as unknown as Record<string, unknown>).insert = () => chain;
}

const REMINDER_BODY = { title: 'Call Kumar', triggerAt: '2026-03-01T04:30:00.000Z' };
const TASK_BODY = { title: 'Send the invoice', priority: 'medium', status: 'pending' };

function postReminder(token: string, body: Record<string, unknown> = REMINDER_BODY, headers: Record<string, string> = {}) {
  return request(app).post('/api/v1/reminders').set(authHeader(token)).set(headers).send(body);
}

function postTask(token: string, body: Record<string, unknown> = TASK_BODY, headers: Record<string, string> = {}) {
  return request(app).post('/api/v1/tasks').set(authHeader(token)).set(headers).send(body);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/v1/reminders — concurrent identical creates', () => {
  it('files exactly one row and answers all five requests successfully', async () => {
    const store = useDb();
    const token = createToken();

    const responses = await Promise.all(Array.from({ length: 5 }, () => postReminder(token)));

    // Pre-fix this was five: every request did its own INSERT with nothing to
    // conflict against.
    expect(store.reminders ?? []).toHaveLength(1);

    for (const res of responses) {
      expect([200, 201]).toContain(res.status);
      expect(res.body).toMatchObject({ success: true });
    }

    // Exactly one create; the other four are told the create was absorbed
    // rather than silently handed a row.
    expect(responses.filter((res) => res.body.deduplicated === false)).toHaveLength(1);
    expect(responses.filter((res) => res.body.deduplicated === true)).toHaveLength(4);
    expect(new Set(responses.map((res) => res.body.data.id)).size).toBe(1);
  });

  it('still files one row for content that differs only in case and whitespace', async () => {
    const store = useDb();
    const token = createToken();

    const first = await postReminder(token, { ...REMINDER_BODY, title: 'Call Kumar' });
    const second = await postReminder(token, { ...REMINDER_BODY, title: '  call   KUMAR ' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(store.reminders).toHaveLength(1);
  });

  it('does not collapse the same content filed by two different users', async () => {
    const store = useDb();

    const mine = await postReminder(createToken(USER));
    const theirs = await postReminder(createToken(OTHER_USER));

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(store.reminders).toHaveLength(2);
    expect(store.reminders![1]!.userId).toBe(OTHER_USER);
  });
});

describe('POST /api/v1/reminders — the window is short', () => {
  it('files a second row when the same content arrives after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    const store = useDb();
    const token = createToken();

    const first = await postReminder(token);
    expect(first.status).toBe(201);

    // 61 seconds later — one full window past the first create.
    vi.setSystemTime(new Date('2026-03-01T10:01:01.000Z'));
    const second = await postReminder(token);

    expect(second.status).toBe(201);
    expect(second.body.deduplicated).toBe(false);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(store.reminders).toHaveLength(2);
  });

  it('files a second row when the same title is wanted at a different time', async () => {
    // "Call Kumar" today at 10:00 and again tomorrow at 10:00 are two separate
    // reminders. Absorbing the second would be a worse bug than the duplicate.
    const store = useDb();
    const token = createToken();

    const first = await postReminder(token, { ...REMINDER_BODY, triggerAt: '2026-03-01T04:30:00.000Z' });
    const second = await postReminder(token, { ...REMINDER_BODY, triggerAt: '2026-03-02T04:30:00.000Z' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.deduplicated).toBe(false);
    expect(store.reminders).toHaveLength(2);
  });

  it('files a second row for different content at the same time', async () => {
    const store = useDb();
    const token = createToken();

    const first = await postReminder(token, { ...REMINDER_BODY, title: 'Call Kumar' });
    const second = await postReminder(token, { ...REMINDER_BODY, title: 'Call Suresh' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(store.reminders).toHaveLength(2);
  });
});

describe('POST /api/v1/reminders — caller-supplied idempotency key', () => {
  it('absorbs a retry of the same request even after the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    const store = useDb();
    const token = createToken();
    const key = uuidv4();

    const first = await postReminder(token, REMINDER_BODY, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(first.body.deduplicated).toBe(false);

    // A retry of the *same* request is the same request, however late it lands.
    vi.setSystemTime(new Date('2026-03-01T10:22:00.000Z'));
    const retry = await postReminder(token, REMINDER_BODY, { 'Idempotency-Key': key });

    expect(retry.status).toBe(200);
    expect(retry.body.deduplicated).toBe(true);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(store.reminders).toHaveLength(1);
  });

  it('accepts the key in the body too, and keeps distinct keys distinct', async () => {
    const store = useDb();
    const token = createToken();

    const first = await postReminder(token, { ...REMINDER_BODY, idempotencyKey: 'turn-1' });
    const repeat = await postReminder(token, { ...REMINDER_BODY, idempotencyKey: 'turn-1' });
    const other = await postReminder(token, { ...REMINDER_BODY, idempotencyKey: 'turn-2' });

    expect(first.status).toBe(201);
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.id).toBe(first.body.data.id);
    expect(other.status).toBe(201);
    expect(store.reminders).toHaveLength(2);
  });
});

describe('POST /api/v1/reminders — the database suppressed the insert', () => {
  it('answers with the row that already exists instead of a failure', async () => {
    // The reminder was filed by the assistant, whose insert carries the
    // database's own key rather than this API's. The migration's trigger refuses
    // the duplicate, so `INSERT ... RETURNING` yields nothing and the route has
    // to find the row that is already there.
    const filedAt = new Date();
    const store = useDb({
      reminders: [
        {
          id: 'r-assistant',
          userId: USER,
          title: 'call kumar',
          triggerAt: new Date(REMINDER_BODY.triggerAt),
          timezone: 'Asia/Kolkata',
          dismissed: false,
          dedupeKey: 'the-database-computed-key',
          createdAt: filedAt,
        },
      ],
    });
    suppressInserts(vi.mocked(getDb)());

    const res = await postReminder(createToken());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, deduplicated: true });
    expect(res.body.data.id).toBe('r-assistant');
    expect(store.reminders).toHaveLength(1);
  });
});

describe('POST /api/v1/tasks — the same guards', () => {
  it('files exactly one row for five concurrent identical creates', async () => {
    const store = useDb();
    const token = createToken();

    const responses = await Promise.all(Array.from({ length: 5 }, () => postTask(token)));

    expect(store.tasks ?? []).toHaveLength(1);
    for (const res of responses) {
      expect([200, 201]).toContain(res.status);
      expect(res.body).toMatchObject({ success: true });
    }
    expect(responses.filter((res) => res.body.deduplicated === true)).toHaveLength(4);
    expect(new Set(responses.map((res) => res.body.data.id)).size).toBe(1);
  });

  it('files a second task after the window and for different content', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    const store = useDb();
    const token = createToken();

    const first = await postTask(token);
    const different = await postTask(token, { ...TASK_BODY, title: 'Send the receipts' });

    vi.setSystemTime(new Date('2026-03-01T10:01:01.000Z'));
    const afterWindow = await postTask(token);

    expect(first.status).toBe(201);
    expect(different.status).toBe(201);
    expect(afterWindow.status).toBe(201);
    expect(store.tasks).toHaveLength(3);
  });

  it('absorbs a retry carrying the same idempotency key', async () => {
    const store = useDb();
    const token = createToken();
    const key = uuidv4();

    const first = await postTask(token, TASK_BODY, { 'Idempotency-Key': key });
    const retry = await postTask(token, TASK_BODY, { 'Idempotency-Key': key });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ success: true, deduplicated: true });
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(store.tasks).toHaveLength(1);
  });

  it('answers with the existing task when the database suppressed the insert', async () => {
    const store = useDb({
      tasks: [
        {
          id: 't-assistant',
          userId: USER,
          title: 'send the invoice',
          status: 'pending',
          priority: 'medium',
          dedupeKey: 'the-database-computed-key',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    suppressInserts(vi.mocked(getDb)());

    const res = await postTask(createToken());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, deduplicated: true });
    expect(res.body.data.id).toBe('t-assistant');
    expect(store.tasks).toHaveLength(1);
  });
});
