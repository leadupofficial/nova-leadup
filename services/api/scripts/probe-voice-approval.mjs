#!/usr/bin/env node
/**
 * Voice tool-approval probe — proves the gate fires on the live service.
 *
 * Speaks a reminder request at the realtime socket and then does one of:
 *
 *   approve   answer the `approval_request` with approve:true
 *   reject    answer with approve:false
 *   timeout   answer nothing at all (waits past the server's own timeout)
 *   silent    an older client that ignores the frame entirely
 *   wrongturn answer approve:true but with the wrong turnId
 *
 * and reports whether a reminder row appeared. An approval gate that never
 * fires is worse than none, so this is the evidence that it does.
 *
 * Usage:
 *   NOVA_PASSWORD=... node services/api/scripts/probe-voice-approval.mjs \
 *     <mode> <16k-mono.wav> [more modes...]
 *
 * The password is read from the environment; this script logs in for real.
 */
import fs from 'node:fs';

const BASE = process.env.NOVA_API_BASE || 'https://nova.leadup.in';
const EMAIL = process.env.NOVA_EMAIL || 'admin@nova.leadup.in';
const PASSWORD = process.env.NOVA_PASSWORD;

const [mode, wav, ...moreModes] = process.argv.slice(2);
const modes = [mode, ...moreModes].filter(Boolean);

if (!PASSWORD) {
	console.error('Set NOVA_PASSWORD (this script logs in for real).');
	process.exit(2);
}
if (!modes.length || !wav) {
	console.error('Usage: probe-voice-approval.mjs <mode> <16k-mono.wav> [...]');
	process.exit(2);
}

/** Strips the WAV header and returns the PCM payload after checking the format. */
function pcm16kMono(path) {
	const bytes = fs.readFileSync(path);
	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	while (offset + 8 <= bytes.length) {
		const id = bytes.toString('ascii', offset, offset + 4);
		const size = bytes.readUInt32LE(offset + 4);
		if (id === 'fmt ') {
			channels = bytes.readUInt16LE(offset + 10);
			sampleRate = bytes.readUInt32LE(offset + 12);
		} else if (id === 'data') {
			if (sampleRate !== 16000 || channels !== 1) {
				throw new Error(`${path}: expected 16 kHz mono, got ${sampleRate}Hz/${channels}ch`);
			}
			return bytes.subarray(offset + 8, offset + 8 + size);
		}
		offset += 8 + size + (size % 2);
	}
	throw new Error(`${path}: no data chunk`);
}

