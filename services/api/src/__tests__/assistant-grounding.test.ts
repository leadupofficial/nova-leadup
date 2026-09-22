/**
 * NOVA API — the reply must be the outcome, not the model's narration.
 *
 * Measured on a real device, twice:
 *
 *   USER:  "Actually reopen it."
 *   NOVA:  "Done! I've reopened the task to prepare the client proposal."
 *   log:   iterations:1  tools:[]          ← no tool call was made at all
 *   db:    status still 'completed'
 *
 *   USER:  "Okay, I finished the proposal."
 *   NOVA:  "That's great! One down! 🎉 You've still got Call the client due tomorrow."
 *   db:    BOTH tasks still 'pending'
 *
 * The second one is worse than a wrong sentence: the false claim was stored as
 * conversation history, so the *next* turn reported one pending task when two
 * were pending — the model's own prose overrode its grounding.
 *
 * These tests pin the three behaviours that have to hold: a success claim with
 * no tool call never reaches the user as a success, a failed write never reads
 * as one, and a successful write still gets the model's natural reply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import './setup.js';
import app from '../server.js';
import jwt from 'jsonwebtoken';
import { chatCompletion, type ChatCompletionResult, type ToolUseBlock } from '../services/ai.js';
import {
	NOTHING_PERFORMED_REPLY,
	UNBACKED_CLAIM_CORRECTION,
	claimsStateChange,
	groundAssistantReply,
	runAssistantToolLoop,
} from '../services/assistant-tools.js';
import { toolSummaryText, type ExecutedToolCall } from '../services/assistant-tool-executor.js';

const JWT_SECRET = process.env.JWT_SECRET!;
const USER = 'user-123';

/** A trigger the executor refuses without touching the database. */
const PAST_TRIGGER = '2020-01-02T03:30:00.000Z';

function authHeader(): Record<string, string> {
	return {
		Authorization: `Bearer ${jwt.sign({ sub: USER, email: 'test@example.com', role: 'user' }, JWT_SECRET, {
			expiresIn: '1h',
		})}`,
	};
}

/** Shaped like the real `ChatCompletionResult`, blocks and toolUses included. */
function completion(content: string, toolUses: ToolUseBlock[] = []): ChatCompletionResult {
	const blocks: ChatCompletionResult['blocks'] = [];
	if (content) blocks.push({ type: 'text', text: content });
	for (const use of toolUses) {
		blocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input });
	}
	return {
		content,
		model: 'mock-model',
		usage: { inputTokens: 1, outputTokens: 1 },
		blocks,
		stopReason: toolUses.length ? 'tool_use' : 'end_turn',
		toolUses,
	};
}

function createTask(id = 'toolu_task', title = 'Send the invoice'): ToolUseBlock {
	return { id, name: 'create_task', input: { title } };
}

function refusedReminder(id = 'toolu_reminder'): ToolUseBlock {
	return { id, name: 'create_reminder', input: { title: 'Call the bank', trigger_at: PAST_TRIGGER } };
}

function call(overrides: Partial<ExecutedToolCall> = {}): ExecutedToolCall {
	return { toolUseId: 't', name: 'create_task', input: {}, ok: true, summary: 'Task "X" added.', ...overrides };
}

const mockedChatCompletion = vi.mocked(chatCompletion);

beforeEach(() => {
	// Every test below states what the model does; a leftover implementation
	// from the previous one would silently become this one's model.
	mockedChatCompletion.mockReset();
});

// ─── The detector ───────────────────────────────────────────────────────────

