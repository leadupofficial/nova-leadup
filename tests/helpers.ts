import { test as base, expect, type APIRequestContext, type APIResponse } from '@playwright/test';

const API_BASE = process.env.API_URL || 'http://localhost:3001';
const AUTH_BASE = process.env.AUTH_URL || 'http://localhost:3003';
const ADMIN_BASE = process.env.ADMIN_URL || 'http://localhost:3004';

export type RequestOptions = { headers?: Record<string, string> };

export interface ApiClient {
 // get() takes Playwright-style options ({ headers }); post/patch take the body
 // second and options third, matching how the specs in tests/ call them.
 get(path: string, options?: RequestOptions): Promise<APIResponse>;
 post(path: string, body?: unknown, options?: RequestOptions): Promise<APIResponse>;
 patch(path: string, body?: unknown, options?: RequestOptions): Promise<APIResponse>;
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
 get: (path, options) =>
 request.get(`${baseURL}${path}`, options),
 post: (path, body, options) =>
 request.post(`${baseURL}${path}`, {
 headers: { 'content-type': 'application/json', ...options?.headers },
 data: body,
 }),
 patch: (path, body, options) =>
 request.patch(`${baseURL}${path}`, {
 headers: { 'content-type': 'application/json', ...options?.headers },
 data: body,
 }),
 };
}

export { expect };
