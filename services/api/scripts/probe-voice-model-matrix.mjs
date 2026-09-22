#!/usr/bin/env node
/**
 * Live voice-model matrix probe.
 *
 * Answers one question with evidence rather than opinion: **which model should the
 * spoken path use?** A model is only a candidate if it (a) answers fast enough to
 * feel like a conversation, (b) calls the right tool for a spoken request, (c)
 * actually produces Tamil/Tanglish prose rather than English, and (d) does not act
 * when the user only wanted advice.
 *
 * It drives the REAL `/api/v1/voice/chat` route against whatever model the running
 * API is configured with — it does not reimplement the pipeline, because a
 * reimplementation would not be evidence about the product. The model under test is
 * therefore selected by restarting the API with `ANTHROPIC_MODEL=<id>`, and this
 * script's job is only to observe.
 *
 * The observable outcomes are deliberately not "did it reply": each prompt states
 * what a correct turn must change in the database, and the script diffs the database
 * before and after through the same REST routes the app uses.
 *
 * Usage:
 *   NOVA_API_BASE=http://127.0.0.1:3001 PROBE_LABEL=glm-5.3 \
 *     node services/api/scripts/probe-voice-model-matrix.mjs
 */

const BASE = process.env.NOVA_API_BASE || 'http://127.0.0.1:3001';
const LABEL = process.env.PROBE_LABEL || process.env.ANTHROPIC_MODEL || 'unknown';
const OUT = process.env.PROBE_OUT || '';

let token = '';
let failures = 0;

async function api(method, path, body, { auth = true } = {}) {
	const headers = { 'content-type': 'application/json' };
	if (auth && token) headers.authorization = `Bearer ${token}`;
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
		json = { raw: text.slice(0, 400) };
	}
	return { status: res.status, body: json };
}

function rowsOf(body) {
	const d = body?.data;
	if (Array.isArray(d)) return d;
	if (Array.isArray(d?.data)) return d.data;
	if (Array.isArray(d?.reminders)) return d.reminders;
	if (Array.isArray(d?.tasks)) return d.tasks;
	if (Array.isArray(d?.memories)) return d.memories;
	return [];
}

async function state() {
	const [r, t, m] = await Promise.all([
		api('GET', '/api/v1/reminders?limit=100'),
		api('GET', '/api/v1/tasks?limit=100'),
		api('GET', '/api/v1/memories?limit=100'),
	]);
	return {
		reminders: rowsOf(r.body).map((x) => ({ id: x.id, title: x.title, at: x.triggerAt })),
		tasks: rowsOf(t.body).map((x) => ({ id: x.id, title: x.title, status: x.status })),
		memories: rowsOf(m.body).map((x) => ({ id: x.id, content: x.content, status: x.status })),
	};
}

const iso = (d) => d.toISOString();

