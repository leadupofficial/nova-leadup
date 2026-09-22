/**
 * The durable log sink.
 *
 * `GET /control/logs` used to answer `available: false` with a precise explanation and, in the same
 * response, the fix: *"wire a sink to the pino stream and add a query route over it. The logger
 * already emits JSON, so only a transport and the store are missing."* This is that sink.
 *
 * ## Three properties, in order of importance
 *
 * 1. **A logged request never waits on the database.** `write` parses the line, pushes to an
 *    in-memory buffer and returns. A timer flushes in batches. Logging is on the hot path of every
 *    request, so a synchronous insert here would make the log store a way to take the API down —
 *    and it would do it *while the API was already unhealthy*, which is when logs matter most.
 *
 * 2. **A gap is recorded, never silent.** When the buffer is full the **oldest** entries are dropped
 *    (the newest are the ones an operator is about to want) and the count is persisted in a row of
 *    its own, with a message that says what happened. Dropping quietly would produce a log whose
 *    absences look like calm.
 *
 * 3. **Only what pino already redacted.** The sink is registered with `pino.multistream`, which hands
 *    each stream the **final serialised line** — after `redact` has run. The sink parses that line and
 *    never receives the original object, so a credential cannot reach this table by a path the
 *    application redactor does not cover. A test asserts it.
 *
 * ## Why a stream rather than a pino transport
 *
 * A transport runs the sink in a worker thread and would need the database client there too. A stream
 * keeps one connection pool, keeps the code testable without spawning a worker, and — decisively —
 * gives the sink the serialised line rather than the live object, which is what makes property 3 true.
 */

import { Writable } from 'node:stream';
import { getDbPool } from '../db/connection.js';

/** Levels pino uses, ordered. `trace` is below `debug`. */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LEVELS)[number];

/** Rows per flush. Large enough to matter, small enough not to hold a transaction open. */
const FLUSH_BATCH_SIZE = 200;

/** How often the buffer is written. Also the retention check's period. */
const FLUSH_INTERVAL_MS = 2_000;

/**
 * Buffer ceiling. ~2 000 entries of this shape is a few megabytes, which is small enough to be safe
 * on a modest container and large enough to absorb a burst.
 */
const MAX_BUFFERED = 2_000;

/** Rows older than this are deleted. Overridden by `LOG_RETENTION_DAYS`. */
const DEFAULT_RETENTION_DAYS = 7;

/** Retention is checked on this many flush cycles, not every one — it is a delete, not a read. */
const RETENTION_EVERY_N_FLUSHES = 30;

export type LogRow = {
	occurredAt: Date;
	level: string;
	service: string;
	msg: string | null;
	requestId: string | null;
	userId: string | null;
	route: string | null;
	method: string | null;
	statusCode: number | null;
	durationMs: number | null;
	errorType: string | null;
	errorMessage: string | null;
	stack: string | null;
	context: Record<string, unknown>;
};

