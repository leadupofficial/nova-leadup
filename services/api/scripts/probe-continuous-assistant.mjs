#!/usr/bin/env node
/**
 * §31 — the continuous-assistant scenario, end to end, against the live API.
 *
 * This is the brief's capstone: one user, one continuous relationship, nine phases,
 * and each phase asserts something about the *database*, not about the prose. A
 * reply that says "Done!" and changes nothing is the failure this is built to
 * catch, so every check reads the rows back through the same REST routes the app
 * uses and compares before/after.
 *
 * Two deliberate choices:
 *
 *  - **The assistant's own turns are the only way state changes.** The script never
 *    inserts a task or reminder directly, because §1 is explicit that the test is
 *    whether the *product* understands the user, not whether Postgres works.
 *  - **Phases 3–4 (close the app, lock the phone, wait for the reminder) are not
 *    reproduced here.** They were run on the physical device in Round 4 and their
 *    evidence is in the report; a script cannot lock a phone. This file covers the
 *    phases that are a conversation, and says so rather than implying coverage it
 *    does not have.
 *
 * Usage:
 *   NOVA_API_BASE=http://127.0.0.1:3001 node services/api/scripts/probe-continuous-assistant.mjs
 */
const BASE = process.env.NOVA_API_BASE || 'http://127.0.0.1:3001';

let token = '';
let failures = 0;
const transcript = [];

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
	if (Array.isArray(d?.tasks)) return d.tasks;
	if (Array.isArray(d?.reminders)) return d.reminders;
	if (Array.isArray(d?.memories)) return d.memories;
	return [];
}

async function state() {
	const [t, r, m] = await Promise.all([
		api('GET', '/api/v1/tasks?limit=100'),
		api('GET', '/api/v1/reminders?limit=100'),
		api('GET', '/api/v1/memories?limit=100'),
	]);
	return {
		tasks: rowsOf(t.body).map((x) => ({ id: x.id, title: x.title, status: x.status, dueAt: x.dueAt ?? null })),
		reminders: rowsOf(r.body).map((x) => ({ id: x.id, title: x.title, at: x.triggerAt, dismissed: x.dismissed })),
		memories: rowsOf(m.body).map((x) => ({ id: x.id, content: x.content, status: x.status })),
	};
}

/** One spoken/typed turn. The assistant's own tools are what change state. */
async function say(text, language = 'en') {
	const t0 = Date.now();
	const res = await api('POST', '/api/v1/voice/chat', {
		messages: [{ role: 'user', content: text }],
		language,
	});
	const ms = Date.now() - t0;
	const reply = res.body?.data?.text ?? res.body?.error?.message ?? '';
	transcript.push({ said: text, said2: language, reply, status: res.status, ms });
	return { status: res.status, reply, ms };
}

function phase(title) {
	console.log(`\n${'='.repeat(72)}\n### ${title}`);
}

function check(label, actual, expected) {
	const ok = actual === expected;
	if (!ok) failures += 1;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
	return ok;
}

function report(label, reply) {
	console.log(`  NOVA: ${JSON.stringify(reply).slice(0, 420)}`);
	void label;
}

const mentions = (text, ...needles) =>
	needles.every((n) => new RegExp(n, 'i').test(text ?? ''));

