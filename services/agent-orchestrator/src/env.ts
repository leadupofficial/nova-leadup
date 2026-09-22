import { z } from 'zod';

const DEFAULT_PORTS: Record<string, string> = {
 api: '3001',
 'realtime-gateway': '8080',
 'voice-api': '8082',
 'agent-orchestrator': '3002',
 auth: '3003',
};

export const EnvSchema = z.object({
 NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
 PORT: z.string().optional(),
 DATABASE_URL: z.string().url().optional(),
 JWT_SECRET: z.string().min(32).optional(),
 ANTHROPIC_API_KEY: z.string().optional(),
 REDIS_URL: z.string().url().optional(),
 ELEVENLABS_API_KEY: z.string().optional(),
 SARVAM_API_KEY: z.string().optional(),
 CORS_ORIGIN: z.string().default('http://localhost:19000'),
 ALLOWED_ORIGINS: z.string().default('http://localhost:19000'),
 LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(env: Record<string, string | undefined>): Env {
 const parsed = EnvSchema.safeParse(env);
 if (!parsed.success) {
 console.error('Invalid environment:', parsed.error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join(', '));
 process.exit(1);
 }
 if (env.NODE_ENV === 'production') {
 const required = ['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY'] as const;
 for (const key of required) {
 if (!env[key]) {
 console.error(`Missing required env: ${key}`);
 process.exit(1);
 }
 }
 if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
 console.error('JWT_SECRET must be at least 32 characters');
 process.exit(1);
 }
 }
 const serviceName = process.cwd().split('/').pop() || '';
 return { ...parsed.data, PORT: env.PORT || DEFAULT_PORTS[serviceName] || '3000' };
}
