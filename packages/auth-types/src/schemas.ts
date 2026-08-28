import { z } from 'zod';
import { OtpChannel, MfaMethod, ApiKeyScope, Role, Permission, AuthProviders, OtpChannels, MfaMethods, ApiKeyScopes, ALL_ROLES as AllRoles } from './enums';

export const ProblemDetailsSchema = z.object({
 type: z.string().url().or(z.string().startsWith('https://')).or(z.literal('about:blank')),
 title: z.string(),
 status: z.number().int().positive(),
 detail: z.string().optional(),
 instance: z.string().optional(),
 extensions: z.record(z.unknown()).optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const RegisterEmailSchema = z.object({
 email: z.string().email('Invalid email address'),
 password: z.string().min(8, 'Password must be at least 8 characters'),
 name: z.string().min(1, 'Name is required').max(100),
});

export const LoginSchema = z.object({
 email: z.string().email('Invalid email address'),
 password: z.string().min(1, 'Password is required'),
 mfaCode: z.string().length(6, 'MFA code must be 6 digits').optional(),
});

export const RefreshTokenSchema = z.object({
 refreshToken: z.string().uuid('Invalid refresh token format'),
});

export const PhoneOtpRequestSchema = z.object({
 phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Invalid phone number (E.164 format)'),
 channel: z.enum(['sms', 'whatsapp']).default('sms'),
});

export const PhoneOtpVerifySchema = z.object({
 phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Invalid phone number'),
 code: z.string().length(6, 'OTP code must be 6 digits'),
});

export const PasswordResetRequestSchema = z.object({
 email: z.string().email('Invalid email address'),
});

export const PasswordResetSchema = z.object({
 token: z.string().uuid('Invalid reset token'),
 newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const CreateOrganizationSchema = z.object({
 name: z.string().min(1, 'Organization name is required').max(255),
 slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric with hyphens'),
 plan: z.enum(['free', 'pro', 'enterprise']).default('free'),
});

export const UpdateOrganizationSchema = z.object({
 name: z.string().min(1).max(255).optional(),
 plan: z.enum(['free', 'pro', 'enterprise']).optional(),
});

export const CreateWorkspaceSchema = z.object({
 name: z.string().min(1).max(255),
});

export const UpdateWorkspaceSchema = z.object({
 name: z.string().min(1).max(255).optional(),
});

export const AssignRoleSchema = z.object({
 userId: z.string().uuid(),
 role: z.enum(['owner', 'admin', 'manager', 'member', 'auditor', 'support_limited']),
});

export const MfaEnrollSchema = z.object({
 method: z.enum(['totp', 'sms', 'backup_code']),
});

export const MfaVerifySchema = z.object({
 code: z.string().length(6, 'MFA code must be 6 digits'),
});

export const CreateApiKeySchema = z.object({
 name: z.string().min(1).max(100),
 scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
 expiresAt: z.coerce.date().optional(),
});

export const PaginationSchema = z.object({
 page: z.coerce.number().int().positive().default(1),
 pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface JwtPayload {
 sub: string;
 orgId: string;
 workspaceId: string;
 role: string;
 email?: string;
 iat?: number;
 exp?: number;
}

export interface TokenPair {
 accessToken: string;
 refreshToken: string;
 expiresIn: number;
}

export interface AuthResponse {
 user: {
 id: string;
 email: string;
 name: string;
 orgId: string;
 workspaceId: string;
 role: string;
 hasMfa: boolean;
 mfaMethods: MfaMethod[];
 };
 tokens: TokenPair;
}

export interface PaginatedResponse<T> {
 data: T[];
 page: number;
 pageSize: number;
 totalItems: number;
 totalPages: number;
}
