import { Worker } from 'bullmq';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) ?? 6379;

const connection = { host: REDIS_HOST, port: REDIS_PORT };

// Example worker — processes transcription jobs
const transcriptionWorker = new Worker(
 'transcription-queue',
 async (job) => {
 console.log(`Processing job ${job.id}: ${job.name}`);
 // TODO: Implement transcription processing
 await new Promise((resolve) => setTimeout(resolve, 100));
 return { result: 'processed' };
 },
 { connection, concurrency: 5 }
);

transcriptionWorker.on('completed', (job) => {
 console.log(`Job ${job.id} completed`);
});

transcriptionWorker.on('failed', (job, err) => {
 console.error(`Job ${job?.id} failed:`, err);
});

process.on('SIGINT', async () => {
 await transcriptionWorker.close();
 process.exit(0);
});

console.log('Worker service started');
