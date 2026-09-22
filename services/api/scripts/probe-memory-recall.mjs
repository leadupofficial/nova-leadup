#!/usr/bin/env node
/**
 * Does NOVA actually use what it was told to remember?
 *
 * §16 of the acceptance criteria asks a specific question — tell NOVA "my
 * preferred time for daily planning is 9 AM", then later ask it to remind you to
 * plan — and the failure it is looking for is *confident* silence: an assistant
 * that has the fact and does not use it, or worse, invents a different time.
 *
 * This script answers that against the running API, and it answers the harder
 * version of it. A single saved memory is easy: the grounding block injects the
 * top N memories by importance, so one memory is always inside the cut and the
 * feature looks like it works. The interesting case is a user with more memories
 * than the cap, where the fact that matters is **not** the most "important" one by
 * the column's value. That is exactly what relevance ranking is for, and exactly
 * what cannot run without an embeddings provider.
 *
 * So it runs the same question twice, changing only the stored `importance` of the
 * one relevant fact:
 *
 *   A. relevant fact at importance 5, buried under 13 memories at importance 90
 *   B. the same fact promoted to importance 99
 *
 * If the answer changes between A and B, the assistant is reading its memory block
 * and the only question is whether the *right* memories reach it. If the answer
 * does not change, the fact was in the prompt both times and the model ignored it.
 *
 * Usage: NOVA_API_BASE=http://127.0.0.1:3001 node services/api/scripts/probe-memory-recall.mjs
 */
const BASE = process.env.NOVA_API_BASE || 'http://127.0.0.1:3001';

let token = '';

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

/** The question the user asks, and the answer a real assistant would give. */
const ASK = 'NOVA, I need to plan my day tomorrow. Remind me when I usually do my planning.';

/** 13 memories that are not about planning, all set to outrank the relevant one. */
const NOISE = [
	'The wifi password at the office is on the whiteboard',
	'Ravi prefers calls after 6pm',
	'The car service is due in March',
	'My gym membership renews in January',
	'Meena is allergic to peanuts',
	'The client invoice template lives in the shared drive',
	'The balcony plants need watering on Sundays',
	'Standup is at 10:15 on weekdays',
	'The landlord number is saved under "Kumar house"',
	'I take my coffee without sugar',
	'The project repo is on the external drive',
	'Flight check-in opens 48 hours before departure',
	'The electricity bill arrives on the 5th',
];

/** The fact the user wants used, phrased as they said it. */
const RELEVANT = 'My preferred time for daily planning is 9 AM';

/** Does the reply show it knows the 9 AM preference? */
function namesThePreference(text) {
	if (!text) return false;
	return /\b(9|nine)\s*(am|a\.m\.|o'?clock|மணி)?\b/i.test(text) || /காலை\s*(ஒன்பது|9)/.test(text);
}

async function main() {
	const stamp = Date.now();
	const email = `memrecall-${stamp}@nova.test`;
	const password = 'ProbePassw0rd!2026';

	const reg = await api('POST', '/api/v1/auth/register', { email, password, name: 'Memory Recall' });
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

	console.log(`account ${email}\n`);

	// The relevant fact first, at the bottom of the importance order.
	const rel = await api('POST', '/api/v1/memories', {
		content: RELEVANT,
		category: 'preference',
		sourceType: 'manual',
		importance: 5,
	});
	const relId = rel.body?.data?.id;
	if (!relId) {
		console.error(`could not save the relevant memory: ${rel.status} ${JSON.stringify(rel.body).slice(0, 200)}`);
		process.exit(1);
	}
	for (const content of NOISE) {
		const r = await api('POST', '/api/v1/memories', {
			content,
			category: 'fact',
			sourceType: 'manual',
			importance: 90,
		});
		if (r.status >= 300) console.error(`  noise memory failed: ${r.status}`);
	}

	const stored = await api('GET', '/api/v1/memories?limit=100');
	const all = stored.body?.data?.memories ?? stored.body?.data?.data ?? [];
	console.log(`stored memories: ${all.length}`);

	/** Asks the question with whatever memory state exists right now. */
	async function ask(label) {
		const t0 = Date.now();
		const res = await api('POST', '/api/v1/voice/chat', {
			messages: [{ role: 'user', content: ASK }],
			language: 'en',
		});
		const ms = Date.now() - t0;
		const reply = res.body?.data?.text ?? '';
		const knows = namesThePreference(reply);
		console.log(
			`\n[${label}] http=${res.status} ${ms}ms  knows-9am=${knows}\n  asked: ${ASK}\n  said : ${JSON.stringify(reply).slice(0, 400)}`,
		);
		return knows;
	}

	const buried = await ask('A · relevant fact at importance 5, under 13 at importance 90');

	// Promote the same fact above every distractor. Nothing else changes.
	const patch = await api('PATCH', `/api/v1/memories/${relId}`, { importance: 99 });
	console.log(`\npromoted the relevant memory to importance 99: HTTP ${patch.status}`);

	const promoted = await ask('B · the same fact at importance 99');

	console.log('\n──────────────────────────────────────────────');
	console.log(`A (buried)   knew the 9 AM preference: ${buried}`);
	console.log(`B (promoted) knew the 9 AM preference: ${promoted}`);
	if (!buried && promoted) {
		console.log(
			'→ The fact was in the prompt in B and not in A. Memory grounding is alive, but what\n' +
				'  reaches it is decided by the importance column, not by the question — so a real\n' +
				"  user's relevant fact is dropped as soon as they have more memories than the cap.",
		);
	} else if (buried && promoted) {
		console.log('→ Known in both: more memories than the cap do not crowd it out here.');
	} else if (!buried && !promoted) {
		console.log('→ Not known even when it outranks everything: the fact is in the prompt and the model ignored it.');
	} else {
		console.log('→ Known when buried, unknown when promoted — inconsistent; re-run before drawing a conclusion.');
	}
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
