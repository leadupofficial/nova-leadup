import { type Server as SocketIOServer } from 'socket.io';
import { type CorsOptions } from 'cors';
import { z } from 'zod';

export interface ApiConfig {
	port: number;
	database: {
		host: string;
		port: number;
		database: string;
		user: string;
		password: string;
	};
	redis: {
		host: string;
		port: number;
	};
	storage: {
		endpoint: string;
		port: number;
		accessKey: string;
		secretKey: string;
		bucket: string;
	};
	jwt: {
		secret: string;
		refreshSecret: string;
		expiresIn: string;
	};
	cors: {
		origins: string[];
	};
	services: {
		anthropicApiKey: string;
		anthropicBaseUrl: string;
		broCodeKey: string;
		elevenlabsApiKey: string;
		deepgramApiKey: string;
		sarvamApiKey: string;
		googleCloudApiKey: string;
	};
}

// List of placeholders that are explicitly forbidden in production.
const FORBIDDEN_PLACEHOLDERS = [
	'change-me-in-production',
	'change-me-in-production-refresh',
	'',
];

function safeDefault(value: string | undefined, fallback: string, forbiddenCheck = false): string {
	if (value && value.length > 0) {
		if (forbiddenCheck && FORBIDDEN_PLACEHOLDERS.includes(value)) {
			throw new Error(`Refusing to use placeholder/empty value: ${value}`);
		}
		return value;
	}
	return fallback;
}

/**
 * The refresh-token secret is spelled `JWT_REFRESH_SECRET` throughout the monorepo
 * (services/api/.env, services/auth, packages/auth-*) but this module used to demand
 * `JWT_REFRESH_TOKEN_SECRET` only — so a production boot with the documented variable
 * name failed with "JWT_REFRESH_TOKEN_SECRET is required in production". Both names
 * are now accepted, with the monorepo-wide spelling taking precedence.
 */
function refreshSecretValue(): string | undefined {
	return process.env.JWT_REFRESH_SECRET ?? process.env.JWT_REFRESH_TOKEN_SECRET;
}

export function getEnvConfig(): ApiConfig {
	const nodeEnv = process.env.NODE_ENV || 'development';
	const isProd = nodeEnv === 'production';

	// JWT secrets are mandatory and must not be placeholders in production.
	if (isProd) {
		if (!process.env.JWT_SECRET || FORBIDDEN_PLACEHOLDERS.includes(process.env.JWT_SECRET)) {
			throw new Error('JWT_SECRET is required in production and must not be a placeholder');
		}
		const refreshSecret = refreshSecretValue();
		if (!refreshSecret || FORBIDDEN_PLACEHOLDERS.includes(refreshSecret)) {
			throw new Error(
				'JWT_REFRESH_SECRET (or JWT_REFRESH_TOKEN_SECRET) is required in production and must not be a placeholder',
			);
		}
	}

	return {
		port: Number(process.env.PORT) || 3001,
		database: {
			host: process.env.DB_HOST ?? 'localhost',
			port: Number(process.env.DB_PORT) || 5432,
			database: process.env.DB_NAME ?? 'nova',
			user: process.env.DB_USER ?? 'postgres',
			password: safeDefault(process.env.DB_PASSWORD, 'postgres'),
		},
		redis: {
			host: process.env.REDIS_HOST ?? 'localhost',
			port: Number(process.env.REDIS_PORT) || 6379,
		},
		storage: {
			endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
			port: Number(process.env.S3_PORT) || 9000,
			accessKey: safeDefault(process.env.S3_ACCESS_KEY, 'minioadmin'),
			secretKey: safeDefault(process.env.S3_SECRET_KEY, 'minioadmin'),
			bucket: process.env.S3_BUCKET ?? 'nova-assets',
		},
		jwt: {
			secret: safeDefault(process.env.JWT_SECRET, '', isProd),
			refreshSecret: safeDefault(refreshSecretValue(), '', isProd),
			// Three spellings are in circulation across the monorepo:
			// JWT_EXPIRES_IN (config.ts + services/api/.env), JWT_EXPIRY
			// (services/api/.env.example) and JWT_ACCESS_TTL (services/auth).
			// Accept all of them so a documented name is never silently ignored and the
			// 24h fallback is not used by accident.
			expiresIn:
				process.env.JWT_EXPIRES_IN ??
				process.env.JWT_EXPIRY ??
				process.env.JWT_ACCESS_TTL ??
				'24h',
		},
		cors: {
			origins: process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) || [
				'http://localhost:3000',
				'http://localhost:3004',
				'http://localhost:3005',
			],
		},
		services: {
			anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
			anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
			broCodeKey: process.env.BROCODE_API_KEY || '',
			elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
			deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
			sarvamApiKey: process.env.SARVAM_API_KEY || '',
			googleCloudApiKey: process.env.GOOGLE_CLOUD_API_KEY || '',
		},
	};
}

export const config = getEnvConfig();

export const validateEnv = (): void => {
	const schema = z.object({
		NODE_ENV: z.string().default('development'),
		PORT: z.string().default('3001'),
		DB_HOST: z.string().optional(),
		DB_PORT: z.string().optional(),
		DB_NAME: z.string().optional(),
		DB_USER: z.string().optional(),
		DB_PASSWORD: z.string().optional(),
		REDIS_HOST: z.string().optional(),
		REDIS_PORT: z.string().optional(),
		JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
		// Accept either spelling; validated explicitly below.
		JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters').optional(),
		JWT_REFRESH_TOKEN_SECRET: z.string().min(32, 'JWT_REFRESH_TOKEN_SECRET must be at least 32 characters').optional(),
		JWT_EXPIRES_IN: z.string().optional(),
		CORS_ORIGINS: z.string().optional(),
	});

	const result = schema.safeParse(process.env);
	if (!result.success) {
		console.error('Invalid environment:', result.error.format());
		process.exit(1);
	}

	// Security: the access and refresh secrets must differ so a compromised access
	// token cannot be used to forge refresh tokens (or vice versa).
	const access = process.env.JWT_SECRET;
	const refresh = refreshSecretValue();
	if (access && refresh && access === refresh) {
		console.error(
			'Invalid environment: JWT_SECRET and the refresh secret must be different values',
		);
		process.exit(1);
	}

	// Refuse to boot in production with placeholder JWT secrets.
	if (process.env.NODE_ENV === 'production') {
		if (FORBIDDEN_PLACEHOLDERS.includes(process.env.JWT_SECRET || '')) {
			console.error('Invalid environment: JWT_SECRET cannot be a placeholder in production');
			process.exit(1);
		}
		if (FORBIDDEN_PLACEHOLDERS.includes(refresh || '')) {
			console.error(
				'Invalid environment: JWT_REFRESH_SECRET cannot be a placeholder in production',
			);
			process.exit(1);
		}
	}
};
