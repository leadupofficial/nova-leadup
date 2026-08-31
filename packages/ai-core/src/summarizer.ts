/**
 * LEA-011 — Summarizer
 *
 * Generates meeting summaries and extracts action items from transcripts
 * using Claude Haiku (cost-efficient, per blueprint Section 7.2).
 *
 * Server-side only. Requires ANTHROPIC_API_KEY.
 */

import type {
 ClaudeModel,
 ClaudeMessage,
 ClaudeCompletionRequest,
 ClaudeCompletionResponse,
 ClaudeToolDefinition,
} from './types';
import { BlueprintModelRouter } from './orchestrator';

// ─── Output Types ────────────────────────────────────────────────────────────

export interface SummaryOptions {
 readonly language?: string;
 readonly maxLength?: 'short' | 'medium' | 'long';
 readonly transcriptText: string;
 readonly recordingTitle?: string;
 readonly participantCount?: number;
}

export interface SummaryResult {
 readonly summary: string;
 readonly decisions: readonly string[];
 readonly actionItems: readonly ActionItemExtraction[];
 readonly extractedContacts: readonly ExtractedContact[];
 readonly model: string;
 readonly processingMs: number;
}

export interface ActionItemExtraction {
 readonly type: 'task' | 'reminder' | 'followup';
 readonly description: string;
 readonly assignee?: string;
 readonly dueAt?: string;
 readonly confidence: number;
 readonly evidence: string;
}

export interface ExtractedContact {
 readonly name: string;
 readonly phone?: string;
 readonly email?: string;
 readonly organization?: string;
 readonly confidence: number;
}

// ─── Summarizer ──────────────────────────────────────────────────────────────

export class Summarizer {
 private readonly router: BlueprintModelRouter;
 private readonly apiKey: string;

 constructor(apiKey?: string) {
 this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
 if (!this.apiKey) {
 throw new Error('ANTHROPIC_API_KEY is required for the summarizer');
 }
 this.router = new BlueprintModelRouter();
 }

 /**
 * Generate a summary with action items from a transcript.
 */
 async summarize(options: SummaryOptions): Promise<SummaryResult> {
 const start = Date.now();
 const model = this.routeModel(options);
 const systemPrompt = buildSystemPrompt(options);
 const userMessage = buildUserMessage(options);

 const request: ClaudeCompletionRequest = {
 model,
 max_tokens: 2048,
 messages: [
 ...systemPrompt,
 { role: 'user', content: userMessage },
 ],
 tools: [extractionToolDefinition],
 };

 const response = await this.callClaude(request);
 const processingMs = Date.now() - start;

 const result = parseSummaryResponse(response);

 return {
 ...result,
 model,
 processingMs,
 };
 }

 private routeModel(options: SummaryOptions): ClaudeModel {
 // Summarization is structured, low-risk → route to Haiku per blueprint Section 7.2
 const context = { risk: false, structured: true };
 return this.router.route(context);
 }

 private async callClaude(request: ClaudeCompletionRequest): Promise<ClaudeCompletionResponse> {
 const response = await fetch('https://api.anthropic.com/v1/messages', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'x-api-key': this.apiKey,
 'anthropic-version': '2023-06-01',
 'anthropic-dangerous-direct-browser-access': 'true',
 },
 body: JSON.stringify(request),
 });

 if (!response.ok) {
 const text = await response.text();
 throw new Error(`Claude API error ${response.status}: ${text}`);
 }

 return response.json();
 }
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function buildSystemPrompt(options: SummaryOptions): ClaudeMessage[] {
 const langHint = options.language
 ? ` The transcript is in ${options.language}.`
 : '';
 const lengthGuide = options.maxLength === 'short'
 ? 'Keep the summary under 100 words.'
 : options.maxLength === 'long'
 ? 'Provide a comprehensive summary covering all key points.'
 : 'Provide a concise summary covering the main points.';

 return [{
 role: 'system',
 content: `You are a meeting intelligence assistant. Analyze the transcript and produce:
1. A structured summary
2. Key decisions made
3. Action items proposed (with type: task, reminder, or followup)
4. Extracted contacts mentioned

${langHint}
${lengthGuide}

For each action item, estimate confidence (0-100) and quote the evidence from the transcript.
For contacts, extract name, organization, email/phone if mentioned.

Respond ONLY with the structured_extraction tool call. Do not add conversational text.`,
 }];
}

