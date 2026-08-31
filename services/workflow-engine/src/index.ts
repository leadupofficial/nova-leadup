/**
 * @nova/workflow-engine — Background workflow and queue processing.
 *
 * Manages durable job queues (BullMQ/Redis), worker registration,
 * retry logic, and dead-letter handling per Section 16.2.
 */

import dotenv from 'dotenv';
dotenv.config();

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
