import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeClient } from '../index.js';

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Mock fetch responses for Claude API calls.
 */
function mockClaudeResponse(text: string, status = 200) {
	global.fetch = vi.fn().mockResolvedValue({
		ok: status === 200,
		status,
		text: async () => (status === 200 ? JSON.stringify({ content: [{ type: 'text', text }], id: 'msg_1', model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }) : 'Error'),
		json: async () => ({ content: [{ type: 'text', text }], id: 'msg_1', model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }),
	});
}

// ─── LLM Provider Interface Tests ────────────────────────────────────

describe('LLM provider interface', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('API key validation', () => {
		it('throws when API key is empty string', () => {
			expect(() => new ClaudeClient({ apiKey: '' })).toThrow('ANTHROPIC_API_KEY is required');
		});

		it('throws when API key is undefined', () => {
			expect(() => new ClaudeClient({ apiKey: undefined as any })).toThrow('ANTHROPIC_API_KEY is required');
		});

		it('accepts a valid API key', () => {
			mockClaudeResponse('Hello!');
			const client = new ClaudeClient({ apiKey: 'sk-test-key' });
			expect(client).toBeDefined();
		});
	});

	describe('request construction', () => {
		it('includes the API key in the request headers', async () => {
			mockClaudeResponse('Response');

			const client = new ClaudeClient({ apiKey: 'sk-test-key' });
			await client.complete({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'Hi' }],
			});

			const call = (global.fetch as any).mock.calls[0];
			const headers = call[1]?.headers || {};
			expect(headers['x-api-key']).toBe('sk-test-key');
		});

		it('includes the correct anthropic-version header', async () => {
			mockClaudeResponse('Response');

			const client = new ClaudeClient({ apiKey: 'sk-test-key' });
			await client.complete({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'Hi' }],
			});

			const call = (global.fetch as any).mock.calls[0];
			const headers = call[1]?.headers || {};
			expect(headers['anthropic-version']).toBe('2023-06-01');
		});

		it('sends the correct request body', async () => {
			mockClaudeResponse('Response');

			const client = new ClaudeClient({ apiKey: 'sk-test-key' });
			await client.complete({
				model: 'claude-sonnet-4-20250514',
				max_tokens: 500,
				messages: [{ role: 'user', content: 'Hello' }],
				system: 'You are helpful.',
			});

			const call = (global.fetch as any).mock.calls[0];
			const body = JSON.parse(call[1]?.body || '{}');
			expect(body.model).toBe('claude-sonnet-4-20250514');
			expect(body.max_tokens).toBe(500);
			expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
			expect(body.system).toBe('You are helpful.');
		});
	});

	describe('response handling', () => {
		it('returns extracted text from text blocks', async () => {
			mockClaudeResponse('Hello from Claude');

			const client = new ClaudeClient({ apiKey: 'sk-test-key' });
			const response = await client.complete({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'Hi' }],
			});

			expect(response.content).toHaveLength(1);
			expect(response.content[0].type).toBe('text');
			expect(response.content[0].text).toBe('Hello from Claude');
		});

		it('handles multiple text blocks in response', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({
					content: [
						{ type: 'text', text: 'First paragraph.' },
						{ type: 'text', text: 'Second paragraph.' },
					],
					id: 'msg_2',
					model: 'claude-sonnet-4-20250514',
					stop_reason: 'end_turn',
					usage: { input_tokens: 20, output_tokens: 30 },
				}),
				json: async () => ({
					content: [
						{ type: 'text', text: 'First paragraph.' },
						{ type: 'text', text: 'Second paragraph.' },
					],
					id: 'msg_2',
					model: 'claude-sonnet-4-20250514',
					stop_reason: 'end_turn',
					usage: { input_tokens: 20, output_tokens: 30 },
				}),
			});

			const client = new ClaudeClient({ apiKey: 'sk-test-key' });
			const response = await client.complete({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'Hi' }],
			});

			expect(response.content).toHaveLength(2);
		});

		it('handles API error responses', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => 'Internal Server Error',
				json: async () => ({}),
			});

			const client = new ClaudeClient({ apiKey: 'sk-test-key' });

			await expect(
				client.complete({
					model: 'claude-haiku-4-5-20251001',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'Hi' }],
				})
			).rejects.toThrow('Claude API error 500');
		});

		it('handles network errors', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			const client = new ClaudeClient({ apiKey: 'sk-test-key' });

			await expect(
				client.complete({
					model: 'claude-haiku-4-5-20251001',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'Hi' }],
				})
			).rejects.toThrow('Network error');
		});
	});

	describe('retry behavior', () => {
		it('retries on 429 rate limit errors', async () => {
			let callCount = 0;
			global.fetch = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount < 3) {
					return Promise.resolve({
						ok: false,
						status: 429,
						text: async () => 'Rate limited',
						json: async () => ({}),
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					text: async () => JSON.stringify({
						content: [{ type: 'text', text: 'Success after retry' }],
						id: 'msg_3',
						model: 'claude-sonnet-4-20250514',
						stop_reason: 'end_turn',
						usage: { input_tokens: 10, output_tokens: 20 },
					}),
					json: async () => ({
						content: [{ type: 'text', text: 'Success after retry' }],
						id: 'msg_3',
						model: 'claude-sonnet-4-20250514',
						stop_reason: 'end_turn',
						usage: { input_tokens: 10, output_tokens: 20 },
					}),
				});
			});

			const client = new ClaudeClient({ apiKey: 'sk-test-key', maxRetries: 3 });
			const response = await client.complete({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'Hi' }],
			});

			expect(response.content[0].text).toBe('Success after retry');
			expect(callCount).toBe(3);
		});

		it('does not retry on 4xx errors (except 429)', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => 'Bad request',
				json: async () => ({}),
			});

			const client = new ClaudeClient({ apiKey: 'sk-test-key', maxRetries: 3 });

			await expect(
				client.complete({
					model: 'claude-haiku-4-5-20251001',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'Hi' }],
				})
			).rejects.toThrow('Claude API error 400');

			expect(global.fetch).toHaveBeenCalledTimes(1);
		});
	});
});
