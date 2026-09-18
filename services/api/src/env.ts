import { z } from 'zod';

export const envSchema = z.object({
	NODE_ENV: z.string().default('development'),
	PORT: z.string().default('3001'),
	DB_HOST: z.string().default('localhost'),
	DB_PORT: z.string().default('5432'),
	DB_NAME: z.string().default('nova'),
	DB_USER: z.string().default('postgres'),
	DB_PASSWORD: z.string().default('postgres'),
	REDIS_HOST: z.string().default('localhost'),
	REDIS_PORT: z.string().default('6379'),
	JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
	JWT_REFRESH_TOKEN_SECRET: z.string().min(32, 'JWT_REFRESH_TOKEN_SECRET must be at least 32 characters'),
	JWT_EXPIRES_IN: z.string().optional(),
	CORS_ORIGINS: z.string().optional(),
	REDIS_URL: z.string().optional(),
	S3_ENDPOINT: z.string().optional(),
	S3_PORT: z.string().optional(),
	S3_ACCESS_KEY: z.string().optional(),
	S3_SECRET_KEY: z.string().optional(),
	S3_BUCKET: z.string().optional(),
	ANTHROPIC_API_KEY: z.string().optional(),
	ANTHROPIC_BASE_URL: z.string().optional(),
	ANTHROPIC_AUTH_HEADER: z.string().optional(),
	BROCODE_API_KEY: z.string().optional(),
	ELEVENLABS_API_KEY: z.string().optional(),
	DEEPGRAM_API_KEY: z.string().optional(),
	SARVAM_API_KEY: z.string().optional(),
	GOOGLE_CLOUD_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(env: Record<string, string | undefined>): Env {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		console.error('Invalid environment configuration:', result.error.format());
		process.exit(1);
	}

	const validated = result.data;

	// Production guards for placeholder/empty secrets
	if (validated.NODE_ENV === 'production') {
		const placeholders = ['change-me-in-production', 'change-me-in-production-refresh', ''];

		if (placeholders.includes(validated.JWT_SECRET)) {
			console.error('JWT_SECRET cannot be a placeholder in production');
			process.exit(1);
		}
		if (placeholders.includes(validated.JWT_REFRESH_TOKEN_SECRET)) {
			console.error('JWT_REFRESH_TOKEN_SECRET cannot be a placeholder in production');
			process.exit(1);
		}

		if (!validated.ANTHROPIC_API_KEY && !validated.BROCODE_API_KEY) {
			console.error('Production requires ANTHROPIC_API_KEY or BROCODE_API_KEY');
			process.exit(1);
		}
	}

	return validated;
}