const login = await fetch(`${BASE}/api/v1/auth/login`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const loginBody = await login.json();
const token = loginBody?.data?.access_token ?? loginBody?.access_token;
if (!token) {
	console.error(`Login failed (${login.status}): ${JSON.stringify(loginBody).slice(0, 200)}`);
	process.exit(1);
}

/** Every reminder the account currently has, so a write can be detected. */
async function reminders() {
	const res = await fetch(`${BASE}/api/v1/reminders?limit=100`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const body = await res.json();
	const rows = body?.data?.data ?? body?.data ?? body?.reminders ?? [];
	return Array.isArray(rows) ? rows : [];
}

const wsBase = BASE.replace(/^http/, 'ws');
const pcm = pcm16kMono(wav);

function probe(mode) {
	return new Promise((resolve) => {
		const seen = {
			mode,
			partials: 0,
			final: null,
			approval: null,
			tool: null,
			replyChars: 0,
			error: null,
			approvedInTime: null,
		};
		let settled = false;
		let ws;
		const finish = async () => {
			if (settled) return;
			settled = true;
			try {
				ws?.close();
			} catch {
				/* already gone */
			}
			resolve(seen);
		};

		ws = new WebSocket(`${wsBase}/api/v1/voice/realtime?token=${encodeURIComponent(token)}`);

		ws.addEventListener('open', () => {
			ws.send(JSON.stringify({ type: 'start', language: 'en' }));
			const frame = 3200; // ~100 ms at 16 kHz mono s16le
			let offset = 0;
			const timer = setInterval(() => {
				if (offset >= pcm.length) {
					clearInterval(timer);
					ws.send(JSON.stringify({ type: 'stop' }));
					return;
				}
				try {
					ws.send(pcm.subarray(offset, offset + frame));
				} catch {
					/* socket gone; the outer timeout settles us */
				}
				offset += frame;
			}, 100);
		});

		ws.addEventListener('message', async (event) => {
			if (typeof event.data !== 'string') return;
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}
			if (msg.type === 'partial') seen.partials += 1;
			else if (msg.type === 'final') seen.final = msg.text;
			else if (msg.type === 'token') seen.replyChars += (msg.text ?? '').length;
			else if (msg.type === 'tool') seen.tool = msg;
			else if (msg.type === 'error' && msg.code !== 'TTS_ERROR') {
				seen.error = `${msg.code}: ${msg.message}`;
			} else if (msg.type === 'approval_request') {
				seen.approval = msg;
				console.log(`  approval_request: ${JSON.stringify(msg)}`);
				// The server is holding the tool; this is the only thing that
				// lets it proceed.
				if (mode === 'approve') {
					ws.send(JSON.stringify({ type: 'approval_response', approvalId: msg.approvalId, approve: true, turnId: msg.turnId }));
				} else if (mode === 'reject') {
					ws.send(JSON.stringify({ type: 'approval_response', approvalId: msg.approvalId, approve: false, turnId: msg.turnId }));
				} else if (mode === 'wrongturn') {
					// Right id, wrong turn: must not be accepted as an approval.
					ws.send(JSON.stringify({ type: 'approval_response', approvalId: msg.approvalId, approve: true, turnId: (msg.turnId ?? 0) + 99 }));
				} else if (mode === 'unknown-id') {
					ws.send(JSON.stringify({ type: 'approval_response', approvalId: 'not-a-real-id', approve: true, turnId: msg.turnId }));
				}
				// `timeout` and `silent`: deliberately no answer at all.
			}
			if (msg.type === 'done') {
				// Give the write a moment to land before the caller counts rows.
				setTimeout(finish, 2000);
			}
		});

		ws.addEventListener('error', (e) => {
			seen.error = String(e.message ?? e).slice(0, 120);
		});

		// A timeout run must outlast the server's own approval timeout (60s).
		const budget = mode === 'timeout' ? 130_000 : mode === 'silent' ? 130_000 : 75_000;
		setTimeout(finish, budget);
	});
}

let failures = 0;
for (const m of modes) {
	const before = await reminders();
	console.log(`\n[${m}] reminders before: ${before.length}`);
	const result = await probe(m);
	const after = await reminders();
	const added = after.length - before.length;
	const newRows = after.filter((r) => !before.some((b) => b.id === r.id)).map((r) => `${r.title} @ ${r.triggerAt}`);

	const expectWrite = m === 'approve';
	const ok = expectWrite ? added === 1 : added === 0;
	if (!ok) failures += 1;

	console.log(
		`[${m}] ${ok ? 'ok  ' : 'FAIL'} final=${JSON.stringify(result.final ?? null).slice(0, 90)}\n` +
			`      approval=${result.approval ? `${result.approval.tool} level ${result.approval.level}` : '(none)'}\n` +
			`      tool=${result.tool ? `${result.tool.name} ok=${result.tool.ok} approval=${result.tool.approval ?? '-'} :: ${result.tool.summary}` : '(none)'}\n` +
			`      reminders after=${after.length} added=${added} new=${JSON.stringify(newRows)}\n` +
			`      replyChars=${result.replyChars} error=${result.error ?? '-'}`
	);
}

console.log(`\n${modes.length - failures}/${modes.length} modes behaved as required.`);
process.exit(failures ? 1 : 0);