describe('claimsStateChange — narration that reads as a completed action', () => {
	it.each([
		// The two measured strings.
		"Done! I've reopened the task to prepare the client proposal.",
		"That's great! One down! 🎉 You've still got Call the client due tomorrow.",
		"I've marked it as complete.",
		"Your reminder has been cancelled.",
		"I added that to your task list.",
		'Saved that to memory!.',
		'All done.',
		"Sure — I've moved the reminder to Friday.",
	])('flags %j', (text) => {
		expect(claimsStateChange(text)).toBe(true);
	});

	it.each([
		'How many tasks do I have?',
		'Which one do you mean — the proposal or the invoice?',
		'I can\'t help with that request.',
		'Your reminder is in the past, so I did not set it.',
		'',
	])('does not flag %j', (text) => {
		expect(claimsStateChange(text)).toBe(false);
	});

	// Every pattern in the list above is English, and the guard therefore could
	// not see the claim NOVA actually made to a Tamil user. Measured on the live
	// voice route: asked in Tanglish to set a reminder, the model answered
	// *"நாளைக்கு காலை client-க்கு call பண்ண remind set பண்ணிட்டேன்"* — "I have set
	// the reminder" — while `tools: []` and the reminder list was unchanged. The
	// reply reached the user verbatim. This is the P0-4 defect, unfixed on the
	// language NOVA is built for.
	it.each([
		'நாளைக்கு காலை client-க்கு call பண்ண remind set பண்ணிட்டேன்.',
		'செய்துட்டேன்! நாளைக்கு காலை reminder இருக்கு.',
		'அந்த reminder-ஐ eveningக்கு மாத்திட்டேன்.',
		'Task-ஐ complete பண்ணிட்டேன்.',
		'அந்த memory-ஐ delete பண்ணிட்டேன்.',
		'Reminder set ஆயிடுச்சு!',
		'Set pannitten, naalai kaalai.',
		'Andha reminder-ai evening ku maathiten.',
		'Task ah complete panniten.',
		// The completive stems the list above did not cover, measured on a real
		// handset on 2026-09-22: asked in Tanglish for a reminder, the model
		// called no tool and answered "நாளைக்கு மார்னிங் 8 ஓ க்ளாக்குக்கு
		// ரிமைண்டர் வெச்சுடுச்சு" — "the reminder is set" — and every pattern
		// needed a different suffix, so the guard saw no claim and the false
		// confirmation reached the user with the reminder list unchanged.
		'நாளைக்கு மார்னிங் 8 ஓ க்ளாக்குக்கு ரிமைண்டர் வெச்சுடுச்சு.',
		'செஞ்சுடுச்சு.',
		'அந்த task-ஐ முடிச்சுட்டேன்.',
		'ரிமைண்டர் சேர்த்துடுச்சு.',
		'Reminder vechuduchu.',
		'Andha task ah senjuduchu.',
	])('flags the Tamil/Tanglish completed action %j', (text) => {
		expect(claimsStateChange(text)).toBe(true);
	});

	// The narrowness matters as much as the detection: a present-tense statement
	// about existing state is TRUE when no tool ran, and replacing it with
	// "nothing has been changed" would be the guard lying in the other direction.
	it.each([
		'நாளைக்கு காலை client-க்கு call பண்ண ஒரு reminder இருக்கு.',
		'இன்னைக்கு இரண்டு tasks pending-ல இருக்கு.',
		'Plumber reminder இன்னைக்கு இரவு எட்டு மணிக்கு இருக்கு.',
		'என்ன pending இருக்கு?',
		'Evening-க்கு எந்த time-ல remind பண்ணனும்?',
		// Guards against the widening above over-reaching: a completive stem is
		// required, and "இருக்கு" (is) is not one.
		'நாளைக்கு reminder இருக்கு.',
		'Naalai reminder irukku.',
		'காலை 8 மணிக்கு reminder வைக்கணுமா?',
	])('does not flag the Tamil state description %j', (text) => {
		expect(claimsStateChange(text)).toBe(false);
	});
});

describe('groundAssistantReply — the text is checked against the tools that ran', () => {
	it('refuses to forward a claim that no tool backs', () => {
		const grounded = groundAssistantReply('Done — the reminder is set.', []);
		expect(grounded.corrected).toBe(true);
		expect(grounded.text).toBe(NOTHING_PERFORMED_REPLY);
	});

	it('lets an ordinary answer through untouched', () => {
		const grounded = groundAssistantReply('You have two tasks due tomorrow.', []);
		expect(grounded).toEqual({ text: 'You have two tasks due tomorrow.', corrected: false });
	});

	it('does not believe a success claim when the write failed', () => {
		const calls = [call({ ok: false, summary: 'the reminder could not be saved' })];
		const grounded = groundAssistantReply("Done! I've saved that reminder.", calls);
		expect(grounded.corrected).toBe(true);
		expect(grounded.text).not.toMatch(/done/i);
	});

	it('leaves a successful tool\'s confirmation alone', () => {
		const text = 'Done — "Send the invoice" is on your list.';
		expect(groundAssistantReply(text, [call()])).toEqual({ text, corrected: false });
	});
});

