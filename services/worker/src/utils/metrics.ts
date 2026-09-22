/**
 * Worker metrics — simple in-memory counters for Prometheus or log-based monitoring.
 */

export interface WorkerMetrics {
	jobsProcessed: number;
	jobsFailed: number;
	jobsRetried: number;
	totalProcessingMs: number;
	queueDepths: Map<string, number>;
}

export class MetricsCollector {
	private metrics: WorkerMetrics = {
		jobsProcessed: 0,
		jobsFailed: 0,
		jobsRetried: 0,
		totalProcessingMs: 0,
		queueDepths: new Map(),
	};

	recordJob(queueName: string, durationMs: number, failed = false, retried = false): void {
		this.metrics.jobsProcessed++;
		this.metrics.totalProcessingMs += durationMs;
		if (failed) this.metrics.jobsFailed++;
		if (retried) this.metrics.jobsRetried++;
		this.metrics.queueDepths.set(queueName, Math.max(0, (this.metrics.queueDepths.get(queueName) ?? 0) - 1));
	}

	recordEnqueued(queueName: string): void {
		this.metrics.queueDepths.set(queueName, (this.metrics.queueDepths.get(queueName) ?? 0) + 1);
	}

	getSnapshot() {
		return { ...this.metrics, avgProcessingMs: this.metrics.jobsProcessed > 0 ? this.metrics.totalProcessingMs / this.metrics.jobsProcessed : 0, queueDepths: Object.fromEntries(this.metrics.queueDepths) };
	}

	reset(): void {
		this.metrics = {
			jobsProcessed: 0,
			jobsFailed: 0,
			jobsRetried: 0,
			totalProcessingMs: 0,
			queueDepths: new Map(),
		};
	}
}

export const workerMetrics = new MetricsCollector();
