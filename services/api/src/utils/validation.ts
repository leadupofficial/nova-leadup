/**
 * Validation utilities for API endpoints
 */

export interface ValidationResult {
 valid: boolean;
 errors: string[];
}

/**
 * Validate registration input
 */
export function validateRegistration(data: {
 email?: string;
 password?: string;
 firstName?: string;
 lastName?: string;
}): ValidationResult {
 const errors: string[] = [];

 if (!data.email) {
 errors.push('Email is required');
 } else if (!isValidEmail(data.email)) {
 errors.push('Invalid email format');
 }

 if (!data.password) {
 errors.push('Password is required');
 } else if (data.password.length < 12) {
 // Kept in step with `PASSWORD_MIN_LENGTH` in `schemas/index.ts`. This helper is not
 // imported anywhere today, but a third, weaker rule sitting in the tree is a trap for
 // whoever wires it up next.
 errors.push('Password must be at least 12 characters');
 } else if (!hasUpperCase(data.password)) {
 errors.push('Password must contain at least one uppercase letter');
 } else if (!hasLowerCase(data.password)) {
 errors.push('Password must contain at least one lowercase letter');
 } else if (!hasNumber(data.password)) {
 errors.push('Password must contain at least one number');
 }

 if (!data.firstName || data.firstName.trim().length === 0) {
 errors.push('First name is required');
 }

 if (!data.lastName || data.lastName.trim().length === 0) {
 errors.push('Last name is required');
 }

 return {
 valid: errors.length === 0,
 errors,
 };
}

/**
 * Validate login input
 */
export function validateLogin(data: {
 email?: string;
 password?: string;
}): ValidationResult {
 const errors: string[] = [];

 if (!data.email) {
 errors.push('Email is required');
 } else if (!isValidEmail(data.email)) {
 errors.push('Invalid email format');
 }

 if (!data.password) {
 errors.push('Password is required');
 }

 return {
 valid: errors.length === 0,
 errors,
 };
}

/**
 * Validate lead input
 */
export function validateLead(data: {
 name?: string;
 email?: string;
 phone?: string;
 company?: string;
}): ValidationResult {
 const errors: string[] = [];

 if (!data.name || data.name.trim().length === 0) {
 errors.push('Lead name is required');
 }

 if (!data.email) {
 errors.push('Email is required');
 } else if (!isValidEmail(data.email)) {
 errors.push('Invalid email format');
 }

 if (data.phone && !isValidPhone(data.phone)) {
 errors.push('Invalid phone number format');
 }

 return {
 valid: errors.length === 0,
 errors,
 };
}

/**
 * Validate phone number (basic international format check)
 */
function isValidPhone(phone: string): boolean {
 // Remove all non-digit characters except leading +
 const cleaned = phone.replace(/[^\d+]/g, '');
 // Check if it matches international format: +1234567890 (10-15 digits)
 return /^\+?[\d\s-()]{10,20}$/.test(phone);
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
 const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 return emailRegex.test(email);
}

/**
 * Check if string contains uppercase letter
 */
function hasUpperCase(str: string): boolean {
 return /[A-Z]/.test(str);
}

/**
 * Check if string contains lowercase letter
 */
function hasLowerCase(str: string): boolean {
 return /[a-z]/.test(str);
}

/**
 * Check if string contains number
 */
function hasNumber(str: string): boolean {
 return /\d/.test(str);
}

/**
 * Sanitize string input to prevent XSS
 */
export function sanitizeString(input: string): string {
 return input
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;')
 .replace(/'/g, '&#039;');
}