async function seed() {
	const now = Date.now();
	const seeds = [
		['POST', '/api/v1/reminders', { title: 'Call the client about the website', triggerAt: iso(new Date(now + 26 * 3600e3)) }],
		['POST', '/api/v1/reminders', { title: 'Pay the plumber', triggerAt: iso(new Date(now + 3 * 3600e3)) }],
		['POST', '/api/v1/tasks', { title: 'Finish the website proposal', priority: 'high', status: 'pending' }],
		['POST', '/api/v1/tasks', { title: 'Send the invoice to ABC', priority: 'medium', status: 'pending' }],
		['POST', '/api/v1/memories', { content: 'My preferred time for daily planning is 9 AM', category: 'preference', sourceType: 'manual', importance: 70 }],
	];
	for (const [m, p, b] of seeds) {
		const res = await api(m, p, b);
		if (res.status >= 300) {
			console.error(`seed failed ${p}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
			failures += 1;
		}
	}
}

/**
 * One probe: what the user says, and what must be true afterwards.
 *
 * `expect` is checked against the BEFORE/AFTER diff, so a model that merely *says*
 * it set a reminder is not credited.
 */
function probes() {
	return [
		{
			id: 'en-action',
			language: 'en',
			said: 'Remind me to call Kumar tomorrow at 11 in the morning.',
			expect: 'a new reminder appears',
			check: (d) => d.reminders.added.length >= 1,
		},
		{
			id: 'tanglish-action',
			language: 'tanglish',
			said: 'NOVA நாளைக்கு காலை அந்த client-க்கு call பண்ணணும், remind பண்ணு.',
			expect: 'a new reminder appears',
			check: (d) => d.reminders.added.length >= 1,
		},
		{
			id: 'tanglish-query',
			language: 'tanglish',
			said: 'இன்னைக்கு என்ன pending இருக்கு?',
			expect: 'no write; names real pending work in Tamil/Tanglish',
			check: (d) => d.reminders.added.length === 0 && d.tasks.changed.length === 0,
		},
		{
			id: 'tamil-modify',
			language: 'tanglish',
			said: 'அந்த plumber reminder-ஐ eveningக்கு மாற்று.',
			expect: 'the plumber reminder moves; no duplicate is created',
			check: (d) => d.reminders.added.length === 0,
		},
		{
			id: 'advice-no-action',
			language: 'en',
			said: 'I have three important things tomorrow and I am not sure how to organize them. What do you suggest?',
			expect: 'advice only — NO task and NO reminder is created',
			check: (d) => d.reminders.added.length === 0 && d.tasks.added.length === 0,
		},
		{
			id: 'task-complete',
			language: 'en',
			said: 'I finished the website proposal.',
			expect: 'the matching task becomes completed',
			check: (d) => d.tasks.changed.some((c) => c.after.status === 'completed'),
		},
	];
}

const tamilRe = /[\u0B80-\u0BFF]/;

function diff(before, after) {
	const key = (x) => x.id;
	const b = new Map(before.map((x) => [key(x), x]));
	const a = new Map(after.map((x) => [key(x), x]));
	return {
		added: after.filter((x) => !b.has(key(x))),
		changed: after
			.filter((x) => b.has(key(x)) && JSON.stringify(b.get(key(x))) !== JSON.stringify(x))
			.map((x) => ({ before: b.get(key(x)), after: x })),
		removed: before.filter((x) => !a.has(key(x))),
	};
}

async function main() {
	const stamp = Date.now();
	const email = `modelmatrix-${stamp}@nova.test`;
	const password = 'ProbePassw0rd!2026';

	const reg = await api('POST', '/api/v1/auth/register', { email, password, name: 'Model Matrix' }, { auth: false });
	if (reg.status >= 300 && reg.status !== 409) {
		console.error(`register failed: ${reg.status} ${JSON.stringify(reg.body).slice(0, 300)}`);
		process.exit(1);
	}
	const login = await api('POST', '/api/v1/auth/login', { email, password }, { auth: false });
	token = login.body?.data?.access_token ?? login.body?.access_token ?? '';
	if (!token) {
		console.error(`login failed: ${login.status} ${JSON.stringify(login.body).slice(0, 300)}`);
		process.exit(1);
	}

	await seed();
	const seeded = await state();

	const results = [];
	// A shared history so the modification and question turns have something to
	// resolve against, exactly as a real spoken session would.
	const history = [];

	for (const p of probes()) {
		const before = await state();
		const messages = [...history, { role: 'user', content: p.said }];
		const t0 = Date.now();
		let res;
		try {
			res = await api('POST', '/api/v1/voice/chat', { messages, language: p.language });
		} catch (err) {
			res = { status: 0, body: { error: String(err) } };
		}
		const ms = Date.now() - t0;
		const reply = res.body?.data?.text ?? res.body?.error?.message ?? res.body?.message ?? '';
		const after = await state();
		const d = {
			reminders: diff(before.reminders, after.reminders),
			tasks: diff(before.tasks, after.tasks),
			memories: diff(before.memories, after.memories),
		};
		let ok = false;
		try {
			ok = res.status === 200 && p.check(d);
		} catch {
			ok = false;
		}
		if (!ok) failures += 1;

		history.push({ role: 'user', content: p.said });
		if (reply) history.push({ role: 'assistant', content: reply });

		results.push({
			id: p.id,
			language: p.language,
			status: res.status,
			ms,
			model: res.body?.data?.model,
			provider: res.body?.data?.provider,
			fellBack: res.body?.data?.fellBack,
			ok,
			expect: p.expect,
			tamilScript: tamilRe.test(reply),
			reply,
			changes: {
				reminders: { added: d.reminders.added.length, changed: d.reminders.changed.length },
				tasks: { added: d.tasks.added.length, changed: d.tasks.changed.length },
				memories: { added: d.memories.added.length, changed: d.memories.changed.length },
			},
		});
	}

	// A run that silently measured a different model is worse than no run. This
	// happened for real: a restart died with EADDRINUSE, the probe talked to the
	// previous server, and the summary was labelled with a model that never served
	// a single turn. Any observed id that disagrees with the label is a hard error.
	const observed = [...new Set(results.map((r) => r.model).filter(Boolean))];
	const mismatch = observed.filter((m) => m !== LABEL);
	if (mismatch.length) {
		console.error(
			`\n!!! MODEL MISMATCH: label=${LABEL} but the API served ${observed.join(', ')}. ` +
				'These numbers describe the wrong model; do not use them.',
		);
		failures += 1;
	}

	const summary = {
		label: LABEL,
		observedModels: observed,
		modelMismatch: mismatch,
		base: BASE,
		account: email,
		seeded: {
			reminders: seeded.reminders.length,
			tasks: seeded.tasks.length,
			memories: seeded.memories.length,
		},
		results,
		okCount: results.filter((r) => r.ok).length,
		total: results.length,
		latencyMs: {
			mean: Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length),
			max: Math.max(...results.map((r) => r.ms)),
			min: Math.min(...results.map((r) => r.ms)),
		},
	};

	console.log(`\n############ MODEL ${LABEL} ############`);
	console.log(`account ${email}  seeded r=${seeded.reminders.length} t=${seeded.tasks.length} m=${seeded.memories.length}`);
	for (const r of results) {
		console.log(
			`\n[${r.ok ? 'OK  ' : 'BAD '}] ${r.id} (${r.language}) ${r.ms}ms http=${r.status} model=${r.model ?? '-'} ` +
				`provider=${r.provider ?? '-'} fellBack=${r.fellBack ?? '-'} tamil=${r.tamilScript}\n` +
				`      want: ${r.expect}\n` +
				`      writes: r+${r.changes.reminders.added}/~${r.changes.reminders.changed} ` +
				`t+${r.changes.tasks.added}/~${r.changes.tasks.changed} m+${r.changes.memories.added}/~${r.changes.memories.changed}\n` +
				`      said: ${JSON.stringify(r.reply).slice(0, 400)}`,
		);
	}
	console.log(
		`\n### ${LABEL}: ${summary.okCount}/${summary.total} behaved as required; ` +
			`latency mean ${summary.latencyMs.mean}ms (min ${summary.latencyMs.min} / max ${summary.latencyMs.max})`,
	);

	if (OUT) {
		const fs = await import('node:fs');
		fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
		console.log(`wrote ${OUT}`);
	}

	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
