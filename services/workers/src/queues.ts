import { Queue } from 'bullmq';
import { type WorkerHealth } from '@nova/types';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) ?? 6379;

export function createQueue(name: string): Queue {
 return new Queue(name, { connection: { host: REDIS_HOST, port: REDIS_PORT } });
}

export function getWorkerHealth(): WorkerHealth {
 return {
 status: 'healthy',
 timestamp: new Date(),
 workers: {
 transcription: { active: 0, waiting: 0, completed: 0, failed: 0 },
 },
 };
}
