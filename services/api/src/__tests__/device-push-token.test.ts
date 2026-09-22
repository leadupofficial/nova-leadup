/**
 * `/device/register` is the only writer of the `devices` table, and the push
 * token it stores is the only thing that decides whether a proactive nudge can
 * reach the phone.
 *
 * The `push_token` column, and the admin console's `hasPushToken`, both existed
 * while no route accepted a token — so a real phone reported "no push token"
 * forever and FCM was never called. The subtle half is the second test: the app
 * re-registers on every launch, and most launches carry no token because FCM only
 * hands one over once, so an unconditional write would erase a good token.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getTableName } from 'drizzle-orm';

import './setup.js';
import app from '../server.js';
import { getDb } from '../db/connection.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';

const JWT_SECRET = process.env.JWT_SECRET!;
const USER = '33333333-3333-4333-8333-333333333333';
const PUSH_TOKEN = 'fcm-registration-token-for-this-installation-0001';

function authHeader(): Record<string, string> {
  const token = jwt.sign({ sub: USER, email: 'push@example.com', role: 'user' }, JWT_SECRET, {
    expiresIn: '1h',
  });
  return { Authorization: `Bearer ${token}` };
}

/**
 * `makeFilteringDb`'s insert does not implement `ON CONFLICT DO UPDATE` — it
 * returns the chain unchanged — so the route's upsert would silently become an
 * append and the "the token survives" assertion would pass for the wrong reason.
 * This models the real contract: conflict on `installation_id`, then apply `set`.
 */
function useDb(seed: Record<string, Row[]> = {}): Record<string, Row[]> {
  const base = makeFilteringDb(seed);
  const store = base.store;

  const insert = (table: unknown) => {
    const name = getTableName(table as never);
    let values: Row[] = [];
    let conflictSet: Row | null = null;
    let executed: Row[] | null = null;

    const run = (): Row[] => {
      if (executed) return executed;
      const written: Row[] = [];
      for (const value of values) {
        const rows = store[name] ?? [];
        const existing = rows.find(
          (row) => row.installationId === value.installationId,
        );
        if (existing) {
          if (conflictSet) Object.assign(existing, conflictSet);
          written.push(existing);
          continue;
        }
        const row = { id: `${name}-${rows.length + 1}`, ...value };
        store[name] = [...rows, row];
        written.push(row);
      }
      executed = written;
      return written;
    };

    const chain: Record<string, unknown> = {
      values: (value: Row | Row[]) => {
        values = Array.isArray(value) ? value : [value];
        return chain;
      },
      onConflictDoUpdate: (arg: { set?: Row }) => {
        conflictSet = arg?.set ?? {};
        return chain;
      },
      returning: () => Promise.resolve(run()),
    };
    chain.then = (ok: unknown, no: unknown) =>
      Promise.resolve(run()).then(ok as never, no as never);
    chain.catch = (no: unknown) => Promise.resolve(run()).catch(no as never);
    return chain;
  };

  vi.mocked(getDb).mockReturnValue({
    ...(base.db as unknown as Record<string, unknown>),
    insert,
  } as unknown as ReturnType<typeof getDb>);
  return store;
}

describe('device registration stores a push token', () => {
  let store: Record<string, Row[]>;
  const installationId = 'install-push-token-test-0001';

  beforeEach(() => {
    store = useDb();
  });

  const readBack = async (): Promise<boolean> => {
    const res = await request(app)
      .get(`/api/v1/device/register?installationId=${installationId}`)
      .set(authHeader());
    expect(res.status).toBe(200);
    return res.body.data.device.hasPushToken as boolean;
  };

  it('records the token and says so on the same response', async () => {
    const res = await request(app)
      .post('/api/v1/device/register')
      .set(authHeader())
      .send({ installationId, platform: 'android', model: 'LE2101', pushToken: PUSH_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.data.recorded.hasPushToken).toBe(true);
    expect(await readBack()).toBe(true);
    expect(store.devices?.[0]?.pushToken).toBe(PUSH_TOKEN);
  });

  it('keeps the stored token when a later launch re-registers without one', async () => {
    await request(app)
      .post('/api/v1/device/register')
      .set(authHeader())
      .send({ installationId, platform: 'android', pushToken: PUSH_TOKEN });

    const res = await request(app)
      .post('/api/v1/device/register')
      .set(authHeader())
      .send({ installationId, platform: 'android', model: 'LE2101' });

    expect(res.status).toBe(200);
    expect(res.body.data.recorded.hasPushToken).toBe(false);
    expect(await readBack()).toBe(true);
  });

  it('clears the token when the client reports it is dead', async () => {
    await request(app)
      .post('/api/v1/device/register')
      .set(authHeader())
      .send({ installationId, platform: 'android', pushToken: PUSH_TOKEN });

    await request(app)
      .post('/api/v1/device/register')
      .set(authHeader())
      .send({ installationId, platform: 'android', pushToken: '' });

    expect(await readBack()).toBe(false);
  });

  it('never sends the token back to the client', async () => {
    await request(app)
      .post('/api/v1/device/register')
      .set(authHeader())
      .send({ installationId, platform: 'android', pushToken: PUSH_TOKEN });

    const res = await request(app)
      .get(`/api/v1/device/register?installationId=${installationId}`)
      .set(authHeader());

    expect(JSON.stringify(res.body)).not.toContain(PUSH_TOKEN);
  });

	it('tolerates a field from a newer client instead of refusing the device', async () => {
		// A client updates on its own schedule. With `.strict()`, the app's new
		// `pushToken` field was a 400 against a server one version behind, so
		// registration failed outright and push stopped working — measured against
		// the deployed build. An unknown key is ignored; a bad known value is not.
		const res = await request(app)
			.post('/api/v1/device/register')
			.set(authHeader())
			.send({
				installationId,
				platform: 'android',
				pushToken: PUSH_TOKEN,
				somethingFromTheFuture: 'v2-field',
			});

		expect(res.status).toBe(200);
		expect(res.body.data.recorded.hasPushToken).toBe(true);
		expect(await readBack()).toBe(true);
	});

	it('still refuses a known field with a bad value', async () => {
		const res = await request(app)
			.post('/api/v1/device/register')
			.set(authHeader())
			.send({ installationId: 'short', platform: 'android' });

		expect(res.status).toBe(400);
	});
});