async function main() {
	const stamp = Date.now();
	const email = `continuous-${stamp}@nova.test`;
	const password = 'ProbePassw0rd!2026';

	const reg = await api('POST', '/api/v1/auth/register', { email, password, name: 'Continuous' });
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
	console.log(`account ${email}`);

	// ── Phase 1 — Setup ────────────────────────────────────────────────────
	phase('Phase 1 · "NOVA, tomorrow I need to finish the website proposal and call the client."');
	{
		const before = await state();
		const t = await say('NOVA, tomorrow I need to finish the website proposal and call the client.');
		report('p1', t.reply);
		const after = await state();
		const newTasks = after.tasks.filter((x) => !before.tasks.some((b) => b.id === x.id));
		const newReminders = after.reminders.filter((x) => !before.reminders.some((b) => b.id === x.id));
		console.log(`  captured: ${newTasks.length} task(s), ${newReminders.length} reminder(s)`);
		for (const x of newTasks) console.log(`    task     ${JSON.stringify(x.title)}`);
		for (const x of newReminders) console.log(`    reminder ${JSON.stringify(x.title)} @ ${x.at}`);
		// ── Two acceptable outcomes, and one forbidden one ─────────────────
		// The user gave a day and no time. §5 says the assistant may *ask* rather
		// than guess, and after the fabricated-time guard landed that is exactly
		// what it does — so "nothing stored" is a pass when the reply asks the
		// question, and a failure when it does not. What is never acceptable is a
		// stored time the user did not give, which is checked separately below.
		const captured = newTasks.length + newReminders.length;
		const askedForTime = captured === 0 && /\?/.test(t.reply) && /(what|which|when).{0,40}time|time.{0,40}(would|do) you/i.test(t.reply);
		if (askedForTime) {
			console.log('  i no time was given, so NOVA asked instead of choosing one — §5 behaviour');
		}
		check(
			'either both commitments captured, or one clarifying question and nothing invented',
			captured >= 2 || askedForTime,
			true,
		);
		check('the proposal is among them (or the turn asked instead)', captured < 2 || newTasks.concat(newReminders).some((x) => /proposal/i.test(x.title)), true);
		check('the client call is among them (or the turn asked instead)', captured < 2 || newTasks.concat(newReminders).some((x) => /client/i.test(x.title)), true);

		// ── No time the user did not give ──────────────────────────────────
		// The user said "tomorrow" and named no hour. A due time or trigger time on
		// these rows is therefore either absent or invented, and there is nothing in
		// between — the model cannot have got it from the sentence. Measured before
		// the guard existed: both rows were written with 18:00 IST and the reply
		// presented it as fact. The check is on the *rows*, because a reply can be
		// corrected while the stored time cannot be un-believed.
		// A date-only value legitimately becomes a timestamp — "tomorrow" resolves to
		// the start of tomorrow in the user's zone, which is midnight local. That is
		// not a clock time the model chose; an hour it chose is anything that is not
		// midnight. Checking for a non-null timestamp instead flagged the correct
		// behaviour, which is how this check read "FAIL, 2" on a run where the rows
		// were `2026-09-21T18:30Z` = exactly midnight IST on the 22nd.
		const localHourOf = (iso) => {
			const parts = new Intl.DateTimeFormat('en-GB', {
				timeZone: 'Asia/Kolkata',
				hour: '2-digit',
				minute: '2-digit',
				hourCycle: 'h23',
			}).formatToParts(new Date(iso));
			const read = (t) => parts.find((p) => p.type === t)?.value ?? '00';
			return `${read('hour')}:${read('minute')}`;
		};
		const withTime = newTasks
			.filter((x) => x.dueAt && localHourOf(x.dueAt) !== '00:00')
			.map((x) => `${x.title} @ ${localHourOf(x.dueAt)} local`)
			.concat(
				newReminders
					.filter((x) => x.at && localHourOf(x.at) !== '00:00')
					.map((x) => `${x.title} @ ${localHourOf(x.at)} local`),
			);
		if (withTime.length) {
			console.log(`  ! an hour the user never gave was stored: ${withTime.join(' | ')}`);
		}
		check('no commitment carries an hour the user did not give', withTime.length, 0);
		check(
			'the reply does not assert a clock time either',
			/\b\d{1,2}(:\d{2})?\s*(am|pm|o'?clock)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+o'?clock\b/i.test(
				t.reply,
			),
			false,
		);
	}

	// ── Phase 2 — Planning ─────────────────────────────────────────────────
	phase('Phase 2 · "Help me organize tomorrow."');
	{
		const before = await state();
		const t = await say('Help me organize tomorrow.');
		report('p2', t.reply);
		const after = await state();
		check('advice did not create anything', after.tasks.length + after.reminders.length, before.tasks.length + before.reminders.length);
		// When phase 1 asked rather than stored, there is nothing to surface — the
		// honest requirement is then that the reply does not claim to know items it
		// does not have.
		const stored = before.tasks.length + before.reminders.length;
		check(
			'either surfaces the real saved items or does not pretend to know them',
			stored > 0 ? mentions(t.reply, 'proposal|client') : !mentions(t.reply, 'you have|you\'ve got|your tasks are'),
			true,
		);
	}

	// ── Phase 5 — "Not now. Remind me after lunch." ────────────────────────
	phase('Phase 5 · "Not now. Remind me after lunch." (reschedule)');
	{
		const before = await state();
		console.log(`  reminders before: ${before.reminders.map((r) => `${r.title}@${r.at}`).join(' | ') || '(none)'}`);
		const t = await say('Not now. Remind me after lunch.');
		report('p5', t.reply);
		const after = await state();
		const moved = after.reminders.filter((r) => {
			const b = before.reminders.find((x) => x.id === r.id);
			return b && b.at !== r.at;
		});
		const added = after.reminders.filter((r) => !before.reminders.some((b) => b.id === r.id));
		console.log(`  moved: ${moved.length}  added: ${added.length}`);
		for (const r of moved) console.log(`    ${r.title}: ${before.reminders.find((b) => b.id === r.id).at} -> ${r.at}`);
		// Rescheduling is the requirement; a *new* reminder instead of moving the
		// existing one is the duplicate-creating defect this check exists for.
		//
		// But there is often nothing to move: if the setup turn produced tasks (which
		// is the model's call) this turn has no reminder to push back, and asking
		// which item was meant is the right answer rather than a failure. What is
		// never acceptable is a *duplicate* — a second reminder created instead of
		// moving the one that exists.
		const hadReminder = before.reminders.length > 0;
		const askedWhich = /\?/.test(t.reply) && /(which|what).{0,60}(reminder|task)|which one/i.test(t.reply);
		if (!hadReminder && !moved.length) {
			console.log(`  i there was no reminder to move; NOVA ${askedWhich ? 'asked which item was meant' : 'did not ask'}`);
		}
		check(
			'either an existing reminder moved, or there was none and the reply asked which one',
			moved.length >= 1 || (!hadReminder && askedWhich),
			true,
		);
		check('nothing was added (no duplicate)', added.length, 0);
	}

	// ── Phase 6 — "I haven't done it yet." ─────────────────────────────────
	phase('Phase 6 · "I haven\'t done it yet."');
	{
		const before = await state();
		const t = await say("I haven't done it yet.");
		report('p6', t.reply);
		const after = await state();
		const completed = after.tasks.filter((x) => {
			const b = before.tasks.find((y) => y.id === x.id);
			return b && b.status !== x.status && x.status === 'completed';
		});
		check('nothing was marked complete', completed.length, 0);
	}

	// ── Phase 7 — "Okay, I finished the proposal." ─────────────────────────
	phase('Phase 7 · "Okay, I finished the proposal."');
	{
		const before = await state();
		const t = await say('Okay, I finished the proposal.');
		report('p7', t.reply);
		const after = await state();
		const completedNow = after.tasks.filter((x) => {
			const b = before.tasks.find((y) => y.id === x.id);
			return b && b.status !== 'completed' && x.status === 'completed';
		});
		console.log(`  newly completed: ${completedNow.map((x) => x.title).join(' | ') || '(none)'}`);
		check('exactly one task completed', completedNow.length, 1);
		check('and it is the proposal', completedNow.length === 1 && /proposal/i.test(completedNow[0].title), true);
	}

	// ── Phase 8 — Next action ──────────────────────────────────────────────
	phase('Phase 8 · "What about the client call?"');
	{
		const before = await state();
		const t = await say('What about the client call?');
		report('p8', t.reply);
		const after = await state();
		check('answering did not change state', after.tasks.length + after.reminders.length, before.tasks.length + before.reminders.length);
		check('the reply names the client call', mentions(t.reply, 'client'), true);
	}

	// ── Phase 9 — Restart ──────────────────────────────────────────────────
	phase('Phase 9 · state after an interruption (re-read through the API)');
	{
		const s = await state();
		check('the completed proposal survived', s.tasks.some((x) => /proposal/i.test(x.title) && x.status === 'completed'), true);
		check('the client call is still pending somewhere', s.tasks.concat(s.reminders).some((x) => /client/i.test(x.title)), true);
		console.log(`  final: ${s.tasks.length} tasks, ${s.reminders.length} reminders, ${s.memories.length} memories`);
	}

	console.log(`\n${'='.repeat(72)}`);
	console.log(`§31 (the conversational phases): ${failures ? `${failures} CHECK(S) FAILED` : 'every check passed'}`);
	console.log('\n--- transcript ---');
	for (const t of transcript) {
		console.log(`\nUSER: ${t.said}\nNOVA (${t.status}, ${t.ms}ms): ${t.reply}`);
	}
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
