/**
 * Prometheus metrics for @nova/admin.
 */
import promClient from 'prom-client';
import type { Request, Response } from 'express';

export const metricRegistry = new promClient.Registry();

// Default metrics (memory, cpu, event loop lag, etc.)
promClient.collectDefaultMetrics({ register: metricRegistry });

// HTTP request duration
export const httpRequestDuration = new promClient.Histogram({
 name: 'http_request_duration_seconds',
 help: 'HTTP request latency in seconds',
 labelNames: ['method', 'route', 'status_code'],
 buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
 registers: [metricRegistry],
});

// HTTP request count
export const httpRequestTotal = new promClient.Counter({
 name: 'http_requests_total',
 help: 'Total HTTP requests',
 labelNames: ['method', 'route', 'status_code'],
 registers: [metricRegistry],
});

// Active sessions
export const activeSessions = new promClient.Gauge({
 name: 'active_sessions',
 help: 'Number of active sessions',
 labelNames: ['organization_id'],
 registers: [metricRegistry],
});

// First-audio latency
export const firstAudioLatency = new promClient.Histogram({
 name: 'first_audio_latency_seconds',
 help: 'Time from user start to first audio response',
 labelNames: ['organization_id'],
 buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
 registers: [metricRegistry],
});

// STT latency
export const sttLatency = new promClient.Histogram({
 name: 'stt_latency_seconds',
 help: 'Speech-to-text processing latency',
 labelNames: ['organization_id'],
 buckets: [0.1, 0.25, 0.5, 1, 2, 5],
 registers: [metricRegistry],
});

// TTS latency
export const ttsLatency = new promClient.Histogram({
 name: 'tts_latency_seconds',
 help: 'Text-to-speech generation latency',
 labelNames: ['organization_id'],
 buckets: [0.1, 0.25, 0.5, 1, 2, 5],
 registers: [metricRegistry],
});

// Claude cost (cents)
export const claudeCostCents = new promClient.Counter({
 name: 'claude_cost_cents_total',
 help: 'Total Claude API cost in cents',
 labelNames: ['organization_id', 'model'],
 registers: [metricRegistry],
});

// Tool execution success rate
export const toolSuccessRate = new promClient.Gauge({
 name: 'tool_success_rate',
 help: 'Tool execution success rate (0-1)',
 labelNames: ['tool_name'],
 registers: [metricRegistry],
});

// Queue depth
export const queueDepth = new promClient.Gauge({
 name: 'queue_depth',
 help: 'Current queue depth by queue name',
 labelNames: ['queue_name'],
 registers: [metricRegistry],
});

// Error tracking counter
export const errorTotal = new promClient.Counter({
 name: 'errors_total',
 help: 'Total errors by category',
 labelNames: ['category', 'severity'],
 registers: [metricRegistry],
});

export function getMiddleware() {
 return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
 const start = Date.now();
 res.on('finish', () => {
 const duration = (Date.now() - start) / 1000;
 const labels = { method: req.method, route: req.route?.path ?? req.path, status_code: String(res.statusCode) };
 httpRequestDuration.observe(labels, duration);
 httpRequestTotal.inc(labels);
 });
 next();
 };
}
