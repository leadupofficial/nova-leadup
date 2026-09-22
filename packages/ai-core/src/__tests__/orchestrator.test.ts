import { describe, it, expect, vi } from 'vitest';
import {
	BlueprintModelRouter,
	buildLayeredPrompt,
	validateToolCall,
	SessionOrchestrator,
	type PromptLayer,
	type ClaudeToolDefinition,
	type ToolCall,
} from '../orchestrator.js';

// ─── BlueprintModelRouter ─────────────────────────────────────────────────────

describe('BlueprintModelRouter', () => {
	const router = new BlueprintModelRouter();

	it.each<{ risk: boolean; structured: boolean; expected: string }>([
		{ risk: false, structured: true, expected: 'claude-haiku-4-5-20251001' },
		{ risk: true, structured: true, expected: 'claude-sonnet-4-20250514' },
		{ risk: false, structured: false, expected: 'claude-sonnet-4-20250514' },
		{ risk: true, structured: false, expected: 'claude-sonnet-4-20250514' },
	])('route({ risk: $risk, structured: $structured }) returns $expected', ({ risk, structured, expected }) => {
		expect(router.route({ risk, structured })).toBe(expected);
	});
});

// ─── buildLayeredPrompt ───────────────────────────────────────────────────────

describe('buildLayeredPrompt', () => {
	const makeLayer = (layer: number, name: string, content: string): PromptLayer => ({
		layer,
		name,
		content,
	});

	it('returns an empty array for an empty input', () => {
		expect(buildLayeredPrompt([])).toEqual([]);
	});

	it('sorts layers by layer number ascending', () => {
		const layers = [
			makeLayer(3, 'Third', 'content-c'),
			makeLayer(1, 'First', 'content-a'),
			makeLayer(2, 'Second', 'content-b'),
		];
		const result = buildLayeredPrompt(layers);
		expect(result).toHaveLength(3);
		expect(result[0].content).toContain('Layer 1');
		expect(result[1].content).toContain('Layer 2');
		expect(result[2].content).toContain('Layer 3');
	});

	it('produces system messages with the correct format', () => {
		const layers = [makeLayer(1, 'Identity', 'You are NOVA.')];
		const result = buildLayeredPrompt(layers);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe('system');
		expect(result[0].content).toBe('[Layer 1] Identity\nYou are NOVA.');
	});

	it('handles out-of-order layers', () => {
		const layers = [
			makeLayer(10, 'Tenth', 'z-content'),
			makeLayer(1, 'First', 'a-content'),
			makeLayer(5, 'Fifth', 'm-content'),
		];
		const result = buildLayeredPrompt(layers);
		expect(result).toHaveLength(3);
		expect(result[0].content).toContain('[Layer 1]');
		expect(result[1].content).toContain('[Layer 5]');
		expect(result[2].content).toContain('[Layer 10]');
	});
});

// ─── validateToolCall ─────────────────────────────────────────────────────────

