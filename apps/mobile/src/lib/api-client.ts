/**
 * NOVA Mobile — API client for communicating with the backend.
 *
 * Replaces mock data with real API calls to @nova/api.
 * Uses the shared types from @nova/shared-types for type safety.
 */

import type { Conversation, Message, Task, Memory, User } from '@nova/shared-types';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// ─── Token Management ────────────────────────────────────────────────────────

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
 accessToken = token;
}

export function getAccessToken(): string | null {
 return accessToken;
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

async function apiRequest<T>(
 endpoint: string,
 options: RequestInit = {},
): Promise<T> {
 const url = `${API_BASE_URL}${endpoint}`;
 const headers: Record<string, string> = {
 'Content-Type': 'application/json',
 ...(options.headers as Record<string, string> ?? {}),
 };

 if (accessToken) {
 headers['Authorization'] = `Bearer ${accessToken}`;
 }

 const response = await fetch(url, {
 ...options,
 headers,
 });

 if (response.status === 401) {
 // Token expired — clear and throw
 accessToken = null;
 throw new Error('Unauthorized');
 }

 if (!response.ok) {
 const error = await response.json().catch(() => ({ message: 'Unknown error' }));
 throw new Error(error.message ?? `HTTP ${response.status}`);
 }

 // Handle 204 No Content
 if (response.status === 204) {
 return undefined as T;
 }

 return response.json();
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<{ user: User; accessToken: string; refreshToken: string }> {
 const result = await apiRequest<{ success: boolean; data: { user: User; accessToken: string; refreshToken: string } }>(
 '/api/v1/auth/login',
 {
 method: 'POST',
 body: JSON.stringify({ email, password }),
 },
 );

 if (!result.success) {
 throw new Error('Login failed');
 }

 accessToken = result.data.accessToken;
 return result.data;
}

export async function register(input: { name: string; email: string; password: string }): Promise<{ user: User; accessToken: string; refreshToken: string }> {
 const result = await apiRequest<{ success: boolean; data: { user: User; accessToken: string; refreshToken: string } }>(
 '/api/v1/auth/register',
 {
 method: 'POST',
 body: JSON.stringify(input),
 },
 );

 if (!result.success) {
 throw new Error('Registration failed');
 }

 accessToken = result.data.accessToken;
 return result.data;
}

export async function requestOtp(phone: string): Promise<void> {
 await apiRequest('/api/v1/auth/otp/request', {
 method: 'POST',
 body: JSON.stringify({ phone }),
 });
}

export async function verifyOtp(phone: string, code: string): Promise<{ accessToken: string; refreshToken: string }> {
 const result = await apiRequest<{ success: boolean; data: { accessToken: string; refreshToken: string } }>(
 '/api/v1/auth/otp/verify',
 {
 method: 'POST',
 body: JSON.stringify({ phone, code }),
 },
 );

 if (!result.success) {
 throw new Error('OTP verification failed');
 }

 accessToken = result.data.accessToken;
 return result.data;
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
 const result = await apiRequest<{ success: boolean; data: { accessToken: string; refreshToken: string } }>(
 '/api/v1/auth/refresh',
 {
 method: 'POST',
 body: JSON.stringify({ refreshToken }),
 },
 );

 if (!result.success) {
 throw new Error('Token refresh failed');
 }

 accessToken = result.data.accessToken;
 return result.data;
}

export async function logout(): Promise<void> {
 try {
 await apiRequest('/api/v1/auth/logout', { method: 'POST' });
 } finally {
 accessToken = null;
 }
}

export async function getSession(): Promise<User | null> {
 try {
 const result = await apiRequest<{ success: boolean; data: User }>('/api/v1/auth/session');
 return result.success ? result.data : null;
 } catch {
 return null;
 }
}

// ─── Conversations ───────────────────────────────────────────────────────────

export async function createConversation(title?: string, mode?: 'text' | 'voice'): Promise<Conversation> {
 const result = await apiRequest<{ success: boolean; data: Conversation }>('/api/v1/conversations', {
 method: 'POST',
 body: JSON.stringify({ title, mode }),
 });
 return result.data;
}

export async function listConversations(limit = 20, offset = 0): Promise<Conversation[]> {
 const result = await apiRequest<{ success: boolean; data: Conversation[] }>(
 `/api/v1/conversations?limit=${limit}&offset=${offset}`,
 );
 return result.data;
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
 try {
 const result = await apiRequest<{ success: boolean; data: Conversation }>(`/api/v1/conversations/${conversationId}`);
 return result.data;
 } catch {
 return null;
 }
}

export async function deleteConversation(conversationId: string): Promise<void> {
 await apiRequest(`/api/v1/conversations/${conversationId}`, { method: 'DELETE' });
}

export async function sendMessage(conversationId: string, content: string): Promise<Message> {
 const result = await apiRequest<{ success: boolean; data: Message }>(
 `/api/v1/conversations/${conversationId}/messages`,
 {
 method: 'POST',
 body: JSON.stringify({ content }),
 },
 );
 return result.data;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export async function createTask(input: { title: string; description?: string; priority?: string; dueAt?: string }): Promise<Task> {
 const result = await apiRequest<{ success: boolean; data: Task }>('/api/v1/tasks', {
 method: 'POST',
 body: JSON.stringify(input),
 });
 return result.data;
}

export async function listTasks(status?: string): Promise<Task[]> {
 const query = status ? `?status=${encodeURIComponent(status)}` : '';
 const result = await apiRequest<{ success: boolean; data: Task[] }>(`/api/v1/tasks${query}`);
 return result.data;
}

export async function updateTask(taskId: string, input: Partial<{ title: string; status: string; priority: string }>): Promise<Task> {
 const result = await apiRequest<{ success: boolean; data: Task }>(`/api/v1/tasks/${taskId}`, {
 method: 'PATCH',
 body: JSON.stringify(input),
 });
 return result.data;
}

export async function deleteTask(taskId: string): Promise<void> {
 await apiRequest(`/api/v1/tasks/${taskId}`, { method: 'DELETE' });
}

// ─── Memories ────────────────────────────────────────────────────────────────

export async function listMemories(): Promise<Memory[]> {
 const result = await apiRequest<{ success: boolean; data: Memory[] }>('/api/v1/memories');
 return result.data;
}

export async function searchMemories(query: string): Promise<Memory[]> {
 const result = await apiRequest<{ success: boolean; data: Memory[] }>(`/api/v1/memories/search?q=${encodeURIComponent(query)}`);
 return result.data;
}

export async function createMemory(input: { content: string; tags?: string[] }): Promise<Memory> {
 const result = await apiRequest<{ success: boolean; data: Memory }>('/api/v1/memories', {
 method: 'POST',
 body: JSON.stringify(input),
 });
 return result.data;
}

// ─── Notifications ───────────────────────────────────────────────────────────

export async function getNotifications(): Promise<any[]> {
 const result = await apiRequest<{ success: boolean; data: any[] }>('/api/v1/notifications');
 return result.data;
}

// ─── Health Check ────────────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
 try {
 const response = await fetch(`${API_BASE_URL}/health`);
 return response.ok;
 } catch {
 return false;
 }
}
