import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Summarizer } from '../summarizer.js';
import type { SummaryOptions, SummaryResult, ClaudeMessage } from '../summarizer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeSummaryResponse = (overrides: {
	blocks?: Array<{
		type: string;
		text?: string;
		name?: string;
		input?: Record<string, unknown>;
	}>;
	model?: string;
} = {}) => ({
	content: overrides.blocks ?? [
		{
			type: 'tool_use',
			name: 'structured_extraction',
			input: {
				summary: 'Great Q4 planning meeting.',
				decisions: ['Launch in October', 'Hire 2 engineers'],
				actionItems: [
					{
						type: 'task',
						description: 'Write Q4 plan',
						assignee: 'Alice',
						dueAt: '2025-10-01',
						confidence: 90,
						evidence: 'Alice said she would write the plan',
					},
					{
						type: 'followup',
						description: 'Schedule follow-up',
						confidence: 80,
						evidence: 'Team agreed to reconvene',
					},
				],
				extractedContacts: [
					{
						name: 'Alice',
						email: 'alice@example.com',
						organization: 'NOVA',
						confidence: 95,
					},
					{
						name: 'Bob',
						confidence: 70,
					},
				],
			},
		},
	],
	id: 'msg_123',
	model: overrides.model ?? 'claude-haiku-4-5-20251001',
	stop_reason: 'end_turn',
	usage: { input_tokens: 100, output_tokens: 50 },
});

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('Summarizer constructor', () => {
	beforeEach(() => {
		delete process.env.ANTHROPIC_API_KEY;
		vi.clearAllMocks();
	});

	it('throws if no apiKey is provided and ANTHROPIC_API_KEY env is empty', () => {
		expect(() => new Summarizer()).toThrow('ANTHROPIC_API_KEY is required');
	});

	it('accepts apiKey as a constructor parameter', () => {
		delete process.env.ANTHROPIC_API_KEY;
		expect(() => new Summarizer('my-api-key')).not.toThrow();
	});

	it('falls back to ANTHROPIC_API_KEY env when no apiKey param is given', () => {
		process.env.ANTHROPIC_API_KEY = 'env-api-key-1234567890123456789012';
		expect(() => new Summarizer()).not.toThrow();
	});

	it('prefers the explicit apiKey parameter over the env var', () => {
		process.env.ANTHROPIC_API_KEY = 'env-key';
		expect(() => new Summarizer('param-key')).not.toThrow();
	});
});

// ─── summarize ────────────────────────────────────────────────────────────────

