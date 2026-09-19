import { z } from 'zod';

export type JobResult<T = void> = {
  success: boolean;
  output?: T;
  error?: string;
  attempts: number;
};

export type JobHandler<TInput = unknown, TOutput = unknown> = {
  name: string;
  handler: (input: TInput) => Promise<TOutput>;
  retries?: number;
  backoff?: 'fixed' | 'exponential';
  backoffDelayMs?: number;
  inputSchema?: z.ZodSchema<TInput>;
};

const jobs = new Map<string, JobHandler>();
const jobResults = new Map<string, JobResult>();

export function registerJob<TInput = unknown, TOutput = unknown>(job: JobHandler<TInput, TOutput>): void {
  jobs.set(job.name, job as unknown as JobHandler);
}

export function getRegisteredJobs(): string[] {
  return Array.from(jobs.keys());
}

export function clearJobs(): void {
  jobs.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

function safeParse<T>(schema: z.ZodSchema<T>, data: unknown): boolean {
  try {
    return schema.safeParse(data).success;
  } catch {
    return false;
  }
}

export async function executeJob<TInput = unknown, TOutput = unknown>(
  name: string,
  input: TInput,
): Promise<JobResult<TOutput>> {
  const job = jobs.get(name);
  if (!job) {
    return { success: false, error: `Job "${name}" not registered`, attempts: 0 };
  }

  if (job.inputSchema) {
    const parsed = safeParse(job.inputSchema, input);
    if (!parsed) {
      return {
        success: false,
        error: `Input validation failed for job "${name}"`,
        attempts: 0,
      };
    }
  }

  const maxRetries = job.retries ?? 3;
  const handlerTimeoutMs = 30_000;
  let attempts = 0;
  let lastError: string | undefined;

  while (attempts < maxRetries) {
    attempts++;
    try {
      const output = await withTimeout(
        job.handler(input),
        handlerTimeoutMs,
        `Job "${name}" timed out after ${handlerTimeoutMs}ms`,
      );
      const result: JobResult<TOutput> = { success: true, output: output as TOutput, attempts };
      jobResults.set(`${name}_${Date.now()}`, result as unknown as JobResult);
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
