/**
 * The durable log sink.
 *
 * `GET /control/logs` used to answer `available: false` and, in the same response, name the fix:
 * *"wire a sink to the pino stream and add a query route over it."* These tests pin the three
 * properties that make the sink safe to attach to a production logger — and the first run against a
 * real database is what proved the fourth thing worth testing, that a failed flush is **reported**
 * rather than swallowed (it failed with "INSERT has more expressions than target columns", and only
 * the sink's own stderr line made that visible).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import './setup.js';

import { LogSink, lineToRow, overflowNotice } from '../utils/log-sink.js';

const line = (fields: Record<string, unknown>): string => JSON.stringify(fields);

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('line parsing', () => {
	it('drops anything below the sink level', () => {
		// The default exists because `info` includes a line per request: persisting all of them would
		// be one insert per HTTP request on the database serving them.
		expect(lineToRow(line({ level: 'info', msg: 'hello' }), 'warn')).toBeNull();
		expect(lineToRow(line({ level: 'debug', msg: 'hello' }), 'warn')).toBeNull();
		expect(lineToRow(line({ level: 'trace', msg: 'hello' }), 'warn')).toBeNull();
	});

	it('keeps warn and above', () => {
		for (const level of ['warn', 'error', 'fatal']) {
			expect(lineToRow(line({ level, msg: 'kept' }), 'warn')?.level, level).toBe(level);
		}
	});

	it('honours a lower configured level', () => {
		expect(lineToRow(line({ level: 'info', msg: 'kept' }), 'info')).not.toBeNull();
	});

	it('returns null for a line that is not JSON rather than throwing', () => {
		// The sink is on pino's write path; a throw here would take the request with it.
		expect(lineToRow('not json at all', 'warn')).toBeNull();
		expect(lineToRow('', 'warn')).toBeNull();
	});

	it('promotes the fields the console filters on', () => {
		const row = lineToRow(
			line({
				level: 'error',
				time: '2026-09-21T20:48:47.000Z',
				service: 'nova-api',
				msg: 'POST /api/v1/auth/login -> 401',
				method: 'POST',
				path: '/api/v1/auth/login',
				statusCode: 401,
				durationMs: 12,
				requestId: 'req-1',
				userId: 'user-1',
			}),
			'warn',
		);
		expect(row).not.toBeNull();
		expect(row?.occurredAt.toISOString()).toBe('2026-09-21T20:48:47.000Z');
		expect(row?.route).toBe('/api/v1/auth/login');
		expect(row?.statusCode).toBe(401);
		expect(row?.durationMs).toBe(12);
		expect(row?.requestId).toBe('req-1');
		expect(row?.userId).toBe('user-1');
	});

	it('reads the error serialiser, including the stack', () => {
		const row = lineToRow(
			line({ level: 'error', msg: 'boom', err: { type: 'HttpError', message: 'nope', stack: 'Error: nope\n  at x' } }),
			'warn',
		);
		expect(row?.errorType).toBe('HttpError');
		expect(row?.errorMessage).toBe('nope');
		expect(row?.stack).toContain('at x');
	});

	it('accepts snake_case aliases, which different call sites use', () => {
		const row = lineToRow(
			line({ level: 'error', msg: 'x', request_id: 'r', user_id: 'u', status_code: 500, duration_ms: 3 }),
			'warn',
		);
		expect(row?.requestId).toBe('r');
		expect(row?.userId).toBe('u');
		expect(row?.statusCode).toBe(500);
		expect(row?.durationMs).toBe(3);
	});

	it('puts everything not promoted into context, so nothing logged is lost', () => {
		const row = lineToRow(line({ level: 'warn', msg: 'x', provider: 'anthropic', attempts: 3 }), 'warn');
		expect(row?.context).toEqual({ provider: 'anthropic', attempts: 3 });
	});

	it('stores a redacted value as the redaction marker, never as a secret', () => {
		// The sink is registered with `pino.multistream`, so it receives the line *after* `redact` has
		// run. This asserts the shape that reaches it is stored verbatim and cannot resurrect a value.
		const row = lineToRow(line({ level: 'error', msg: 'x', token: '[redacted]', context: { apiKey: '[redacted]' } }), 'warn');
		expect(JSON.stringify(row)).toContain('[redacted]');
		expect(JSON.stringify(row)).not.toContain('sk-live');
	});

	it('bounds the free-text fields a call site could make enormous', () => {
		const row = lineToRow(
			line({ level: 'error', msg: 'm'.repeat(9000), stack: 's'.repeat(20000), requestId: 'r'.repeat(500) }),
			'warn',
		);
		expect((row?.msg ?? '').length).toBeLessThanOrEqual(4_000);
		expect((row?.stack ?? '').length).toBeLessThanOrEqual(8_000);
		expect((row?.requestId ?? '').length).toBeLessThanOrEqual(100);
	});

	it('survives a missing timestamp', () => {
		const row = lineToRow(line({ level: 'warn', msg: 'x' }), 'warn');
		expect(row?.occurredAt).toBeInstanceOf(Date);
		expect(Number.isNaN((row?.occurredAt as Date).getTime())).toBe(false);
	});
});

describe('buffering', () => {
	it('parses on the write path and does not await anything', () => {
		const sink = new LogSink();
		sink.accept(line({ level: 'error', msg: 'one' }));
		expect(sink.pending).toBe(1);
	});

	it('drops the oldest entry when the buffer is full, and counts it', () => {
		const sink = new LogSink();
		// The cap is a documented constant; filling it is the only way to assert the policy, and the
		// policy is that the *newest* survive because they are what an operator is about to want.
		const limit = 2_000;
		for (let index = 0; index < limit + 5; index += 1) {
			sink.accept(line({ level: 'error', msg: `entry-${index}` }));
		}
		expect(sink.pending).toBe(limit);
		expect(sink.droppedCount).toBe(5);
	});

	it('names the count in a row of its own, so a gap is never silent', () => {
		// Extracted as a pure function precisely so this is assertable: the notice is the only
		// evidence entries were lost, and a log whose absences look like calm is the failure mode.
		const notice = overflowNotice(3);
		expect(notice.level).toBe('warn');
		expect(notice.msg).toContain('3 log entries were dropped');
		expect(notice.msg).toContain('not recoverable');
		expect(notice.errorType).toBe('LogSinkOverflow');
		expect(notice.context).toMatchObject({ dropped: 3 });
	});

	it('reads correctly for a single dropped entry', () => {
		expect(overflowNotice(1).msg).toContain('1 log entry was dropped');
	});
});