function buildUserMessage(options: SummaryOptions): string {
 const title = options.recordingTitle ? `Meeting: ${options.recordingTitle}` : 'Meeting Transcript';
 const participants = options.participantCount
 ? ` (${options.participantCount} participants)`
 : '';

 return `${title}${participants}

--- TRANSCRIPT ---

${options.transcriptText}

--- END TRANSCRIPT ---

Please analyze this transcript and call structured_extraction with your findings.`;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

const extractionToolDefinition: ClaudeToolDefinition = {
 name: 'structured_extraction',
 description: 'Extract structured information from a meeting transcript',
 inputSchema: {
 type: 'object',
 properties: {
 summary: { type: 'string', description: 'Meeting summary (2-4 sentences)' },
 decisions: {
 type: 'array',
 items: { type: 'string' },
 description: 'Key decisions made during the meeting',
 },
 actionItems: {
 type: 'array',
 items: {
 type: 'object',
 properties: {
 type: { type: 'string', enum: ['task', 'reminder', 'followup'] },
 description: { type: 'string' },
 assignee: { type: 'string' },
 dueAt: { type: 'string' },
 confidence: { type: 'integer', minimum: 0, maximum: 100 },
 evidence: { type: 'string' },
 },
 required: ['type', 'description', 'confidence', 'evidence'],
 },
 description: 'Action items proposed in the meeting',
 },
 extractedContacts: {
 type: 'array',
 items: {
 type: 'object',
 properties: {
 name: { type: 'string' },
 phone: { type: 'string' },
 email: { type: 'string' },
 organization: { type: 'string' },
 confidence: { type: 'integer', minimum: 0, maximum: 100 },
 },
 required: ['name', 'confidence'],
 },
 description: 'Contacts mentioned in the transcript',
 },
 },
 required: ['summary', 'decisions', 'actionItems', 'extractedContacts'],
 },
};

// ─── Response Parser ─────────────────────────────────────────────────────────

function parseSummaryResponse(
 response: { content: readonly { type: string; input?: unknown }[] },
): Omit<SummaryResult, 'model' | 'processingMs'> {
 const toolBlock = response.content.find(
 (block): block is { type: 'tool_use'; input: Record<string, unknown> } =>
 block.type === 'tool_use',
 );

 if (!toolBlock || !toolBlock.input) {
 return {
 summary: 'No summary available',
 decisions: [],
 actionItems: [],
 extractedContacts: [],
 };
 }

 const input = toolBlock.input;
 const parseStringArray = (key: string): readonly string[] =>
 (input[key] as string[] | undefined) ?? [];

 const parseContacts = (): readonly ExtractedContact[] =>
 (input.extractedContacts as Array<Record<string, unknown>> | undefined)?.map((c) => ({
 name: String(c.name ?? ''),
 phone: (c.phone as string | undefined) ?? undefined,
 email: (c.email as string | undefined) ?? undefined,
 organization: (c.organization as string | undefined) ?? undefined,
 confidence: Number(c.confidence ?? 50),
 })) ?? [];

 const parseActionItems = (): readonly ActionItemExtraction[] =>
 (input.actionItems as Array<Record<string, unknown>> | undefined)?.map((a) => ({
 type: a.type as ActionItemExtraction['type'],
 description: String(a.description ?? ''),
 assignee: (a.assignee as string | undefined) ?? undefined,
 dueAt: (a.dueAt as string | undefined) ?? undefined,
 confidence: Number(a.confidence ?? 50),
 evidence: String(a.evidence ?? ''),
 })) ?? [];

 return {
 summary: String(input.summary ?? ''),
 decisions: parseStringArray('decisions'),
 actionItems: parseActionItems(),
 extractedContacts: parseContacts(),
 };
}
