import { Worker } from 'bullmq';
import { QueueScheduler } from 'bullmq';
import { createQueue, setRedisHealth } from './queues.js';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
// `Number(undefined)` is `NaN`, and `NaN ?? x` is `NaN` — the `??` never fired, so an
// unset REDIS_PORT silently became NaN instead of the default port. Default the raw
// value first, then convert.
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const connection = { host: REDIS_HOST, port: REDIS_PORT };

// QueueScheduler is required for retries, delayed jobs, and rate limits
const scheduler = new QueueScheduler('transcription-queue', { connection });

const transcriptionQueue = createQueue('transcription-queue');

// Dead-letter queue for jobs that exhausted all retry attempts
const deadLetterQueue = createQueue('transcription-queue-dlq');

const transcriptionWorker = new Worker(
  'transcription-queue',
  async (job) => {
    console.log(`Processing job ${job.id}: ${job.name}`);
    // TODO: Implement transcription processing
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { result: 'processed' };
  },
  { connection, concurrency: 5 },
);

transcriptionWorker.on('completed', (job) => {
  console.log(`Job ${job?.id} completed`);
});

transcriptionWorker.on('failed', async (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
  // Move jobs that exhausted all retries to the dead-letter queue
  if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
    try {
      await deadLetterQueue.add(
        `dlq-${job.name}`,
        {
          originalJobId: job.id,
          name: job.name,
          data: job.data,
          failedReason: err.message,
          attemptsMade: job.attemptsMade,
          timestamp: new Date().toISOString(),
        },
        { jobId: `dlq-${job.id}` },
      );
      console.log(`Job ${job.id} moved to dead-letter queue`);
    } catch (dlqErr) {
      console.error(`Failed to move job ${job?.id} to DLQ:`, (dlqErr as Error).message);
    }
  }
  setRedisHealth(false);
});

transcriptionWorker.on('error', (err) => {
  console.error('Worker error:', err);
});

process.on('SIGINT', async () => {
  await transcriptionWorker.close();
  await scheduler.close();
  process.exit(0);
});

console.log('Worker service started');