/** Configured sink level. Anything below it is never parsed, let alone stored. */
export function sinkLevel(): LogLevel {
	const raw = (process.env.LOG_SINK_LEVEL ?? 'warn').trim().toLowerCase();
	return (LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : 'warn';
}

export function retentionDays(): number {
	const raw = Number.parseInt(process.env.LOG_RETENTION_DAYS ?? '', 10);
	return Number.isFinite(raw) && raw >= 1 && raw <= 365 ? raw : DEFAULT_RETENTION_DAYS;
}

function levelRank(level: string): number {
	const index = (LEVELS as readonly string[]).indexOf(level);
	return index === -1 ? LEVELS.length : index;
}

/**
 * The fields the sink promotes to columns.
 *
 * Everything else in the line goes into `context`. Listed explicitly rather than spread so a new
 * column requires a deliberate edit here — the alternative silently stores nothing for a field the
 * console has started reading.
 */
const PROMOTED = new Set([
	'time', 'level', 'service', 'msg', 'requestId', 'request_id', 'userId', 'user_id',
	'route', 'path', 'method', 'statusCode', 'status_code', 'durationMs', 'duration_ms',
	'err', 'error', 'stack', 'pid', 'hostname',
]);

function asString(value: unknown, max = 200): string | null {
	if (value === null || value === undefined) return null;
	const text = typeof value === 'string' ? value : String(value);
	return text.length > max ? text.slice(0, max) : text;
}

function asInt(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === 'string') {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * Turns one serialised log line into a row, or `null` when it is below the sink level or unparseable.
 *
 * Exported for the tests: the mapping is where a field can be lost or a secret could be mistaken for
 * context, and it is worth asserting without a database.
 */
export function lineToRow(line: string, minimum: LogLevel = sinkLevel()): LogRow | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}

	const level = asString(parsed.level, 10) ?? 'info';
	if (levelRank(level) < levelRank(minimum)) return null;

	// `err` is where pino's standard serializer puts a thrown error.
	const err = (parsed.err ?? parsed.error) as Record<string, unknown> | undefined;

	const context: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!PROMOTED.has(key)) context[key] = value;
	}

	const service = asString(parsed.service, 50) ?? 'nova-api';
	const userId = asString(parsed.userId ?? parsed.user_id, 100);
	const requestId = asString(parsed.requestId ?? parsed.request_id, 100);
	const route = asString(parsed.route ?? parsed.path, 200);
	const method = asString(parsed.method, 10);
	const statusCode = asInt(parsed.statusCode ?? parsed.status_code);
	const durationMs = asInt(parsed.durationMs ?? parsed.duration_ms);

	// `stack` from the pino serializer, or the error object's own.
	const stack = asString(parsed.stack ?? err?.stack, 8_000);
	const errorType = asString(err?.type ?? err?.name, 200);
	const errorMessage = asString(err?.message, 2_000);

	const time = parsed.time;
	const occurredAt = typeof time === 'string' || typeof time === 'number' ? new Date(time) : new Date();

	return {
		occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
		level,
		service,
		msg: asString(parsed.msg, 4_000),
		requestId,
		userId,
		route,
		method,
		statusCode,
		durationMs,
		errorType,
		errorMessage,
		stack,
		context,
	};
}

/**
 * The row that records entries lost to a full buffer.
 *
 * A pure function so its content is asserted directly rather than through a database: this row is the
 * only evidence a gap exists, and a gap that reads as calm is worse than a loud failure. It is written
 * with the batch it describes so the count and the surrounding rows land together.
 */
export function overflowNotice(dropped: number): LogRow {
	return {
		occurredAt: new Date(),
		level: 'warn',
		service: 'nova-api',
		msg: `${dropped} log entr${dropped === 1 ? 'y was' : 'ies were'} dropped: the sink buffer was full. The gap is real and the entries are not recoverable.`,
		requestId: null,
		userId: null,
		route: null,
		method: null,
		statusCode: null,
		durationMs: null,
		errorType: 'LogSinkOverflow',
		errorMessage: null,
		stack: null,
		context: { dropped, bufferLimit: MAX_BUFFERED },
	};
}

/**
 * A writable pino stream that batches to `service_logs`.
 *
 * `write` is deliberately synchronous and allocation-light. `flush` is exported so a test can drive
 * it deterministically rather than waiting on the timer.
 */
export class LogSink extends Writable {
	private buffer: LogRow[] = [];
	private dropped = 0;
	private flushCount = 0;
	private failures = 0;
	private timer: NodeJS.Timeout | null = null;
	private flushing: Promise<void> | null = null;
	private stopped = false;

	constructor(private readonly options: { intervalMs?: number; minimum?: LogLevel } = {}) {
		super({ objectMode: false });
	}

	override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
		this.accept(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		callback();
	}

	/** Parse and buffer one line. Never throws, never awaits. */
	accept(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		const row = lineToRow(trimmed, this.options.minimum ?? sinkLevel());
		if (!row) return;

		if (this.buffer.length >= MAX_BUFFERED) {
			// Oldest out: the newest entries are the ones an operator is about to want.
			this.buffer.shift();
			this.dropped += 1;
		}
		this.buffer.push(row);
	}

	/** Starts the flush timer. Idempotent. */
	start(): void {
		if (this.timer || this.stopped) return;
		this.timer = setInterval(() => {
			void this.flush();
		}, this.options.intervalMs ?? FLUSH_INTERVAL_MS);
		// Do not hold the process open for log flushing.
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.flush();
	}

	/** Rows waiting to be written. For tests and for the health of the sink itself. */
	get pending(): number {
		return this.buffer.length;
	}

	get droppedCount(): number {
		return this.dropped;
	}

	/** How many flushes have failed. Exposed so a test can assert a failure is counted, not hidden. */
	get failureCount(): number {
		return this.failures;
	}

