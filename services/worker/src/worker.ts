/**
 * LEA-010 — Worker entry point.
 *
 * Initializes the recording processor and BullMQ queue consumer.
 * Processes recording jobs through the transcription pipeline.
 */

import 'dotenv/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { RecordingProcessor } from './recording-processor';
import { db } from '@nova/database';
import { Transcriber } from '@nova/voice';

// ─── Configuration ─────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const QUEUE_NAME = 'recording-processing';
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '2', 10);

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
 console.log('[worker] Starting recording processor worker');

 // Initialize Redis connection
 const redisConnection = new Redis(REDIS_URL, {
 maxRetriesPerRequest: 3,
 connectTimeout: 5000,
 });

 // Verify Redis connectivity
 try {
 await redisConnection.ping();
 console.log('[worker] Redis connection established');
 } catch (err) {
 console.error('[worker] Failed to connect to Redis:', err);
 process.exit(1);
 }

 // Initialize transcriber and processor
 const transcriber = new Transcriber();
 const processor = new RecordingProcessor({
 db,
 transcriber,
 });

 console.log(`[worker] Transcriber configured: ${transcriber.isConfigured()}`);

 // Create BullMQ queue connection
 const queue = new Queue(QUEUE_NAME, { connection: redisConnection });

 // Process jobs
 await queue.process('transcribe', CONCURRENCY, async (job) => {
 console.log(`[worker] Processing job ${job.id} for recording ${job.data.recordingId}`);

 try {
 const result = await processor.process(job.data);
 console.log(`[worker] Job ${job.id} completed: ${result.segmentsCreated} segments in ${result.latencyMs}ms`);
 return result;
 } catch (err) {
 console.error(`[worker] Job ${job.id} failed:`, err);
 throw err; // BullMQ will retry based on job options
 }
 });

 console.log(`[worker] Worker running — listening on queue "${QUEUE_NAME}" with concurrency ${CONCURRENCY}`);

 // Graceful shutdown
 const shutdown = async (signal: string) => {
 console.log(`[worker] Received ${signal}, shutting down gracefully...`);
 await queue.close();
 await redisConnection.quit();
 process.exit(0);
 };

 process.on('SIGTERM', () => shutdown('SIGTERM'));
 process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
 console.error('[worker] Fatal error:', err);
 process.exit(1);
});
