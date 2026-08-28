import { type Server as SocketIOServer } from 'socket.io';

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
 };
}
