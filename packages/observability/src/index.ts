/**
 * @nova/observability — Structured logging, metrics, distributed tracing, request IDs.
 *
 * Per blueprint Section 16.3: OpenTelemetry traces/metrics/structured logs.
 *
 * Exports:
 * - Logger: structured JSON logging with levels, request IDs, redaction
 * - MetricsCollector: counter, gauge, histogram with in-memory storage
 * - Tracer: distributed tracing with span lifecycle
 * - RequestId: request ID generation
 * - ObservabilityModule: combined facade
 */

// ─── Request ID ────────────────────────────────────────────────────────────────

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a short, URL-safe request ID.
 *
 * Format: {timestamp}-{random8}
 * Used as the X-Request-Id header value on every API response per blueprint Section 13.12.
 */
export function generateRequestId(): string {
	const ts = Date.now().toString(36);
	const rand = Array.from({ length: 8 }, () =>
		ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)],
	).join('');
	return `${ts}-${rand}`;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface LogEntry {
	readonly level: LogLevel;
	readonly message: string;
	readonly timestamp: string;
	readonly requestId?: string;
	readonly userId?: string;
	readonly tenantId?: string;
	readonly spanId?: string;
	readonly traceId?: string;
	readonly data?: Record<string, unknown>;
	readonly redacted?: readonly string[];
}

export interface LoggerOptions {
	readonly minLevel?: LogLevel;
	readonly requestId?: () => string;
	readonly redactFields?: readonly string[];
}

const DEFAULT_REDACT_FIELDS = [
	'password',
	'token',
	'secret',
	'apiKey',
	'access_token',
	'refresh_token',
	'authorization',
	'x-api-key',
];

/**
 * Structured JSON logger.
 *
 * All logs emit JSON lines with consistent fields. Sensitive fields are
 * redacted per the redaction rules and per-entry redacted array.
 */
export class Logger {
	private readonly minLevel: LogLevel;
	private readonly requestIdFn: () => string;
	private readonly redactFields: readonly string[];

	constructor(options: LoggerOptions = {}) {
		this.minLevel = options.minLevel ?? 'info';
		this.requestIdFn = options.requestId ?? generateRequestId;
		this.redactFields = options.redactFields ?? DEFAULT_REDACT_FIELDS;
	}

	debug(message: string, data?: Record<string, unknown>): void {
		this.log('debug', message, data);
	}

	info(message: string, data?: Record<string, unknown>): void {
		this.log('info', message, data);
	}

	warn(message: string, data?: Record<string, unknown>): void {
		this.log('warn', message, data);
	}

	error(message: string, data?: Record<string, unknown>): void {
		this.log('error', message, data);
	}

	/**
	 * Log with an explicit request ID context (typically from middleware).
	 */
	logWithContext(
		level: LogLevel,
		message: string,
		context: {
			requestId?: string;
			userId?: string;
			tenantId?: string;
			spanId?: string;
			traceId?: string;
		},
		data?: Record<string, unknown>,
	): void {
		const entry = this.buildEntry(level, message, data, {
			requestId: context.requestId,
			userId: context.userId,
			tenantId: context.tenantId,
			spanId: context.spanId,
			traceId: context.traceId,
		});
		this.emit(entry);
	}

