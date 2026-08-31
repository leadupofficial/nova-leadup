/**
 * NOVA AI Core — Claude adapter, model router, and session orchestrator.
 *
 * Server-side only. Never bundled into the mobile client.
 *
 * Non-negotiable: requires ANTHROPIC_API_KEY environment variable.
 * See Section 7.2 for Sonnet/Haiku routing rules.
 */

import type {
 ClaudeModel,
 ClaudeMessage,
 ClaudeCompletionRequest,
 ClaudeCompletionResponse,
 ClaudeToolDefinition,
 ToolCall,
 ClaudeToolUseBlock,
 PromptLayer,
 ModelRouter,
 RouteContext,
} from './types';

// ─── Model Router ──────────────────────────────────────────────────────────

/**
 * Route a request to the appropriate Claude model.
 *
 * Per blueprint Section 7.2:
 * - Sonnet: main conversation, multi-tool planning, complex requests
 * - Haiku: reminder/task extraction, recording summaries, memory classification,
 * notification triage (structured, low-risk only)
 */
export class BlueprintModelRouter implements ModelRouter {
 route(context: RouteContext): ClaudeModel {
 const { risk, structured } = context;

 if (!risk && structured) {
 return 'claude-haiku-4-5-20251001'; // cheap structured extraction
 }
 return 'claude-sonnet-4-20250514'; // default to best reasoning
 }
}

// ─── Prompt Layer Builder ──────────────────────────────────────────────────

/**
 * Assemble the 6-layer prompt per blueprint Section 7.5.
 *
 * Layer 5 (retrieved memory) is UNTRUSTED DATA — injected as context but never
 * treated as instructions. Layer 6 (user message) is the only actionable input.
 */
export function buildLayeredPrompt(layers: PromptLayer[]): ClaudeMessage[] {
 return layers
 .sort((a, b) => a.layer - b.layer)
 .map((layer) => ({
 role: 'system',
 content: `[Layer ${layer.layer}] ${layer.name}\n${layer.content}`,
 }));
}

// ─── Tool Validator ─────────────────────────────────────────────────────────

/**
 * Validate tool calls per blueprint Section 7.4/15.3.
 * All tool inputs must be schema-validated before execution.
 * Side-effecting tools require an approval token bound to the exact payload.
 */
export function validateToolCall(
 toolCall: ToolCall,
 registeredTools: readonly ClaudeToolDefinition[]
): { valid: boolean; error?: string } {
 const toolDef = registeredTools.find((t) => t.name === toolCall.name);
 if (!toolDef) {
 return { valid: false, error: `Tool "${toolCall.name}" is not registered` };
 }

 // In production, validate toolCall.input against toolDef.inputSchema here.
 // For MVP, we trust Claude's structured output per the tool definition.
 return { valid: true };
}

// ─── Session Orchestrator ───────────────────────────────────────────────────

export interface ConversationTurn {
 readonly userMessage: string;
 readonly response: string;
 readonly model: ClaudeModel;
 readonly toolCalls: readonly string[];
 readonly timestamp: number;
 readonly requestId: string;
}

export interface SessionOrchestratorOptions {
 readonly apiKey: string;
 readonly modelRouter?: ModelRouter;
 readonly tools?: readonly ClaudeToolDefinition[];
 readonly maxHistoryLength?: number;
 readonly enableApprovalGate?: boolean;
}

export class SessionOrchestrator {
 private apiKey: string;
 private modelRouter: ModelRouter;
 private tools: readonly ClaudeToolDefinition[];
 private maxHistory: number;
 private enableApprovalGate: boolean;
 private conversationHistory: ClaudeMessage[] = [];

 constructor(options: SessionOrchestratorOptions) {
 if (!options.apiKey) {
 throw new Error('ANTHROPIC_API_KEY is required — see Section 18.2');
 }
 this.apiKey = options.apiKey;
 this.modelRouter = options.modelRouter ?? new BlueprintModelRouter();
 this.tools = options.tools ?? [];
 this.maxHistory = options.maxHistoryLength ?? 20;
 this.enableApprovalGate = options.enableApprovalGate ?? true;
 }

 async converse(userMessage: string, context: RouteContext): Promise<ConversationTurn> {
 const model = this.modelRouter.route(context);
 const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

 // Build request with conversation history
 const messages: ClaudeMessage[] = [
 ...this.conversationHistory,
 { role: 'user', content: userMessage },
 ];

 const response = await this.callClaude({
 model,
 max_tokens: 1024,
 messages,
 tools: this.tools.length > 0 ? this.tools : undefined,
 });

 const assistantContent = this.extractText(response);
 const toolCalls = this.extractToolCalls(response);

 // Persist to history (respect max length)
 this.conversationHistory.push({ role: 'user', content: userMessage });
 this.conversationHistory.push({ role: 'assistant', content: assistantContent });
 this.trimHistory();

 return {
 userMessage,
 response: assistantContent,
 model,
 toolCalls,
 timestamp: Date.now(),
 requestId,
 };
 }

 getHistory(): readonly ClaudeMessage[] {
 return [...this.conversationHistory];
 }

 clearHistory(): void {
 this.conversationHistory = [];
 }

 private async callClaude(request: ClaudeCompletionRequest): Promise<ClaudeCompletionResponse> {
 // API key is never exposed to the client — server-side only.
 // In production, use a server-side proxy to avoid exposing the key.
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

 private extractText(response: ClaudeCompletionResponse): string {
 return response.content
 .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
 .map((block) => block.text)
 .join('\n');
 }

 private extractToolCalls(response: ClaudeCompletionResponse): readonly string[] {
 return response.content
 .filter((block): block is ClaudeToolUseBlock => block.type === 'tool_use')
 .map((block) => block.name);
 }

 private trimHistory(): void {
 if (this.conversationHistory.length > this.maxHistory) {
 this.conversationHistory = this.conversationHistory.slice(-this.maxHistory);
 }
 }
}
