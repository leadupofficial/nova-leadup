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
 expiresIn: string;
 };
 cors: {
 origins: string[];
 };
}

export function getEnvConfig(): ApiConfig {
 return {
 port: Number(process.env.PORT) || 3001,
 database: {
 host: process.env.DB_HOST ?? 'localhost',
 port: Number(process.env.DB_PORT) ?? 5432,
 database: process.env.DB_NAME ?? 'nova',
 user: process.env.DB_USER ?? 'postgres',
 password: process.env.DB_PASSWORD ?? 'postgres',
 },
 redis: {
 host: process.env.REDIS_HOST ?? 'localhost',
 port: Number(process.env.REDIS_PORT) ?? 6379,
 },
 storage: {
 endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
 port: Number(process.env.S3_PORT) ?? 9000,
 accessKey: process.env.S3_ACCESS_KEY ?? 'minioadmin',
 secretKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
 bucket: process.env.S3_BUCKET ?? 'nova-assets',
 },
 jwt: {
 secret: process.env.JWT_SECRET ?? 'change-me-in-production',
 expiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
 },
 cors: {
 origins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3004', 'http://localhost:3005'],
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
 JWT_SECRET: z.string().min(32),
 JWT_EXPIRES_IN: z.string().optional(),
 CORS_ORIGINS: z.string().optional(),
 });

 const result = schema.safeParse(process.env);
 if (!result.success) {
 console.error('Invalid environment:', result.error.format());
 process.exit(1);
 }
};