	private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
		if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) return;
		const entry = this.buildEntry(level, message, data);
		this.emit(entry);
	}

	private buildEntry(
		level: LogLevel,
		message: string,
		data?: Record<string, unknown>,
		context?: {
			requestId?: string;
			userId?: string;
			tenantId?: string;
			spanId?: string;
			traceId?: string;
		},
	): LogEntry {
		const redacted = this.redact(data);
		return {
			level,
			message,
			timestamp: new Date().toISOString(),
			requestId: context?.requestId ?? this.requestIdFn(),
			userId: context?.userId,
			tenantId: context?.tenantId,
			spanId: context?.spanId,
			traceId: context?.traceId,
			data: redacted,
			redacted: this.findRedactedKeys(data),
		};
	}

	private emit(entry: LogEntry): void {
		const line = JSON.stringify(entry);
		switch (entry.level) {
			case 'debug':
				console.debug(line);
				break;
			case 'info':
				console.info(line);
				break;
			case 'warn':
				console.warn(line);
				break;
			case 'error':
				console.error(line);
				break;
		}
	}

	/**
	 * Redact sensitive fields from a data object.
	 */
	private redact(data?: Record<string, unknown>): Record<string, unknown> | undefined {
		if (!data) return data;
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			const lowerKey = key.toLowerCase();
			if (this.redactFields.some((f) => lowerKey.includes(f))) {
				result[key] = '[REDACTED]';
			} else if (value && typeof value === 'object' && !Array.isArray(value)) {
				result[key] = this.redact(value as Record<string, unknown>);
			} else {
				result[key] = value;
			}
		}
		return result;
	}

	/**
	 * Find which keys were redacted (for the redactedFields array).
	 */
	private findRedactedKeys(data?: Record<string, unknown>): readonly string[] {
		if (!data) return [];
		const found: string[] = [];
		for (const key of Object.keys(data)) {
			if (this.redactFields.some((f) => key.toLowerCase().includes(f))) {
				found.push(key);
			}
		}
		return found;
	}
}

// ─── Metrics Collector ────────────────────────────────────────────────────────

export interface CounterValue {
	readonly value: number;
	readonly timestamp: number;
}

export interface GaugeValue {
	readonly value: number;
	readonly timestamp: number;
}

export interface HistogramValue {
	readonly count: number;
	readonly sum: number;
	readonly min: number;
	readonly max: number;
	readonly buckets: readonly { readonly upper: number; readonly count: number }[];
}

/**
 * In-memory metrics collector with counter, gauge, and histogram types.
 *
 * Per blueprint Section 16.3: tracks realtime session count, latency, tool
 * success/failure, etc. In production, replace with Prometheus/OTel metrics.
 */
export class MetricsCollector {
	private readonly counters = new Map<string, CounterValue[]>();
	private readonly gauges = new Map<string, GaugeValue[]>();
	private readonly histograms = new Map<string, HistogramValue>();
	private readonly maxSamples = 1000;
	private readonly histogramBuckets: readonly number[];

	constructor(
		buckets: readonly number[] = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
	) {
		this.histogramBuckets = buckets;
	}

	// ─── Counter ────────────────────────────────────────────────────────────────

	/**
	 * Increment a counter by the given delta (default 1).
	 */
	increment(name: string, delta = 1, tags?: Record<string, string>): void {
		const key = this.key(name, tags);
		const samples = this.counters.get(key) ?? [];
		const last = samples[samples.length - 1];
		const newValue = {
			value: last ? last.value + delta : delta,
			timestamp: Date.now(),
		};
		samples.push(newValue);
		this.trim(samples, this.maxSamples);
		this.counters.set(key, samples);
	}

	/**
	 * Get the current counter value.
	 */
	getCounter(name: string, tags?: Record<string, string>): number {
		const key = this.key(name, tags);
		const samples = this.counters.get(key);
		return samples && samples.length > 0 ? samples[samples.length - 1]!.value : 0;
	}

	// ─── Gauge ──────────────────────────────────────────────────────────────────

	/**
	 * Set a gauge to the given value.
	 */
	setGauge(name: string, value: number, tags?: Record<string, string>): void {
		const key = this.key(name, tags);
		const samples = this.gauges.get(key) ?? [];
		samples.push({ value, timestamp: Date.now() });
		this.trim(samples, this.maxSamples);
		this.gauges.set(key, samples);
	}

	/**
	 * Get the current gauge value.
	 */
	getGauge(name: string, tags?: Record<string, string>): number {
		const key = this.key(name, tags);
		const samples = this.gauges.get(key);
		return samples && samples.length > 0 ? samples[samples.length - 1]!.value : 0;
	}

	// ─── Histogram ──────────────────────────────────────────────────────────────

