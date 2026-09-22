/**
 * NOVA API — the legacy `/api/v1/chat/message` route must not be tool-less.
 *
 * The route ran a bare LLM with no tools, so asked to set a reminder NOVA
 * answered that it had no ability to set reminders and suggested the user try
 * Siri instead — the assistant denying a capability the server beside it
 * already had. The Flutter client never calls this path (it posts to
 * `/conversations/:id/messages`), but it stays mounted and reachable, and
 * `scripts/verify-privacy-gates.py` still exercises it, so it is repaired
 * rather than deleted.
 *
 * Repaired means the same grounding and the same write tools as
 * `/api/v1/voice/chat`, asserted at the provider boundary: the mock is the only
 * place that can see what the route actually offered the model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import './setup.js';

import app from '../server.js';
import jwt from 'jsonwebtoken';
import { chatCompletion } from '../services/ai.js';
import { USER_TIMEZONE } from '../services/user-context.js';

const JWT_SECRET = process.env.JWT_SECRET!;

function createToken(
	payload: Record<string, unknown> = { sub: 'user-123', email: 'test@example.com', role: 'user' },
): string {
	return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

const mockedChatCompletion = vi.mocked(chatCompletion);

/** Options the route passed to the provider on its most recent call. */
function lastOptions(): Record<string, unknown> {
	const calls = mockedChatCompletion.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return (calls[calls.length - 1][1] ?? {}) as Record<string, unknown>;
}

function lastSystemPrompt(): string {
	return String(lastOptions().systemPrompt ?? '');
}

beforeEach(() => {
	mockedChatCompletion.mockClear();
});

describe('POST /api/v1/chat/message — the assistant keeps its capabilities', () => {
	it('offers the write tools instead of a bare LLM', async () => {
		const res = await request(app)
			.post('/api/v1/chat/message')
			.set(authHeader(createToken()))
			.send({ sessionId: uuidv4(), content: 'remind me to call the client tomorrow' });

		expect(res.status).toBe(200);

		// The defect: no `tools` was passed at all, so the model could only reply
		// that it had no way to set a reminder.
		const tools = lastOptions().tools as { name: string }[] | undefined;
		expect(Array.isArray(tools)).toBe(true);
		expect(tools!.map((t) => t.name)).toEqual(
			expect.arrayContaining(['create_reminder', 'create_task', 'save_memory']),
		);
	});

	it('grounds the reply in the current date, as /voice/chat does', async () => {
		const res = await request(app)
			.post('/api/v1/chat/message')
			.set(authHeader(createToken()))
			.send({ sessionId: uuidv4(), content: 'what do I have tomorrow?' });

		expect(res.status).toBe(200);

		const systemPrompt = lastSystemPrompt();
		expect(systemPrompt).toContain('current time:');
		expect(systemPrompt).toContain(String(new Date().getFullYear()));
		expect(systemPrompt).toContain(USER_TIMEZONE);
	});

	it('tells the model it can actually perform those writes', async () => {
		const res = await request(app)
			.post('/api/v1/chat/message')
			.set(authHeader(createToken()))
			.send({ sessionId: uuidv4(), content: 'NOVA, set a reminder for 9am' });

		expect(res.status).toBe(200);

		const systemPrompt = lastSystemPrompt();
		expect(systemPrompt).toContain('create_reminder');
		// The persona is still NOVA's — the grounded prompt is composed around it,
		// not instead of it.
		expect(systemPrompt).toContain('NOVA');
	});

	it('still persists the turn and returns the assistant reply', async () => {
		const res = await request(app)
			.post('/api/v1/chat/message')
			.set(authHeader(createToken()))
			.send({ sessionId: uuidv4(), content: 'Hello from NOVA' });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('success', true);
		expect(res.body.data).toHaveProperty('assistantMessage');
	});
});
