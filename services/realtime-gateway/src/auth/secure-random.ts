/**
 * Secure random number generator using Node.js crypto module.
 *
 * Fixes critical security vulnerability where Math.random() was used for
 * session IDs and tokens, making them predictable and forgeable.
 *
 * SECURITY: Never use Math.random() for security-sensitive values.
 */

import crypto from 'crypto';

/**
 * Generate a cryptographically secure random hexadecimal string.
 *
 * @param length - Number of hex characters to generate (default: 32)
 * @returns A hex string of the specified length
 */
export function secureRandomHex(length = 32): string {
 // Each byte produces 2 hex characters
 const bytesNeeded = Math.ceil(length / 2);
 const bytes = crypto.randomBytes(bytesNeeded);
 return bytes.toString('hex').slice(0, length);
}

/**
 * Generate a cryptographically secure random session ID.
 *
 * Format: 32-character hex string suitable for use as a session identifier.
 *
 * @returns A secure session ID
 */
export function generateSessionId(): string {
 return secureRandomHex(32);
}

/**
 * Generate a cryptographically secure conversation ID.
 *
 * @returns A secure conversation ID
 */
export function generateConversationId(): string {
 return secureRandomHex(16);
}

/**
 * Generate a cryptographically secure token (e.g., for temporary auth tokens).
 *
 * @returns A secure token string
 */
export function generateSecureToken(): string {
 // 32 bytes = 256 bits of entropy, suitable for tokens
 return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate that a string looks like a valid hex-encoded secure token.
 *
 * @param value - The value to validate
 * @param expectedLength - Expected length in characters (default: 32)
 * @returns true if the value is a valid hex string of the expected length
 */
export function isValidSecureToken(value: string, expectedLength = 32): boolean {
 return /^[0-9a-f]+$/i.test(value) && value.length === expectedLength;
}