	/**
	 * Record a value in a histogram.
	 */
	recordHistogram(name: string, value: number, tags?: Record<string, string>): void {
		const key = this.key(name, tags);
		const existing = this.histograms.get(key);

		const count = (existing?.count ?? 0) + 1;
		const sum = (existing?.sum ?? 0) + value;
		const min = existing ? Math.min(existing.min, value) : value;
		const max = existing ? Math.max(existing.max, value) : value;
		const buckets = this.computeBuckets(existing?.buckets ?? [], value);

		this.histograms.set(key, { count, sum, min, max, buckets });
	}

	/**
	 * Get histogram stats.
	 */
	getHistogram(name: string, tags?: Record<string, string>): HistogramValue | undefined {
		return this.histograms.get(this.key(name, tags));
	}

	// ─── Snapshot ───────────────────────────────────────────────────────────────

	/**
	 * Export a snapshot of all metrics for reporting.
	 */
	snapshot(): MetricsSnapshot {
		const snapshot: MetricsSnapshot = { counters: {}, gauges: {}, histograms: {} };

		for (const [key, samples] of this.counters) {
			snapshot.counters[key] = samples[samples.length - 1]?.value ?? 0;
		}
		for (const [key, samples] of this.gauges) {
			snapshot.gauges[key] = samples[samples.length - 1]?.value ?? 0;
		}
		for (const [key, hist] of this.histograms) {
			snapshot.histograms[key] = hist;
		}

		return snapshot;
	}

	// ─── Internal ───────────────────────────────────────────────────────────────