	/**
	 * Writes the buffer.
	 *
	 * Re-entrant calls share one in-flight flush rather than interleaving, so a slow database cannot
	 * cause two concurrent inserts of the same rows.
	 */
	async flush(): Promise<void> {
		if (this.flushing) return this.flushing;
		this.flushing = this.runFlush().finally(() => {
			this.flushing = null;
		});
		return this.flushing;
	}

	private async runFlush(): Promise<void> {
		const batch = this.buffer.splice(0, FLUSH_BATCH_SIZE);
		const dropped = this.dropped;
		if (batch.length === 0 && dropped === 0) return;

		// The drop notice is written with the batch so the count and the rows it describes land
		// together; a separate row could arrive out of order and read as a gap with no rows near it.
		if (dropped > 0) {
			this.dropped = 0;
			batch.push(overflowNotice(dropped));
		}

		if (batch.length === 0) return;

		try {
			const pool = getDbPool();
			// One multi-row insert. Parameterised throughout; the values are log data and are never
			// interpolated into SQL.
			// The placeholder count and the tuple's expression count must match the column list. It
			// is written once here and used for the `base` offset below, so the two cannot drift.
			const columns = 14;
			const values: unknown[] = [];
			const tuples = batch.map((row, index) => {
				const base = index * columns;
				values.push(
					row.occurredAt, row.level, row.service, row.msg, row.requestId, row.userId,
					row.route, row.method, row.statusCode, row.durationMs, row.errorType,
					row.errorMessage, row.stack, JSON.stringify(row.context ?? {}),
				);
				// Fourteen expressions for fourteen columns. An earlier version appended `now()` for a
				// bookkeeping column that does not exist, and Postgres refused the whole batch with
				// "INSERT has more expressions than target columns" — caught on the first live run by
				// the sink's own failure reporting, which is the reason that reporting exists.
				return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}::jsonb)`;
			});

			await pool.query(
				`INSERT INTO service_logs
				   (occurred_at, level, service, msg, request_id, user_id, route, method,
				    status_code, duration_ms, error_type, error_message, stack, context)
				 VALUES ${tuples.join(', ')}`,
				values,
			);

			this.flushCount += 1;
			if (this.flushCount % RETENTION_EVERY_N_FLUSHES === 0) await this.applyRetention();
		} catch (error) {
			// A sink that throws into pino would take the request with it. The entries are lost and
			// that is the honest outcome: the database is the sink, so a database outage is a log
			// outage, and the alternative — buffering without bound — turns it into a memory outage.
			//
			// It is *reported*, though, and only on the first failure and then occasionally. A sink
			// that fails silently is the exact defect this whole feature exists to remove, and the
			// failure here is what an operator would otherwise have to infer from an empty table.
			this.dropped += batch.length;
			this.failures += 1;
			if (this.failures === 1 || this.failures % 50 === 0) {
				// stderr, not the logger: routing this through pino would re-enter this sink.
				process.stderr.write(
					`[log-sink] could not persist ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} `
					+ `(failure ${this.failures}, ${this.dropped} dropped in total): `
					+ `${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		}
	}

	/** Deletes rows past the retention window. Exported so the reaper is testable. */
	async applyRetention(): Promise<number> {
		try {
			const { rowCount } = await getDbPool().query(
				`DELETE FROM service_logs WHERE occurred_at < now() - ($1 || ' days')::interval`,
				[String(retentionDays())],
			);
			return rowCount ?? 0;
		} catch {
			return 0;
		}
	}
}

/**
 * The process-wide sink.
 *
 * Created lazily and started on first use so importing the logger in a unit test does not open a
 * timer. `getLogSink()` returns the same instance the logger writes to, which is what lets a test
 * assert on buffered rows.
 */
let sink: LogSink | null = null;

export function getLogSink(): LogSink {
	if (!sink) {
		sink = new LogSink();
		sink.start();
	}
	return sink;
}

/** Test seam: replace the process sink. */
export function __setLogSinkForTests(replacement: LogSink | null): void {
	sink = replacement;
}

export const LOG_SINK_LIMITS = {
	FLUSH_BATCH_SIZE,
	FLUSH_INTERVAL_MS,
	MAX_BUFFERED,
	DEFAULT_RETENTION_DAYS,
	RETENTION_EVERY_N_FLUSHES,
};
