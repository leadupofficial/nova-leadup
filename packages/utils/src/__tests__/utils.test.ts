import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateId, isValidEmail, sanitizeString, sleep, retry } from '../index.js';

describe('generateId', () => {
 it('uses default prefix "id"', () => {
 const result = generateId();
 expect(result.startsWith('id_')).toBe(true);
 });

 it('uses custom prefix', () => {
 const result = generateId('usr');
 expect(result.startsWith('usr_')).toBe(true);
 });

 it('returns a string', () => {
 expect(typeof generateId()).toBe('string');
 });

 it('produces unique values', () => {
 const ids = new Set(Array.from({ length: 100 }, () => generateId()));
 expect(ids.size).toBe(100);
 });

 it('has consistent length', () => {
 const ids = Array.from({ length: 10 }, () => generateId());
 const lengths = ids.map((id) => id.length);
 expect(new Set(lengths).size).toBe(1);
 expect(lengths[0]).toBeGreaterThan(10);
 });

 it('contains hex characters after prefix', () => {
 const result = generateId('test');
 const hexPart = result.slice('test_'.length);
 expect(hexPart).toMatch(/^[0-9a-f]+$/);
 });
});

describe('isValidEmail', () => {
 it('returns true for valid emails', () => {
 expect(isValidEmail('user@example.com')).toBe(true);
 expect(isValidEmail('user.name@domain.co')).toBe(true);
 expect(isValidEmail('a@b.c')).toBe(true);
 expect(isValidEmail('test+tag@example.com')).toBe(true);
 });

 it('returns false for invalid emails', () => {
 expect(isValidEmail('not-an-email')).toBe(false);
 expect(isValidEmail('@example.com')).toBe(false);
 expect(isValidEmail('test@')).toBe(false);
 expect(isValidEmail('test@.com')).toBe(false);
 expect(isValidEmail('')).toBe(false);
 expect(isValidEmail('test @example.com')).toBe(false);
 expect(isValidEmail('test@example')).toBe(false);
 });

 it('rejects multiple @ symbols', () => {
 expect(isValidEmail('test@@example.com')).toBe(false);
 });

 it('rejects emails with no domain part', () => {
 expect(isValidEmail('test@')).toBe(false);
 });
});

describe('sanitizeString', () => {
 it('trims whitespace', () => {
 expect(sanitizeString(' hello ')).toBe('hello');
 });

 it('strips angle brackets', () => {
 expect(sanitizeString('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
 });

 it('truncates to maxLength', () => {
 const long = 'a'.repeat(300);
 expect(sanitizeString(long, 100)).toHaveLength(100);
 });

 it('uses default maxLength of 255', () => {
 const long = 'a'.repeat(300);
 expect(sanitizeString(long)).toHaveLength(255);
 });

 it('returns empty string for empty input', () => {
 expect(sanitizeString('')).toBe('');
 });

 it('handles strings at exactly maxLength', () => {
 const exact = 'a'.repeat(255);
 expect(sanitizeString(exact)).toHaveLength(255);
 });

 it('does not truncate strings shorter than maxLength', () => {
 expect(sanitizeString('short')).toBe('short');
 });

 it('removes both opening and closing brackets', () => {
 expect(sanitizeString('<div>content</div>')).toBe('divcontent/div');
 });
});

describe('sleep', () => {
 it('returns a Promise', () => {
 expect(sleep(100)).toBeInstanceOf(Promise);
 });

 it('resolves after the specified time', async () => {
 vi.useFakeTimers();
 const promise = sleep(100);
 await vi.advanceTimersByTimeAsync(100);
 await expect(promise).resolves.toBeUndefined();
 vi.useRealTimers();
 });
});

describe('retry', () => {
 beforeEach(() => {
 vi.useFakeTimers();
 });

 afterEach(() => {
 vi.useRealTimers();
 });

 it('succeeds on first try', async () => {
 const fn = vi.fn().mockResolvedValue('success');
 const promise = retry(fn, { maxRetries: 3, delayMs: 100 });
 await vi.runAllTimersAsync();
 const result = await promise;
 expect(result).toBe('success');
 expect(fn).toHaveBeenCalledTimes(1);
 });

 it('retries on failure and eventually succeeds', async () => {
 const fn = vi.fn()
 .mockRejectedValueOnce(new Error('fail 1'))
 .mockRejectedValueOnce(new Error('fail 2'))
 .mockResolvedValue('success');

 const promise = retry(fn, { maxRetries: 3, delayMs: 100 });
 await vi.runAllTimersAsync();
 const result = await promise;
 expect(result).toBe('success');
 expect(fn).toHaveBeenCalledTimes(3);
 });

 it('throws after maxRetries exceeded', async () => {
 const fn = vi.fn().mockRejectedValue(new Error('always fails'));
 const promise = retry(fn, { maxRetries: 2, delayMs: 100 });
 const assertion = expect(promise).rejects.toThrow('always fails');
 await vi.runAllTimersAsync();
await assertion;
 expect(fn).toHaveBeenCalledTimes(2);
 });

 it('respects custom maxRetries', async () => {
 const fn = vi.fn().mockRejectedValue(new Error('fail'));
 const promise = retry(fn, { maxRetries: 5, delayMs: 10 });
 const assertion = expect(promise).rejects.toThrow('fail');
 await vi.runAllTimersAsync();
await assertion;
 expect(fn).toHaveBeenCalledTimes(5);
 });

 it('applies exponential backoff between retries', async () => {
 const callTimes: number[] = [];
 const fn = vi.fn()
 .mockImplementationOnce(() => {
 callTimes.push(Date.now());
 return Promise.reject(new Error('fail 1'));
 })
 .mockImplementationOnce(() => {
 callTimes.push(Date.now());
 return Promise.reject(new Error('fail 2'));
 })
 .mockResolvedValue('success');

 const startTime = Date.now();
 const promise = retry(fn, { maxRetries: 3, delayMs: 100, backoff: 2 });
 await vi.runAllTimersAsync();
 const result = await promise;

 expect(result).toBe('success');
 expect(fn).toHaveBeenCalledTimes(3);
 // Delays: 100ms (1st retry), 200ms (2nd retry) = 300ms total minimum
 const elapsed = callTimes[1] - callTimes[0];
 expect(elapsed).toBeGreaterThanOrEqual(100);
 });
});
