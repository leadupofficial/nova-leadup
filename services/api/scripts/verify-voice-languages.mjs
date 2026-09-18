#!/usr/bin/env node
/**
 * Voice language probe — verifies speech recognition across the language set.
 *
 * The app claims 22 languages. This drives the real realtime socket with a real
 * audio clip per language and prints what actually comes back, so the claim can
 * be checked rather than assumed. It is how the table in the handover notes was
 * produced.
 *
 * Usage:
 *   node services/api/scripts/verify-voice-languages.mjs <lang> <file.wav> [...]
 *
 *   # any 16 kHz mono s16le WAV works; macOS can generate them locally with no
 *   # API key at all, which is handy when a provider is out of credit:
 *   say -v Vani  -o /tmp/ta.aiff "வணக்கம் நோவா, நாளைக்கு என்ன வேலை இருக்கு?"
 *   afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/ta.aiff /tmp/ta.wav
 *   node services/api/scripts/verify-voice-languages.mjs ta /tmp/ta.wav
 *
 * Environment:
 *   NOVA_API_BASE   default https://nova.leadup.in
 *   NOVA_EMAIL      default admin@nova.leadup.in
 *   NOVA_PASSWORD   required (no default; this is a real login)
 */
import fs from 'node:fs';

const BASE = process.env.NOVA_API_BASE || 'https://nova.leadup.in';
const EMAIL = process.env.NOVA_EMAIL || 'admin@nova.leadup.in';
const PASSWORD = process.env.NOVA_PASSWORD;

const pairs = [];
for (let i = 2; i < process.argv.length; i += 2) {
	const lang = process.argv[i];
	const file = process.argv[i + 1];
	if (lang && file) pairs.push({ lang, file });
}

if (!PASSWORD) {
	console.error('Set NOVA_PASSWORD (this script logs in for real).');
	process.exit(2);
}
if (!pairs.length) {
	console.error('Usage: verify-voice-languages.mjs <lang> <file.wav> [...]');
	process.exit(2);
}

/** Strips the 44-byte WAV header and returns the PCM payload. */
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
const token = (await login.json())?.data?.access_token;
if (!token) {
	console.error(`Login failed (${login.status}).`);
	process.exit(1);
}

const wsBase = BASE.replace(/^http/, 'ws');

function probe(lang, pcm) {
	return new Promise((resolve) => {
		let partials = 0;
		let final = null;
		let provider = null;
		let error = null;
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve({ lang, partials, final, provider, error });
		};

		const ws = new WebSocket(
			`${wsBase}/api/v1/voice/realtime?token=${encodeURIComponent(token)}`
		);

		ws.addEventListener('open', () => {
			ws.send(JSON.stringify({ type: 'start', language: lang }));
			const frame = 3200; // ~100 ms at 16 kHz mono s16le
			let offset = 0;
			const timer = setInterval(() => {
				if (offset >= pcm.length) {
					clearInterval(timer);
					ws.send(JSON.stringify({ type: 'stop' }));
					// The reply is not what is under test here; give the turn
					// enough time to produce its final, then move on.
					setTimeout(finish, 12_000);
					return;
				}
				try {
					ws.send(pcm.subarray(offset, offset + frame));
				} catch {
					/* socket went away; the timeout below settles us */
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
			if (msg.type === 'stt') provider = `deepgram${msg.fallback ? ' (fallback)' : ''}`;
			else if (msg.type === 'partial') partials += 1;
			else if (msg.type === 'final') {
				final = msg.text;
				finish();
			} else if (msg.type === 'error' && msg.code !== 'TTS_ERROR') {
				// TTS is a separate leg; a speech-synthesis outage must not be
				// reported as a recognition failure.
				error = `${msg.code}: ${msg.message}`;
			}
		});

		ws.addEventListener('error', (e) => {
			error = String(e.message ?? e).slice(0, 80);
			finish();
		});

		setTimeout(finish, 45_000);
	});
}

let failures = 0;
for (const { lang, file } of pairs) {
	try {
		const result = await probe(lang, pcm16kMono(file));
		const ok = Boolean(result.final) && !result.error;
		if (!ok) failures += 1;
		const detail = result.error
			? `ERROR ${result.error}`
			: JSON.stringify(result.final ?? '(no final)');
		console.log(
			`  ${ok ? 'ok  ' : 'FAIL'} ${lang.padEnd(6)} partials=${String(result.partials).padStart(2)} ` +
				`stt=${(result.provider ?? '-').padEnd(20)} ${detail}`
		);
	} catch (err) {
		failures += 1;
		console.log(`  FAIL ${lang.padEnd(6)} ${err.message}`);
	}
}

console.log(`\n${pairs.length - failures}/${pairs.length} languages produced a transcript.`);
process.exit(failures ? 1 : 0);
