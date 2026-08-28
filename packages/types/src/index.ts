export interface User {
 id: string;
 email: string;
 name: string;
 createdAt: Date;
 updatedAt: Date;
 deletedAt?: Date;
}

export interface Tenant {
 id: string;
 name: string;
 slug: string;
 plan: 'free' | 'pro' | 'enterprise';
 createdAt: Date;
}

export interface PaginatedResponse<T> {
 data: T[];
 page: number;
 pageSize: number;
 totalItems: number;
 totalPages: number;
}

export interface ApiError {
 code: string;
 message: string;
 details?: Record<string, unknown>;
}

export type Result<T, E = ApiError> =
 | { ok: true; value: T }
 | { ok: false; error: E };

export interface ServiceHealth {
 status: 'healthy' | 'degraded' | 'unhealthy';
 checks: {
 database: ServiceCheck;
 redis: ServiceCheck;
 storage: ServiceCheck;
 };
 timestamp: Date;
}

export interface ServiceCheck {
 status: 'pass' | 'fail';
 latencyMs?: number;
 message?: string;
}

export interface EventMessage<T = unknown> {
 id: string;
 type: string;
 payload: T;
 timestamp: Date;
 source: string;
 correlationId?: string;
}