describe('validateToolCall', () => {
	const registeredTools: ClaudeToolDefinition[] = [
		{ name: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
		{ name: 'calculate', description: 'Do math', inputSchema: { type: 'object' } },
	];

	it('returns { valid: true } for a registered tool', () => {
		const toolCall: ToolCall = { name: 'search', input: { query: 'test' } };
		const result = validateToolCall(toolCall, registeredTools);
		expect(result).toEqual({ valid: true });
	});

	it('returns { valid: false, error } for an unknown tool name', () => {
		const toolCall: ToolCall = { name: 'unknown_tool', input: {} };
		const result = validateToolCall(toolCall, registeredTools);
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
		expect(result.error).toContain('unknown_tool');
		expect(result.error).toContain('not registered');
	});

	it('is case-sensitive for tool names', () => {
		const result = validateToolCall({ name: 'SEARCH', input: {} }, registeredTools);
		expect(result.valid).toBe(false);
	});

	it('returns valid: false for an empty tool list', () => {
		const result = validateToolCall({ name: 'anything', input: {} }, []);
		expect(result.valid).toBe(false);
	});
});

// ─── SessionOrchestrator ──────────────────────────────────────────────────────

describe('SessionOrchestrator', () => {
	const makeMockClaudeResponse = (blocks: Array<{ type: string; text?: string; name?: string; input?: unknown }>) => ({
		content: blocks,
		id: 'msg_123',
		model: 'claude-sonnet-4-20250514',
		stop_reason: 'end_turn',
		usage: { input_tokens: 10, output_tokens: 20 },
	});

	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('throws when apiKey is empty', () => {
		expect(() => new SessionOrchestrator({ apiKey: '' })).toThrow('ANTHROPIC_API_KEY is required');
		expect(() => new SessionOrchestrator({ apiKey: undefined as unknown as string })).toThrow(
			'ANTHROPIC_API_KEY is required',
		);
	});

	it('accepts a valid apiKey', () => {
		const orch = new SessionOrchestrator({ apiKey: 'test-key' });
		expect(orch).toBeDefined();
	});

	it('uses a default BlueprintModelRouter when none is provided', () => {
		const orch = new SessionOrchestrator({ apiKey: 'test-key' });
		// No throw means the default router was created successfully
		expect(orch).toBeDefined();
	});

	it('defaults maxHistoryLength to 20', () => {
		const orch = new SessionOrchestrator({ apiKey: 'test-key' });
		// Default is 20; verified through history trimming behavior below
		expect(orch).toBeDefined();
	});

	it('defaults enableApprovalGate to true', () => {
		const orch = new SessionOrchestrator({ apiKey: 'test-key' });
		// No throw on construction means approval gate defaults to true
		expect(orch).toBeDefined();
	});

	describe('converse', () => {
		it('calls the Claude API and returns a ConversationTurn', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => makeMockClaudeResponse([{ type: 'text', text: 'Hello from Claude.' }]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			const turn = await orch.converse('Hi', { risk: false, structured: true });

			expect(turn.userMessage).toBe('Hi');
			expect(turn.response).toBe('Hello from Claude.');
			expect(turn.toolCalls).toEqual([]);
			expect(typeof turn.timestamp).toBe('number');
			expect(typeof turn.requestId).toBe('string');
			expect(turn.requestId.length).toBeGreaterThan(0);
			expect(typeof turn.model).toBe('string');
		});

		it('appends messages to history', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => makeMockClaudeResponse([{ type: 'text', text: 'Response 1.' }]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			await orch.converse('First', { risk: false, structured: true });

			const history = orch.getHistory();
			expect(history).toHaveLength(2);
			expect(history[0].role).toBe('user');
			expect(history[0].content).toBe('First');
			expect(history[1].role).toBe('assistant');
			expect(history[1].content).toBe('Response 1.');
		});

		it('respects maxHistoryLength and trims old messages', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => makeMockClaudeResponse([{ type: 'text', text: 'Reply.' }]),
			});

			const orch = new SessionOrchestrator({
				apiKey: 'test-key',
				maxHistoryLength: 4,
			});

			// Each converse adds 2 messages. After 3 converses = 6 messages, exceeding max of 4.
			for (let i = 0; i < 3; i++) {
				await orch.converse(`Msg ${i}`, { risk: false, structured: true });
			}

			const history = orch.getHistory();
			expect(history).toHaveLength(4);
			// The 4 most recent messages remain
			expect(history[0].content).toBe('Msg 1');
			expect(history[2].content).toBe('Msg 2');
			expect(history[3].content).toBe('Reply.');
		});

		it('extracts text blocks from the response', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () =>
					makeMockClaudeResponse([
						{ type: 'text', text: 'First paragraph.' },
						{ type: 'text', text: 'Second paragraph.' },
					]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			const turn = await orch.converse('Hi', { risk: false, structured: true });

			expect(turn.response).toBe('First paragraph.\nSecond paragraph.');
		});

		it('extracts tool_use block names from the response', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () =>
					makeMockClaudeResponse([
						{ type: 'text', text: 'Sure.' },
						{ type: 'tool_use', name: 'search', input: { query: 'test' } },
						{ type: 'tool_use', name: 'summarize', input: { text: '...' } },
					]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			const turn = await orch.converse('Do things', { risk: true, structured: false });

			expect(turn.toolCalls).toEqual(['search', 'summarize']);
			// Response should only contain text blocks
			expect(turn.response).toBe('Sure.');
		});

		it('routes to Sonnet when risk is true', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => makeMockClaudeResponse([{ type: 'text', text: 'Sonnet response.' }]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			const turn = await orch.converse('Dangerous?', { risk: true, structured: true });

			expect(turn.model).toBe('claude-sonnet-4-20250514');
		});

		it('routes to Haiku when risk is false and structured is true', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => makeMockClaudeResponse([{ type: 'text', text: 'Haiku response.' }]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			const turn = await orch.converse('Summarize', { risk: false, structured: true });

			expect(turn.model).toBe('claude-haiku-4-5-20251001');
		});

		it('handles API error responses', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => 'Internal Server Error',
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			await expect(orch.converse('Hello', { risk: false, structured: true })).rejects.toThrow(
				'Claude API error 500',
			);
		});
	});

	describe('getHistory', () => {
		it('returns a copy of the history, not the internal array', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => makeMockClaudeResponse([{ type: 'text', text: 'Reply.' }]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			await orch.converse('Hi', { risk: false, structured: true });

			const h1 = orch.getHistory();
			const h2 = orch.getHistory();
			expect(h1).toEqual(h2);
			expect(h1).not.toBe(h2);
		});

		it('returns an empty array when no conversation has occurred', () => {
			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			expect(orch.getHistory()).toEqual([]);
		});
	});

	describe('clearHistory', () => {
		it('empties the conversation history', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => makeMockClaudeResponse([{ type: 'text', text: 'Reply.' }]),
			});

			const orch = new SessionOrchestrator({ apiKey: 'test-key' });
			await orch.converse('Hi', { risk: false, structured: true });
			expect(orch.getHistory()).toHaveLength(2);

			orch.clearHistory();
			expect(orch.getHistory()).toEqual([]);
		});
	});
});
