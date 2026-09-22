/**
 * Shared validation utilities for NOVA Leadup
 */

export interface ValidationResult {
 isValid: boolean;
 errors: string[];
}

/**
 * Validates an email address format
 */
export function validateEmail(email: string): ValidationResult {
 const errors: string[] = [];

 if (!email || typeof email !== 'string') {
 errors.push('Email is required');
 return { isValid: false, errors };
 }

 const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 if (!emailRegex.test(email.trim())) {
 errors.push('Invalid email format');
 }

 if (email.length > 254) {
 errors.push('Email must not exceed 254 characters');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a phone number format (E.164)
 */
export function validatePhone(phone: string): ValidationResult {
 const errors: string[] = [];

 if (!phone || typeof phone !== 'string') {
 errors.push('Phone number is required');
 return { isValid: false, errors };
 }

 const cleaned = phone.replace(/[\s\-\(\)\.]/g, '');

 const phoneRegex = /^\+?[1-9]\d{6,14}$/;
 if (!phoneRegex.test(cleaned)) {
 errors.push('Invalid phone number format (E.164 required)');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a password meets strength requirements
 */
export function validatePassword(password: string): ValidationResult {
 const errors: string[] = [];

 if (!password || typeof password !== 'string') {
 errors.push('Password is required');
 return { isValid: false, errors };
 }

 if (password.length < 8) {
 errors.push('Password must be at least 8 characters long');
 }

 if (password.length > 128) {
 errors.push('Password must not exceed 128 characters');
 }

 if (!/[A-Z]/.test(password)) {
 errors.push('Password must contain at least one uppercase letter');
 }

 if (!/[a-z]/.test(password)) {
 errors.push('Password must contain at least one lowercase letter');
 }

 if (!/[0-9]/.test(password)) {
 errors.push('Password must contain at least one number');
 }

 if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
 errors.push('Password must contain at least one special character');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a UUID v4 format
 */
export function validateUUID(id: string): ValidationResult {
 const errors: string[] = [];

 if (!id || typeof id !== 'string') {
 errors.push('ID is required');
 return { isValid: false, errors };
 }

 const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if (!uuidRegex.test(id)) {
 errors.push('Invalid UUID format');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a JWT token format
 */
export function validateJWT(token: string): ValidationResult {
 const errors: string[] = [];

 if (!token || typeof token !== 'string') {
 errors.push('Token is required');
 return { isValid: false, errors };
 }

 const jwtRegex = /^[A-Za-z0-9-_]+\.([A-Za-z0-9-_]+)\.([A-Za-z0-9-_]+)$/;
 if (!jwtRegex.test(token)) {
 errors.push('Invalid JWT format');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a numeric ID (must be positive integer)
 */
export function validateNumericId(id: unknown): ValidationResult {
 const errors: string[] = [];

 if (id === null || id === undefined) {
 errors.push('ID is required');
 return { isValid: false, errors };
 }

 const num = typeof id === 'number' ? id : parseInt(String(id), 10);

 if (isNaN(num) || !Number.isInteger(num) || num <= 0) {
 errors.push('ID must be a positive integer');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a string length range
 */
export function validateStringLength(
 value: string,
 min: number,
 max: number,
 fieldName = 'Field'
): ValidationResult {
 const errors: string[] = [];

 if (typeof value !== 'string') {
 errors.push(`${fieldName} must be a string`);
 return { isValid: false, errors };
 }

 if (value.length < min) {
 errors.push(`${fieldName} must be at least ${min} characters`);
 }

 if (value.length > max) {
 errors.push(`${fieldName} must not exceed ${max} characters`);
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates that a value is one of the allowed enum values
 */
export function validateEnum<T extends string>(
 value: unknown,
 allowedValues: readonly T[],
 fieldName = 'Field'
): ValidationResult & { value?: T } {
 const errors: string[] = [];

 if (typeof value !== 'string') {
 errors.push(`${fieldName} must be a string`);
 return { isValid: false, errors };
 }

 if (!allowedValues.includes(value as T)) {
 errors.push(
 `${fieldName} must be one of: ${allowedValues.map((v) => `"${v}"`).join(', ')}`
 );
 }

 return {
 isValid: errors.length === 0,
 errors,
 ...(errors.length === 0 ? { value: value as T } : {}),
 };
}

/**
 * Validates an object has required keys
 */
export function validateRequiredKeys<T extends Record<string, unknown>>(
 obj: T,
 requiredKeys: (keyof T)[],
 fieldName = 'Object'
): ValidationResult {
 const errors: string[] = [];

 for (const key of requiredKeys) {
 if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
 errors.push(`${String(key)} is required in ${fieldName}`);
 }
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Sanitizes a string by removing potentially dangerous characters
 */
export function sanitizeString(input: string): string {
 if (typeof input !== 'string') return '';

 return input
 .replace(/[<>]/g, '') // Remove HTML tag characters
 .replace(/[&'"]/g, (char) => ({ '&': '&amp;', "'": '&#39;', '"': '&quot;' }[char] || char)) // Escape HTML entities
 .trim();
}

/**
 * Validates a URL format
 */
export function validateUrl(url: string): ValidationResult {
 const errors: string[] = [];

 if (!url || typeof url !== 'string') {
 errors.push('URL is required');
 return { isValid: false, errors };
 }

 try {
 const parsed = new URL(url.trim());
 if (!['http:', 'https:'].includes(parsed.protocol)) {
 errors.push('URL must use HTTP or HTTPS protocol');
 }
 if (parsed.hostname.length > 253) {
 errors.push('URL hostname exceeds maximum length');
 }
 } catch {
 errors.push('Invalid URL format');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates an IPv4 address format
 */
export function validateIPv4(ip: string): ValidationResult {
 const errors: string[] = [];

 if (!ip || typeof ip !== 'string') {
 errors.push('IP address is required');
 return { isValid: false, errors };
 }

 const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
 const match = ip.match(ipv4Regex);

 if (!match) {
 errors.push('Invalid IPv4 address format');
 return { isValid: false, errors };
 }

 const octets = match.slice(1).map(Number);
 for (const octet of octets) {
 if (octet > 255) {
 errors.push('IPv4 octet must be between 0 and 255');
 break;
 }
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates an IPv6 address format (basic validation)
 */
export function validateIPv6(ip: string): ValidationResult {
 const errors: string[] = [];

 if (!ip || typeof ip !== 'string') {
 errors.push('IP address is required');
 return { isValid: false, errors };
 }

 // Basic IPv6 regex - supports compressed notation
 const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/;

 if (!ipv6Regex.test(ip)) {
 errors.push('Invalid IPv6 address format');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a date string (ISO 8601 format)
 */
export function validateISODate(dateStr: string): ValidationResult {
 const errors: string[] = [];

 if (!dateStr || typeof dateStr !== 'string') {
 errors.push('Date is required');
 return { isValid: false, errors };
 }

 const date = new Date(dateStr);
 if (isNaN(date.getTime())) {
 errors.push('Invalid ISO 8601 date format');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a date is in the future
 */
export function validateFutureDate(dateStr: string): ValidationResult {
 const errors: string[] = [];

 if (!dateStr || typeof dateStr !== 'string') {
 errors.push('Date is required');
 return { isValid: false, errors };
 }

 const date = new Date(dateStr);
 if (isNaN(date.getTime())) {
 errors.push('Invalid date format');
 return { isValid: false, errors };
 }

 const now = new Date();
 if (date <= now) {
 errors.push('Date must be in the future');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a date is in the past
 */
export function validatePastDate(dateStr: string): ValidationResult {
 const errors: string[] = [];

 if (!dateStr || typeof dateStr !== 'string') {
 errors.push('Date is required');
 return { isValid: false, errors };
 }

 const date = new Date(dateStr);
 if (isNaN(date.getTime())) {
 errors.push('Invalid date format');
 return { isValid: false, errors };
 }

 const now = new Date();
 if (date >= now) {
 errors.push('Date must be in the past');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a credit card number using Luhn algorithm
 */
export function validateCreditCard(cardNumber: string): ValidationResult {
 const errors: string[] = [];

 if (!cardNumber || typeof cardNumber !== 'string') {
 errors.push('Credit card number is required');
 return { isValid: false, errors };
 }

 // Remove spaces and dashes
 const cleaned = cardNumber.replace(/[\s-]/g, '');

 if (!/^\d+$/.test(cleaned)) {
 errors.push('Credit card number must contain only digits');
 return { isValid: false, errors };
 }

 if (cleaned.length < 13 || cleaned.length > 19) {
 errors.push('Credit card number must be between 13 and 19 digits');
 return { isValid: false, errors };
 }

 // Luhn algorithm
 let sum = 0;
 let alternate = false;

 for (let i = cleaned.length - 1; i >= 0; i--) {
 let digit = parseInt(cleaned[i], 10);

 if (alternate) {
 digit *= 2;
 if (digit > 9) {
 digit -= 9;
 }
 }

 sum += digit;
 alternate = !alternate;
 }

 if (sum % 10 !== 0) {
 errors.push('Invalid credit card number');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a currency amount (positive decimal with up to 2 decimal places)
 */
export function validateCurrency(amount: unknown): ValidationResult {
 const errors: string[] = [];

 if (amount === null || amount === undefined) {
 errors.push('Amount is required');
 return { isValid: false, errors };
 }

 const num = typeof amount === 'number' ? amount : parseFloat(String(amount));

 if (isNaN(num)) {
 errors.push('Amount must be a valid number');
 return { isValid: false, errors };
 }

 if (num < 0) {
 errors.push('Amount must be non-negative');
 }

 if (!Number.isFinite(num)) {
 errors.push('Amount must be a finite number');
 }

 // Check decimal places
 const decimalStr = String(amount).split('.')[1];
 if (decimalStr && decimalStr.length > 2) {
 errors.push('Amount must have at most 2 decimal places');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a percentage value (0-100)
 */
export function validatePercentage(value: unknown): ValidationResult {
 const errors: string[] = [];

 if (value === null || value === undefined) {
 errors.push('Percentage value is required');
 return { isValid: false, errors };
 }

 const num = typeof value === 'number' ? value : parseFloat(String(value));

 if (isNaN(num)) {
 errors.push('Percentage must be a valid number');
 return { isValid: false, errors };
 }

 if (num < 0 || num > 100) {
 errors.push('Percentage must be between 0 and 100');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates an object with nested property validation
 */
export function validateObject<T extends Record<string, unknown>>(
 obj: unknown,
 schema: { [K in keyof T]?: (value: T[K]) => ValidationResult }
): ValidationResult & { data?: T } {
 const errors: string[] = [];
 const result: Record<string, unknown> = {};

 if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
 errors.push('Value must be an object');
 return { isValid: false, errors };
 }

 const typedObj = obj as T;

 for (const key of Object.keys(schema) as (keyof T)[]) {
 const validator = schema[key];
 if (!validator) continue;

 const value = typedObj[key];
 const validation = validator(value);

 if (!validation.isValid) {
 errors.push(...validation.errors.map((e) => `${String(key)}: ${e}`));
 } else {
 result[key] = value;
 }
 }

 return {
 isValid: errors.length === 0,
 errors,
 ...(errors.length === 0 ? { data: result as T } : {}),
 };
}

/**
 * Validates each element in an array
 */
export function validateArrayElements<T>(
 arr: unknown[],
 validator: (item: unknown, index: number) => ValidationResult,
 fieldName = 'Array'
): ValidationResult {
 const errors: string[] = [];

 if (!Array.isArray(arr)) {
 errors.push(`${fieldName} must be an array`);
 return { isValid: false, errors };
 }

 arr.forEach((item, index) => {
 const result = validator(item, index);
 if (!result.isValid) {
 errors.push(...result.errors.map((e) => `[${index}]: ${e}`));
 }
 });

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a locale code (ISO 639-1 or IETF BCP 47)
 */
export function validateLocale(locale: string): ValidationResult {
 const errors: string[] = [];

 if (!locale || typeof locale !== 'string') {
 errors.push('Locale is required');
 return { isValid: false, errors };
 }

 // Support formats: en, en-US, en-US-POSIX
 const localeRegex = /^[a-z]{2,3}(-[A-Z]{2})?(-[a-zA-Z0-9]+)*$/;
 if (!localeRegex.test(locale)) {
 errors.push('Invalid locale format (e.g., en, en-US)');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a timezone identifier (IANA timezone)
 */
export function validateTimezone(timezone: string): ValidationResult {
 const errors: string[] = [];

 if (!timezone || typeof timezone !== 'string') {
 errors.push('Timezone is required');
 return { isValid: false, errors };
 }

 try {
 Intl.DateTimeFormat(undefined, { timeZone: timezone });
 } catch {
 errors.push('Invalid IANA timezone identifier');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a color code (hex format: #RGB or #RRGGBB)
 */
export function validateHexColor(color: string): ValidationResult {
 const errors: string[] = [];

 if (!color || typeof color !== 'string') {
 errors.push('Color is required');
 return { isValid: false, errors };
 }

 const hexRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
 if (!hexRegex.test(color)) {
 errors.push('Invalid hex color format (e.g., #FF5733 or #F57)');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates a JSON string
 */
export function validateJsonString(jsonStr: string): ValidationResult {
 const errors: string[] = [];

 if (!jsonStr || typeof jsonStr !== 'string') {
 errors.push('JSON string is required');
 return { isValid: false, errors };
 }

 try {
 JSON.parse(jsonStr);
 } catch {
 errors.push('Invalid JSON format');
 }

 return {
 isValid: errors.length === 0,
 errors,
 };
}

/**
 * Validates an object against a JSON Schema (basic implementation)
 */
export function validateJsonSchema<T>(
 data: unknown,
 schema: {
 type: 'object';
 required?: (keyof T)[];
 properties?: Partial<{ [K in keyof T]: { type?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; pattern?: string } }>;
 }
 ): ValidationResult & { data?: T } {
 const errors: string[] = [];

 if (schema.type === 'object') {
 if (typeof data !== 'object' || data === null || Array.isArray(data)) {
 errors.push('Data must be an object');
 return { isValid: false, errors };
 }

 const typedData = data as Record<string, unknown>;

 // Check required fields
 if (schema.required) {
 for (const field of schema.required) {
 if (!(field in typedData) || typedData[field] === undefined || typedData[field] === null) {
 errors.push(`${String(field)} is required`);
 }
 }
 }

 // Validate properties
 if (schema.properties) {
 for (const [key, propSchema] of Object.entries(schema.properties)) {
 const value = typedData[key];
 if (value === undefined || value === null) continue;

 if (propSchema.type && typeof value !== propSchema.type) {
 errors.push(`${key} must be of type ${propSchema.type}`);
 continue;
 }

 if (propSchema.minLength !== undefined && String(value).length < propSchema.minLength) {
 errors.push(`${key} must be at least ${propSchema.minLength} characters`);
 }

 if (propSchema.maxLength !== undefined && String(value).length > propSchema.maxLength) {
 errors.push(`${key} must not exceed ${propSchema.maxLength} characters`);
 }

 if (propSchema.minimum !== undefined && Number(value) < propSchema.minimum) {
 errors.push(`${key} must be at least ${propSchema.minimum}`);
 }

 if (propSchema.maximum !== undefined && Number(value) > propSchema.maximum) {
 errors.push(`${key} must not exceed ${propSchema.maximum}`);
 }

 if (propSchema.pattern !== undefined && !new RegExp(propSchema.pattern).test(String(value))) {
 errors.push(`${key} does not match the required pattern`);
 }
 }
 }
 }

 return {
 isValid: errors.length === 0,
 errors,
 ...(errors.length === 0 ? { data: data as T } : {}),
 };
}
