import { z } from 'zod';

export const config = {
 nodeEnv: process.env.NODE_ENV || 'development',
 port: parseInt(process.env.PORT || '3001', 10),
 apiPrefix: '/api/v1',

 database: {
 url: process.env.DATABASE_URL || 'postgres://localhost:5432/nova',
 pool: {
 min: parseInt(process.env.DB_POOL_MIN || '2', 10),
 max: parseInt(process.env.DB_POOL_MAX || '10', 10),
 },
 },

 redis: {
 url: process.env.REDIS_URL || 'redis://localhost:6379',
 ttl: parseInt(process.env.REDIS_TTL || '3600', 10),
 },

 anthropic: {
 apiKey: process.env.ANTHROPIC_API_KEY || '',
 model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-20250929',
 maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096', 10),
 },

 openai: {
 apiKey: process.env.OPENAI_API_KEY || '',
 },

 cors: {
 origins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:19006'],
 },

 auth: {
 jwtSecret: process.env.JWT_SECRET || 'nova-dev-secret-change-in-production',
 jwtExpiry: process.env.JWT_EXPIRY || '7d',
 refreshTokenExpiry: process.env.REFRESH_TOKEN_EXPIRY || '30d',
 },
};

export const validateEnv = () => {
 const schema = z.object({
 NODE_ENV: z.string().default('development'),
 PORT: z.string().default('3001'),
 DATABASE_URL: z.string().url(),
 REDIS_URL: z.string().url().default('redis://localhost:6379'),
 ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
 JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
 });

 const result = schema.safeParse(process.env);
 if (!result.success) {
 console.error('Invalid environment variables:', result.error.format());
 process.exit(1);
 }
};
