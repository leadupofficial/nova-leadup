import { randomBytes } from 'crypto';

export function generateId(prefix = 'id'): string {
 const bytes = randomBytes(16);
 const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
 return `${prefix}_${hex}`;
}

export function isValidEmail(email: string): boolean {
 const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 return emailRegex.test(email);
}

export function sanitizeString(input: string, maxLength = 255): string {
 return input.trim().slice(0, maxLength).replace(/[<>]/g, '');
}

export function sleep(ms: number): Promise<void> {
 return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retry<T>(
 fn: () => Promise<T>,
 options: { maxRetries?: number; delayMs?: number; backoff?: number } = {}
): Promise<T> {
 const { maxRetries = 3, delayMs = 1000, backoff = 2 } = options;
 let attempt = 0;

 async function attemptFn(): Promise<T> {
 try {
 return await fn();
 } catch (error) {
 attempt++;
 if (attempt >= maxRetries) {
 throw error;
 }
 await sleep(delayMs * Math.pow(backoff, attempt - 1));
 return attemptFn();
 }
 }

 return attemptFn();
}