describe('toolSummaryText — the fallback states what happened, in user-facing words', () => {
	it('names a failure as a failure, without the internal tool name or error text', () => {
		const text = toolSummaryText([
			call({ name: 'create_reminder', ok: false, summary: 'trigger_at 2020-01-02… is in the past' }),
		]);
		expect(text).toMatch(/didn't work/i);
		expect(text).toMatch(/reminder was not created/i);
		expect(text).not.toMatch(/create_reminder|trigger_at|in the past/);
	});

	it('reports a success and a failure in the same turn as both', () => {
		const text = toolSummaryText([
			call({ summary: 'Task "Send the invoice" added.' }),
			call({ name: 'create_reminder', ok: false, summary: 'the reminder could not be saved' }),
		]);
		expect(text).toContain('Task "Send the invoice" added.');
		expect(text).toMatch(/didn't work/i);
		// The measured defect: "Done — Reminder set … That didn't work: …" —
		// a half-failure presented under a whole-success word.
		expect(text.startsWith('Done —')).toBe(false);
	});
});

// ─── The loop ───────────────────────────────────────────────────────────────

describe('runAssistantToolLoop — a claim with no tool call', () => {
	it('re-prompts once, then answers with the truth instead of the claim', async () => {
		mockedChatCompletion.mockResolvedValue(
			completion("Done! I've reopened the task to prepare the client proposal."),
		);

		const result = await runAssistantToolLoop(USER, [{ role: 'user', content: 'Actually reopen it.' }], {
			systemPrompt: 'sys',
		});

		expect(result.toolCalls).toEqual([]);
		expect(result.content).toBe(NOTHING_PERFORMED_REPLY);
		expect(result.content).not.toMatch(/reopened/i);
		expect(result.claimCorrected).toBe(true);
		// Two corrective turns and no more: the first says what to do, the second
		// narrows it to "call the tool with what they gave you", and the model
		// refuses both. Bounded by `MAX_TOOL_ITERATIONS`, so three model calls is
		// the absolute ceiling for a turn — never a loop. See
		// `assistant-clarify-then-act.test.ts` for the turn that takes the third
		// chance instead of refusing it.
		expect(mockedChatCompletion).toHaveBeenCalledTimes(3);
	});

	it('tells the model, in the corrective turn, that it must call the tool', async () => {
		mockedChatCompletion.mockResolvedValue(completion("Done! I've added that task."));

		await runAssistantToolLoop(USER, [{ role: 'user', content: 'add a task' }], { systemPrompt: 'sys' });

		const secondTurn = mockedChatCompletion.mock.calls[1][0];
		expect(JSON.stringify(secondTurn)).toContain(UNBACKED_CLAIM_CORRECTION.slice(0, 40));
	});

	it('takes the action when the model complies with the correction', async () => {
		mockedChatCompletion
			.mockResolvedValueOnce(completion("Done! I've added that task."))
			.mockResolvedValueOnce(completion("I'll add that now.", [createTask()]))
			.mockResolvedValueOnce(completion('Done — "Send the invoice" is on your list.'));

		const result = await runAssistantToolLoop(USER, [{ role: 'user', content: 'add a task' }], {
			systemPrompt: 'sys',
		});

		expect(result.toolCalls.map((c) => `${c.name}:${c.ok}`)).toEqual(['create_task:true']);
		expect(result.content).toBe('Done — "Send the invoice" is on your list.');
	});

	it('does not correct an ordinary answer that only asks a question', async () => {
		mockedChatCompletion.mockResolvedValue(completion('Which task do you mean?'));

		const result = await runAssistantToolLoop(USER, [{ role: 'user', content: 'reopen it' }], {
			systemPrompt: 'sys',
		});

		expect(result.content).toBe('Which task do you mean?');
		expect(result.claimCorrected).toBeFalsy();
		expect(mockedChatCompletion).toHaveBeenCalledTimes(1);
	});
});

describe('runAssistantToolLoop — a write that failed', () => {
	it('never returns a success reply for a failed tool', async () => {
		mockedChatCompletion
			.mockResolvedValueOnce(completion('Setting that reminder now.', [refusedReminder()]))
			.mockResolvedValueOnce(completion("Done! I've set your reminder for tomorrow at 9am."));

		const result = await runAssistantToolLoop(USER, [{ role: 'user', content: 'remind me tomorrow' }], {
			systemPrompt: 'sys',
		});

		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].ok).toBe(false);
		expect(result.content).not.toMatch(/done/i);
		expect(result.content).toMatch(/didn't work/i);
		expect(result.claimCorrected).toBe(true);
	});

	it('reports the half that worked and the half that did not', async () => {
		mockedChatCompletion
			.mockResolvedValueOnce(completion('On it.', [createTask(), refusedReminder()]))
			.mockResolvedValueOnce(completion("Done — I've added the task and set the reminder."));

		const result = await runAssistantToolLoop(USER, [{ role: 'user', content: 'add a task and a reminder' }], {
			systemPrompt: 'sys',
		});

		expect(result.content).toContain('Task "Send the invoice" added.');
		expect(result.content).toMatch(/didn't work/i);
		// Nothing internal leaks into the reply the user reads.
		expect(result.content).not.toMatch(/create_reminder|trigger_at|is in the past|Recompute/);
	});

	it('keeps the model\'s natural reply when the write succeeded', async () => {
		const natural = 'Done — "Send the invoice" is on your list for tomorrow.';
		mockedChatCompletion
			.mockResolvedValueOnce(completion("I'll add that now.", [createTask()]))
			.mockResolvedValueOnce(completion(natural));

		const result = await runAssistantToolLoop(USER, [{ role: 'user', content: 'add a task' }], {
			systemPrompt: 'sys',
		});

		expect(result.toolCalls[0].ok).toBe(true);
		expect(result.content).toBe(natural);
		expect(result.claimCorrected).toBeFalsy();
	});
});

describe('runAssistantToolLoop — the iteration cap', () => {
	it('returns the tool results, not the narration the model never checked', async () => {
		// Every call asks for the same refused tool and narrates success. The
		// model never gets to see a result, so its text is not an outcome.
		mockedChatCompletion.mockResolvedValue(completion("Done! I've set your reminder.", [refusedReminder()]));

		const result = await runAssistantToolLoop(USER, [{ role: 'user', content: 'remind me' }], {
			systemPrompt: 'sys',
		});

		expect(result.capped).toBe(true);
		expect(result.iterations).toBe(3);
		expect(result.content).toMatch(/didn't work/i);
		expect(result.content).not.toMatch(/Done!/);
		expect(result.claimCorrected).toBe(true);
	});
});

// ─── Through the routes the phone actually calls ────────────────────────────

describe('the user-visible reply is grounded, not narrated', () => {
	it('does not deliver an unbacked completion claim through /chat/message', async () => {
		mockedChatCompletion.mockResolvedValue(completion("Done! I've completed the proposal."));

		const res = await request(app)
			.post('/api/v1/chat/message')
			.set(authHeader())
			.send({ sessionId: uuidv4(), content: 'Okay, I finished the proposal.' });

		expect(res.status).toBe(200);
		expect(res.body.data.assistantMessage.content).toBe(NOTHING_PERFORMED_REPLY);
		expect(res.body.data.assistantMessage.content).not.toMatch(/done/i);
	});

	it('does not deliver an unbacked reopen claim through /voice/chat', async () => {
		mockedChatCompletion.mockResolvedValue(
			completion("Done! I've reopened the task to prepare the client proposal."),
		);

		const res = await request(app)
			.post('/api/v1/voice/chat')
			.set(authHeader())
			.send({ messages: [{ role: 'user', content: 'Actually reopen it.' }], language: 'en' });

		expect(res.status).toBe(200);
		expect(res.body.data.text).toBe(NOTHING_PERFORMED_REPLY);
	});
});