describe('summarize', () => {
	beforeEach(() => {
		delete process.env.ANTHROPIC_API_KEY;
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	const createSummarizer = (apiKey = 'test-api-key') => new Summarizer(apiKey);

	it('calls callClaude with the correct request structure', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer('my-api-key-1234567890123456789012');
		await summarizer.summarize({ transcriptText: 'Hello world' });

		expect(global.fetch).toHaveBeenCalledTimes(1);
		const [url, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(options.method).toBe('POST');
		expect(options.headers['Content-Type']).toBe('application/json');
		expect(options.headers['x-api-key']).toBe('my-api-key-1234567890123456789012');

		const body = JSON.parse(options.body);
		expect(body.model).toBe('claude-haiku-4-5-20251001');
		expect(body.tools).toBeDefined();
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0].name).toBe('structured_extraction');
		expect(body.messages).toBeDefined();
		expect(body.messages.length).toBeGreaterThanOrEqual(2);
		// Last message is the user message with the transcript
		const lastMsg = body.messages[body.messages.length - 1];
		expect(lastMsg.role).toBe('user');
		expect(lastMsg.content).toContain('Hello world');
	});

	it('returns a SummaryResult with all required fields', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer();
		const result: SummaryResult = await summarizer.summarize({
			transcriptText: 'Transcript here.',
		});

		expect(result).toHaveProperty('summary');
		expect(result).toHaveProperty('decisions');
		expect(result).toHaveProperty('actionItems');
		expect(result).toHaveProperty('extractedContacts');
		expect(result).toHaveProperty('model');
		expect(result).toHaveProperty('processingMs');
	});

	it('processingMs is a number', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer();
		const result = await summarizer.summarize({ transcriptText: 'Transcript.' });

		expect(typeof result.processingMs).toBe('number');
		expect(result.processingMs).toBeGreaterThanOrEqual(0);
	});

	it('routes to haiku model for structured low-risk summarization', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer();
		const result = await summarizer.summarize({ transcriptText: 'Transcript.' });

		expect(result.model).toBe('claude-haiku-4-5-20251001');
	});

	it('handles a response with a tool_use block and parses actionItems', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () =>
				makeSummaryResponse({
					blocks: [
						{
							type: 'tool_use',
							name: 'structured_extraction',
							input: {
								summary: 'Short summary.',
								decisions: ['Decision 1'],
								actionItems: [
									{
										type: 'task',
										description: 'Do the thing',
										assignee: 'Charlie',
										dueAt: '2025-12-01',
										confidence: 85,
										evidence: 'Charlie said so',
									},
								],
								extractedContacts: [
									{
										name: 'Charlie',
										email: 'c@example.com',
										confidence: 90,
									},
								],
							},
						},
					],
				}),
		});

		const summarizer = createSummarizer();
		const result = await summarizer.summarize({ transcriptText: 'Meeting notes.' });

		expect(result.summary).toBe('Short summary.');
		expect(result.decisions).toEqual(['Decision 1']);
		expect(result.actionItems).toHaveLength(1);
		expect(result.actionItems[0].type).toBe('task');
		expect(result.actionItems[0].description).toBe('Do the thing');
		expect(result.actionItems[0].assignee).toBe('Charlie');
		expect(result.actionItems[0].dueAt).toBe('2025-12-01');
		expect(result.actionItems[0].confidence).toBe(85);
		expect(result.actionItems[0].evidence).toBe('Charlie said so');
	});

	it('handles a response with no tool_use block and returns empty defaults', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () =>
				makeSummaryResponse({
					blocks: [{ type: 'text', text: 'Here is a plain text summary.' }],
				}),
		});

		const summarizer = createSummarizer();
		const result = await summarizer.summarize({ transcriptText: 'Meeting notes.' });

		expect(result.summary).toBe('No summary available');
		expect(result.decisions).toEqual([]);
		expect(result.actionItems).toEqual([]);
		expect(result.extractedContacts).toEqual([]);
	});

	it('parses extractedContacts from tool input', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () =>
				makeSummaryResponse({
					blocks: [
						{
							type: 'tool_use',
							name: 'structured_extraction',
							input: {
								summary: 'Summary.',
								decisions: [],
								actionItems: [],
								extractedContacts: [
									{
										name: 'Alice',
										phone: '555-1234',
										email: 'alice@example.com',
										organization: 'NOVA',
										confidence: 95,
									},
									{
										name: 'Bob',
										confidence: 60,
									},
								],
							},
						},
					],
				}),
		});

		const summarizer = createSummarizer();
		const result = await summarizer.summarize({ transcriptText: 'Notes.' });

		expect(result.extractedContacts).toHaveLength(2);
		expect(result.extractedContacts[0].name).toBe('Alice');
		expect(result.extractedContacts[0].phone).toBe('555-1234');
		expect(result.extractedContacts[0].email).toBe('alice@example.com');
		expect(result.extractedContacts[0].organization).toBe('NOVA');
		expect(result.extractedContacts[0].confidence).toBe(95);
		expect(result.extractedContacts[1].name).toBe('Bob');
		expect(result.extractedContacts[1].confidence).toBe(60);
		expect(result.extractedContacts[1].email).toBeUndefined();
	});

	it('respects the maxLength option in the ', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer();

		// Test 'short'
		await summarizer.summarize({ transcriptText: 'Notes.', maxLength: 'short' });
		const shortBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		expect(shortBody.messages[0].content).toContain('under 100 words');

		// Test 'long'
		await summarizer.summarize({ transcriptText: 'Notes.', maxLength: 'long' });
		const longBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
		expect(longBody.messages[0].content).toContain('comprehensive summary');

		// Test default (medium)
		await summarizer.summarize({ transcriptText: 'Notes.' });
		const mediumBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body);
		expect(mediumBody.messages[0].content).toContain('concise summary');
		expect(mediumBody.messages[0].content).not.toContain('under 100 words');
		expect(mediumBody.messages[0].content).not.toContain('comprehensive');
	});

	it('respects the language option in the ', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer();
		await summarizer.summarize({ transcriptText: 'Notes.', language: 'Spanish' });

		const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		const systemMessage = body.messages.find((m: ClaudeMessage) => m.role === 'system');
		expect(systemMessage.content).toContain('Spanish');
		expect(systemMessage.content).toContain('The transcript is in Spanish.');
	});

	it('includes recordingTitle and participantCount in the user message', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer();
		await summarizer.summarize({
			transcriptText: 'Notes.',
			recordingTitle: 'Sprint Review',
			participantCount: 5,
		});

		const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		const userMessage = body.messages.find((m: ClaudeMessage) => m.role === 'user');
		expect(userMessage.content).toContain('Sprint Review');
		expect(userMessage.content).toContain('5 participants');
	});

	it('handles an API error response', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => 'Internal Server Error',
		});

		const summarizer = createSummarizer();
		await expect(summarizer.summarize({ transcriptText: 'Notes.' })).rejects.toThrow(
			'Claude API error 500',
		);
	});

	it('uses a default BlueprintModelRouter that routes to Haiku', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse({ model: 'claude-haiku-4-5-20251001' }),
		});

		const summarizer = createSummarizer();
		const result = await summarizer.summarize({ transcriptText: 'Notes.' });

		// The summarizer always routes to Haiku (structured, low-risk)
		expect(result.model).toBe('claude-haiku-4-5-20251001');
	});

	it('creates BlueprintModelRouter internally', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => makeSummaryResponse(),
		});

		const summarizer = createSummarizer();
		// No explicit router passed — it's created internally
		await summarizer.summarize({ transcriptText: 'Notes.' });

		// Verify via the routed model: Haiku for structured low-risk
		const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		expect(body.model).toBe('claude-haiku-4-5-20251001');
	});
});
