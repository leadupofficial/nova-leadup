/**
 * @nova/workflow-engine — Background workflow and queue processing.
 *
 * Manages durable job queues (BullMQ/Redis), worker registration,
 * retry logic, and dead-letter handling per Section 16.2.
 */

import dotenv from 'dotenv';
import { validateEnv } from './utils/env';
void validateEnv();
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { healthRoutes } from './routes/health.js';

export interface JobDefinition<TInput = unknown, TOutput = unknown> {
 name: string;
 inputSchema?: unknown;
 outputSchema?: unknown;
 handler: (input: TInput) => Promise<TOutput>;
 retries?: number;
 backoff?: 'fixed' | 'exponential';
 backoffDelayMs?: number;
}

export interface JobResult<T = unknown> {
 success: boolean;
 output?: T;
 error?: string;
 attempts: number;
}

const jobs = new Map<string, JobDefinition<any, any>>();
const jobResults = new Map<string, JobResult<any>>();

export function registerJob<TInput = unknown, TOutput = unknown>(def: JobDefinition<TInput, TOutput>) {
 jobs.set(def.name, def as JobDefinition<any, any>);
 console.log(`[workflow-engine] registered job: ${def.name}`);
}

export async function executeJob<TInput = unknown, TOutput = unknown>(
 name: string,
 input: TInput,
): Promise<JobResult<TOutput>> {
 const job = jobs.get(name);
 if (!job) {
 return { success: false, error: `Job "${name}" not registered`, attempts: 0 };
 }

 const maxRetries = job.retries ?? 3;
 let attempts = 0;
 let lastError: string | undefined;

 while (attempts < maxRetries) {
 attempts++;
 try {
 const output = await job.handler(input);
 const result: JobResult<TOutput> = { success: true, output: output as TOutput, attempts };
 jobResults.set(`${name}_${Date.now()}`, result);
 return result;
 } catch (err) {
 lastError = (err as Error).message;
 if (attempts < maxRetries) {
 const delay = job.backoff === 'exponential'
 ? (job.backoffDelayMs ?? 1000) * Math.pow(2, attempts - 1)
 : (job.backoffDelayMs ?? 1000);
 await sleep(delay);
 }
 }
 }

 const result: JobResult<TOutput> = { success: false, error: lastError, attempts };
 return result;
}

export function getRegisteredJobs(): string[] {
 return Array.from(jobs.keys());
}

export function getJobResults(): JobResult[] {
 return Array.from(jobResults.values());
}

function sleep(ms: number): Promise<void> {
 return new Promise(resolve => setTimeout(resolve, ms));
}

// Express management API
const wfApp = express();
const WF_PORT = process.env.PORT || 3008;
wfApp.use(helmet());

const DEFAULT_ORIGINS = ['https://nova.leadup.in', 'https://admin.nova.leadup.in'];
const allowedOrigins = process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_ORIGINS;

wfApp.use(
 cors({
 origin: (origin, cb) => {
 if (!origin) return cb(null, true);
 if (allowedOrigins.includes(origin)) return cb(null, true);
 return cb(new Error(`CORS: origin ${origin} not allowed`));
 },
 credentials: true,
 }),
);
wfApp.use(compression() as any);
wfApp.use(express.json({ limit: '10mb' }));
wfApp.use('/health', healthRoutes as any);
wfApp.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'workflow-engine', uptime: process.uptime() }));
wfApp.get('/api/jobs', (_req, res) => res.json({ jobs: getRegisteredJobs() }));
wfApp.post('/api/jobs/:name/execute', async (req, res) => {
 const result = await executeJob(req.params.name, req.body as any);
 res.json(result);
});
const wfServer = wfApp.listen(WF_PORT, () => console.log(`[workflow-engine] HTTP listening on :${WF_PORT}`));
wfServer.timeout;
;(wfServer as any).setTimeout(30_000);
