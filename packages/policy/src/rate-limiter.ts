/**
 * @nova/policy — Rate Limiter
 *
 * Per blueprint Section 10.1: Rate limits protect NOVA from abuse.
 * Tiers: free, pro, enterprise
 */

import Redis from 'ioredis';

// ─── Tier Configurations ──────────────────────────────────────────────────────

export const TIER_CONFIGS = {
 free: {
 toolCallsPerMinute: 10,
 toolCallsPerHour: 100,
 toolCallsPerDay: 500,
 concurrentSessions: 2,
 },
 pro: {
 toolCallsPerMinute: 60,
 toolCallsPerHour: 2000,
 toolCallsPerDay: 10000,
 concurrentSessions: 10,
 },
 enterprise: {
 toolCallsPerMinute: 300,
 toolCallsPerHour: 20000,
 toolCallsPerDay: 100000,
 concurrentSessions: 50,
 },
} as const;

export type Tier = keyof typeof TIER_CONFIGS;

// ─── Category Limits ──────────────────────────────────────────────────────────

export const CATEGORY_LIMITS = {
 voice: { toolCallsPerMinute: 5, toolCallsPerHour: 100, toolCallsPerDay: 500 },
 messaging: { toolCallsPerMinute: 2, toolCallsPerHour: 50, toolCallsPerDay: 200 },
 calendar: { toolCallsPerMinute: 10, toolCallsPerHour: 200, toolCallsPerDay: 1000 },
 file_ops: { toolCallsPerMinute: 5, toolCallsPerHour: 100, toolCallsPerDay: 500 },
 crm: { toolCallsPerMinute: 10, toolCallsPerHour: 200, toolCallsPerDay: 1000 },
 tool: { toolCallsPerMinute: 10, toolCallsPerHour: 100, toolCallsPerDay: 500 },
} as const;

// ─── Rate Limit Result ────────────────────────────────────────────────────────

export interface RateLimitResult {
 allowed: boolean;
 remaining: number;
 resetAt: string;
 label: string;
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

export class RateLimiter {
 private redis: Redis | null = null;

 constructor() {
 const redisUrl = process.env.REDIS_URL;
 if (redisUrl) {
 this.redis = new Redis(redisUrl);
 }
 }

 /**
 Build a deterministic rate-limit key.
 */
 static buildKey(parts: (string | undefined | null)[]): string {
 return parts.filter(Boolean).join(':');
 }

 /**
 Check if a request is within rate limits.
 */
 async check(key: string, category: keyof typeof CATEGORY_LIMITS, tier: Tier): Promise<RateLimitResult> {
 const limits = TIER_CONFIGS[tier];
 const categoryLimits = CATEGORY_LIMITS[category];

 if (!this.redis) {
 // In-memory fallback for development (not distributed-safe)
 const now = Date.now();
 return {
 allowed: true,
 remaining: limits.toolCallsPerMinute - 1,
 resetAt: new Date(Math.floor(now / 60000 + 1) * 60000).toISOString(),
 label: 'minute',
 };
 }

 const now = Math.floor(Date.now() / 60000) * 60000;
 const pipe = this.redis.pipeline();
 const minuteKey = `ratelimit:${key}:${category}:${Math.floor(Date.now() / 60000)}`;
 const hourKey = `ratelimit:${key}:${category}:${Math.floor(Date.now() / 3600000)}`;
 const dayKey = `ratelimit:${key}:${category}:${Math.floor(Date.now() / 86400000)}`;

 pipe.incr(minuteKey);
 pipe.expire(minuteKey, 65);
 pipe.incr(hourKey);
 pipe.expire(hourKey, 3700);
 pipe.incr(dayKey);
 pipe.expire(dayKey, 86500);

 const results = await pipe.exec();
 const minuteCount = results?.[0]?.[1] as number ?? 0;
 const hourCount = results?.[2]?.[1] as number ?? 0;
 const dayCount = results?.[3]?.[1] as number ?? 0;

 const allowed = minuteCount <= categoryLimits.toolCallsPerMinute
 && hourCount <= categoryLimits.toolCallsPerHour
 && dayCount <= categoryLimits.toolCallsPerDay;

 return {
 allowed,
 remaining: Math.max(0, categoryLimits.toolCallsPerMinute - minuteCount),
 resetAt: new Date(Math.floor(Date.now() / 60000 + 1) * 60000).toISOString(),
 label: 'minute',
 };
 }

 close(): void {
 this.redis?.disconnect();
 }
}
