/**
 * Simple in-memory token bucket rate limiter.
 * Per-session limits to prevent any single session from overwhelming the gateway.
 */

interface RateLimiterEntry {
 tokens: number;
 lastRefill: number;
}

interface RateLimiterConfig {
 /** Max burst size (tokens per refill window) */
 capacity: number;
 /** Refill interval in milliseconds */
 refillMs: number;
 /** Tokens added per refill interval */
 refillAmount: number;
}

export interface RateLimiterResult {
 allowed: boolean;
 remaining: number;
 retryAfterMs: number;
}

export class RateLimiter {
 private entries: Map<string, RateLimiterEntry> = new Map();
 private config: RateLimiterConfig;
 private cleanupInterval: ReturnType<typeof setInterval>;

 constructor(config: RateLimiterConfig) {
 this.config = config;
 // Periodically clean up stale entries
 this.cleanupInterval = setInterval(() => this.cleanup(), config.refillMs * 2);
 }

 /**
 * Check and consume a token for the given key.
 * @returns Result indicating whether the request is allowed
 */
 check(key: string): RateLimiterResult {
 const now = Date.now();
 let entry = this.entries.get(key);

 if (!entry) {
 entry = {
 tokens: this.config.capacity,
 lastRefill: now,
 };
 this.entries.set(key, entry);
 }

 // Refill tokens based on elapsed time
 const elapsed = now - entry.lastRefill;
 const refills = Math.floor(elapsed / this.config.refillMs);
 if (refills > 0) {
 const added = refills * this.config.refillAmount;
 entry.tokens = Math.min(this.config.capacity, entry.tokens + added);
 entry.lastRefill += refills * this.config.refillMs;
 }

 if (entry.tokens >= 1) {
 entry.tokens -= 1;
 return {
 allowed: true,
 remaining: entry.tokens,
 retryAfterMs: 0,
 };
 }

 // Calculate retry time
 const deficit = 1 - entry.tokens;
 const retryAfterMs = Math.ceil((deficit * this.config.refillMs) / this.config.refillAmount);

 return {
 allowed: false,
 remaining: 0,
 retryAfterMs,
 };
 }

 /**
 * Remove the key from the rate limiter (e.g., when session ends).
 */
 reset(key: string): void {
 this.entries.delete(key);
 }

 /**
 * Get current token count for a key (for monitoring/debugging).
 */
 getTokens(key: string): number {
 const entry = this.entries.get(key);
 if (!entry) return this.config.capacity;

 // Apply refill without consuming
 const elapsed = Date.now() - entry.lastRefill;
 const refills = Math.floor(elapsed / this.config.refillMs);
 if (refills > 0) {
 return Math.min(this.config.capacity, entry.tokens + refills * this.config.refillAmount);
 }
 return entry.tokens;
 }

 private cleanup(): void {
 const now = Date.now();
 const maxAge = this.config.refillMs * 10; // Remove entries idle for 10+ refill windows
 for (const [key, entry] of this.entries) {
 if (now - entry.lastRefill > maxAge) {
 this.entries.delete(key);
 }
 }
 }

 destroy(): void {
 clearInterval(this.cleanupInterval);
 this.entries.clear();
 }
}

/**
 * Session-scoped rate limiter configuration.
 * Limits events per session per time window.
 */
export const SESSION_RATE_LIMIT_CONFIG: RateLimiterConfig = {
 capacity: 100, // Allow burst of 100 events
 refillMs: 1_000, // Refill every second
 refillAmount: 50, // 50 events per second sustained
};
