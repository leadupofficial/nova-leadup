import { test as base, expect, type APIRequestContext, type APIResponse } from '@playwright/test';

const API_BASE = process.env.API_URL || 'http://localhost:3001';
const AUTH_BASE = process.env.AUTH_URL || 'http://localhost:3003';
const ADMIN_BASE = process.env.ADMIN_URL || 'http://localhost:3004';

export interface ApiClient {
 get(path: string, headers?: Record<string, string>): Promise<APIResponse>;
 post(path: string, body?: unknown, headers?: Record<string, string>): Promise<APIResponse>;
 patch(path: string, body?: unknown, headers?: Record<string, string>): Promise<APIResponse>;
}

export interface TestFixtures {
 api: ApiClient;
 auth: ApiClient;
 admin: ApiClient;
}

export const test = base.extend<TestFixtures>({
 api: async ({ request }, use) => {
 const client = createClient(request, API_BASE);
 await use(client);
 },
 auth: async ({ request }, use) => {
 const client = createClient(request, AUTH_BASE);
 await use(client);
 },
 admin: async ({ request }, use) => {
 const client = createClient(request, ADMIN_BASE);
 await use(client);
 },
});

function createClient(request: APIRequestContext, baseURL: string): ApiClient {
 return {
 get: (path, headers) =>
 request.get(`${baseURL}${path}`, { headers }),
 post: (path, body, headers) =>
 request.post(`${baseURL}${path}`, {
 headers: { 'content-type': 'application/json', ...headers },
 data: body,
 }),
 patch: (path, body, headers) =>
 request.patch(`${baseURL}${path}`, {
 headers: { 'content-type': 'application/json', ...headers },
 data: body,
 }),
 };
}

export { expect };