	private key(name: string, tags?: Record<string, string>): string {
		if (!tags || Object.keys(tags).length === 0) return name;
		const sorted = Object.entries(tags)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${k}=${v}`)
			.join(',');
		return `${name}{${sorted}}`;
	}

	private trim<T>(arr: T[], max: number): void {
		while (arr.length > max) arr.shift();
	}

	private computeBuckets(
		existing: readonly { upper: number; count: number }[],
		value: number,
	): { upper: number; count: number }[] {
		const result = existing.map((b) => ({ ...b }));
		for (const bucket of result) {
			if (value <= bucket.upper) {
				bucket.count++;
			}
		}
		return result;
	}
}

export interface MetricsSnapshot {
	readonly counters: Record<string, number>;
	readonly gauges: Record<string, number>;
	readonly histograms: Record<string, HistogramValue>;
}

// ─── Tracer ───────────────────────────────────────────────────────────────────

export interface Span {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: SpanKind;
	readonly startTime: number;
	readonly endTime?: number;
	readonly durationMs?: number;
	readonly status: SpanStatus;
	readonly tags: Record<string, string>;
	readonly logs: readonly SpanLog[];
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanLog {
	readonly timestamp: number;
	readonly fields: Record<string, string>;
}

/**
 * Distributed tracing with span lifecycle management.
 *
 * Per blueprint Section 16.3: job trace IDs with user-visible processing states.
 * Produces OpenTelemetry-compatible span structures.
 */
export class Tracer {
	private readonly spans = new Map<string, Span>();
	private readonly maxStoredSpans = 5000;

	/**
	 * Start a new root span.
	 */
	startSpan(name: string, kind: SpanKind = 'internal', tags?: Record<string, string>): SpanContext {
		const traceId = generateRequestId();
		const spanId = generateRequestId();
		const span: Span = {
			traceId,
			spanId,
			name,
			kind,
			startTime: Date.now(),
			status: 'unset',
			tags: tags ?? {},
			logs: [],
		};
		this.storeSpan(span);
		return new SpanContextImpl(this, span);
	}

	/**
	 * Start a child span within an existing span context.
	 */
	startChildSpan(
		parent: SpanContext,
		name: string,
		kind: SpanKind = 'internal',
		tags?: Record<string, string>,
	): SpanContext {
		const span: Span = {
			traceId: parent.span.traceId,
			spanId: generateRequestId(),
			parentSpanId: parent.span.spanId,
			name,
			kind,
			startTime: Date.now(),
			status: 'unset',
			tags: tags ?? {},
			logs: [],
		};
		this.storeSpan(span);
		return new SpanContextImpl(this, span);
	}

	/**
	 * Get a stored span by ID.
	 */
	getSpan(spanId: string): Span | undefined {
		return this.spans.get(spanId);
	}

	/**
	 * Get all spans for a trace.
	 */
	getTrace(traceId: string): readonly Span[] {
		return [...this.spans.values()].filter((s) => s.traceId === traceId);
	}

	/**
	 * Add a log event to a span.
	 */
	addSpanLog(spanId: string, fields: Record<string, string>): void {
		const span = this.spans.get(spanId);
		if (!span) return;
		// Spans are immutable in our model, so we replace
		this.spans.set(spanId, {
			...span,
			logs: [...span.logs, { timestamp: Date.now(), fields }],
		});
	}

	/**
	 * End a span with the given status.
	 */
	endSpan(spanId: string, status: SpanStatus = 'ok'): Span | undefined {
		const span = this.spans.get(spanId);
		if (!span) return undefined;
		const endTime = Date.now();
		const updated: Span = {
			...span,
			endTime,
			durationMs: endTime - span.startTime,
			status,
		};
		this.storeSpan(updated);
		return updated;
	}

	private storeSpan(span: Span): void {
		this.spans.set(span.spanId, span);
		// Trim if over limit
		if (this.spans.size > this.maxStoredSpans) {
			const oldest = [...this.spans.entries()]
				.sort(([, a], [, b]) => a.startTime - b.startTime)
				.slice(0, this.spans.size - this.maxStoredSpans);
			for (const [id] of oldest) {
				this.spans.delete(id);
			}
		}
	}
}

/**
 * Span context handle returned by startSpan/startChildSpan.
 */
export interface SpanContext {
	readonly span: Span;
	end(status?: SpanStatus): Span | undefined;
	addLog(fields: Record<string, string>): void;
	readonly child: (name: string, tags?: Record<string, string>) => SpanContext;
}

class SpanContextImpl implements SpanContext {
	constructor(
		private readonly tracer: Tracer,
		public readonly span: Span,
	) {}

	end(status: SpanStatus = 'ok'): Span | undefined {
		return this.tracer.endSpan(this.span.spanId, status);
	}

	addLog(fields: Record<string, string>): void {
		this.tracer.addSpanLog(this.span.spanId, fields);
	}

	child(name: string, tags?: Record<string, string>): SpanContext {
		return this.tracer.startChildSpan(this, name, 'internal', tags);
	}
}

// ─── ObservabilityModule ──────────────────────────────────────────────────────

export interface ObservabilityModule {
	readonly logger: Logger;
	readonly metrics: MetricsCollector;
	readonly tracer: Tracer;
	generateRequestId(): string;
}

/**
 * Combined observability facade for convenient initialization.
 */
export class DefaultObservabilityModule implements ObservabilityModule {
	readonly logger: Logger;
	readonly metrics: MetricsCollector;
	readonly tracer: Tracer;

	constructor(options: { logger?: Logger; metrics?: MetricsCollector; tracer?: Tracer } = {}) {
		this.logger = options.logger ?? new Logger();
		this.metrics = options.metrics ?? new MetricsCollector();
		this.tracer = options.tracer ?? new Tracer();
	}

	generateRequestId(): string {
		return generateRequestId();
	}
}

// ─── Convenience singletons ───────────────────────────────────────────────────

let defaultModule: DefaultObservabilityModule | null = null;

export function getObservability(): ObservabilityModule {
	if (!defaultModule) {
		defaultModule = new DefaultObservabilityModule();
	}
	return defaultModule;
}

export function setObservability(module: ObservabilityModule): void {
	defaultModule = module as DefaultObservabilityModule;
}

// ─── Middleware helpers ───────────────────────────────────────────────────────

export interface RequestContext {
	readonly requestId: string;
	readonly userId?: string;
	readonly tenantId?: string;
	readonly traceId?: string;
	readonly spanId?: string;
}

export function createRequestContext(
	overrides: Partial<RequestContext> = {},
): RequestContext {
	return {
		requestId: overrides.requestId ?? generateRequestId(),
		userId: overrides.userId,
		tenantId: overrides.tenantId,
		traceId: overrides.traceId,
		spanId: overrides.spanId,
	};
}
