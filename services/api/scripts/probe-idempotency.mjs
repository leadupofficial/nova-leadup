#!/usr/bin/env node
/**
 * Independent verification that duplicate creates are absorbed.
 *
 * The fix for P0-5 was implemented elsewhere; this script exists so the claim can
 * be re-checked from outside, against the running API and the real database,
 * rather than taken from the implementation's own test output. It creates a fresh
 * account, fires concurrent and sequential duplicate creates, and counts rows
 * through the same REST route the app uses.
 *
 * It also asserts the negative space: genuinely different reminders must NOT be
 * absorbed. A dedupe that over-fires is worse than none, because the user's second
 * real reminder silently disappears.
 *
 * Usage: NOVA_API_BASE=http://127.0.0.1:3001 node services/api/scripts/probe-idempotency.mjs
 */
const BASE = process.env.NOVA_API_BASE || 'http://127.0.0.1:3001';

let token = '';
let failures = 0;

async function api(method, path, body) {
	const headers = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text.slice(0, 300) };
	}
	return { status: res.status, body: json };
}

function rowsOf(body) {
	const d = body?.data;
	if (Array.isArray(d)) return d;
	if (Array.isArray(d?.data)) return d.data;
	if (Array.isArray(d?.reminders)) return d.reminders;
	if (Array.isArray(d?.tasks)) return d.tasks;
	return [];
}

async function count(path) {
	const res = await api('GET', `${path}?limit=100`);
	// A counting helper that silently reads a rejected request as "no rows" is
	// how this probe first reported "0 created, expected 1" for every case,
	// including ones that plainly had. The list route caps `limit` at 100, and
	// `?limit=200` is a 400 — so the failure mode is easy to hit and looks like a
	// product bug. Refuse to count anything but a real 200.
	if (res.status !== 200) {
		throw new Error(`GET ${path} returned ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
	}
	return rowsOf(res.body).length;
}

function check(label, actual, expected) {
	const ok = actual === expected;
	if (!ok) failures += 1;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: got ${actual}, expected ${expected}`);
}

async function main() {
	const stamp = Date.now();
	const email = `idem-${stamp}@nova.test`;
	const password = 'ProbePassw0rd!2026';

	const reg = await api('POST', '/api/v1/auth/register', { email, password, name: 'Idempotency Probe' });
	if (reg.status >= 300) {
		console.error(`register failed: ${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}`);
		process.exit(1);
	}
	const login = await api('POST', '/api/v1/auth/login', { email, password });
	token = login.body?.data?.access_token ?? login.body?.access_token ?? '';
	if (!token) {
		console.error(`login failed: ${login.status}`);
		process.exit(1);
	}

	const at = new Date(Date.now() + 3600e3).toISOString();
	const title = 'Call the client about the website';

	console.log('\n[1] five concurrent identical POST /reminders');
	const before = await count('/api/v1/reminders');
	const results = await Promise.all(
		Array.from({ length: 5 }, () => api('POST', '/api/v1/reminders', { title, triggerAt: at })),
	);
	const after = await count('/api/v1/reminders');
	console.log(`  statuses: ${results.map((r) => r.status).join(',')}`);
	console.log(`  deduplicated flags: ${results.map((r) => r.body?.deduplicated).join(',')}`);
	check('rows created by 5 concurrent identical requests', after - before, 1);

	console.log('\n[2] same content again, sequential (a retry / a repeated voice ask)');
	const beforeSeq = await count('/api/v1/reminders');
	await api('POST', '/api/v1/reminders', { title, triggerAt: at });
	const afterSeq = await count('/api/v1/reminders');
	check('rows created by a sequential repeat', afterSeq - beforeSeq, 0);

	console.log('\n[3] negative space — these must all create a NEW row');
	const cases = [
		['different title, same time', { title: 'Call Kumar', triggerAt: at }],
		['same title, different time', { title, triggerAt: new Date(Date.now() + 7200e3).toISOString() }],
		['same title, 10 minutes later (outside the window)', { title, triggerAt: new Date(Date.now() + 600e3).toISOString() }],
	];
	for (const [label, body] of cases) {
		const b = await count('/api/v1/reminders');
		await api('POST', '/api/v1/reminders', body);
		const a = await count('/api/v1/reminders');
		check(label, a - b, 1);
	}

	console.log('\n[4] five concurrent identical POST /tasks');
	const tb = await count('/api/v1/tasks');
	await Promise.all(
		Array.from({ length: 5 }, () =>
			api('POST', '/api/v1/tasks', { title: 'Finish the website proposal', priority: 'high', status: 'pending' }),
		),
	);
	const ta = await count('/api/v1/tasks');
	check('tasks created by 5 concurrent identical requests', ta - tb, 1);

	console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'all checks passed'}`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
