/**
 * NOVA AI Core — Claude provider types.
 *
 * These types describe the NOVA-internal contract for Claude API interactions.
 * They are defined here (not in @nova/shared-types) because they are
 * provider-specific — shared-types holds NOVA domain contracts only.
 */

// ─── Model ──────────────────────────────────────────────────────────────────

export type ClaudeModel =
 | 'claude-sonnet-4-20250514'
 | 'claude-haiku-4-5-20251001'
 | `claude-${string}`; // forward-compatible

// ─── Messages ───────────────────────────────────────────────────────────────

export interface ClaudeMessage {
 readonly role: 'user' | 'assistant' | 'system';
 readonly content: string;
}

// ─── Completion request/response ────────────────────────────────────────────

export interface ClaudeCompletionRequest {
 readonly model: ClaudeModel;
 readonly max_tokens: number;
 readonly messages: readonly ClaudeMessage[];
 readonly tools?: readonly ClaudeToolDefinition[];
 readonly system?: string;
}

export interface ClaudeToolUseBlock {
 readonly type: 'tool_use';
 readonly name: string;
 readonly input: unknown;
}

export interface ClaudeTextBlock {
 readonly type: 'text';
 readonly text: string;
}

export type ClaudeCompletionResponseContent =
 | ClaudeTextBlock
 | ClaudeToolUseBlock;

export interface ClaudeCompletionResponse {
 readonly content: readonly ClaudeCompletionResponseContent[];
 readonly id: string;
 readonly model: string;
 readonly stop_reason: string;
 readonly usage: {
 readonly input_tokens: number;
 readonly output_tokens: number;
 };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export interface ClaudeToolDefinition {
 readonly name: string;
 readonly description: string;
 readonly inputSchema: {
 readonly type: 'object';
 readonly properties?: Record<string, unknown>;
 readonly required?: readonly string[];
 };
}

export interface ToolCall {
 readonly name: string;
 readonly input: Record<string, unknown>;
}

// ─── Routing ─────────────────────────────────────────────────────────────────

export interface RouteContext {
 readonly risk: boolean;
 readonly structured: boolean;
}

export interface ModelRouter {
 route(context: RouteContext): ClaudeModel;
}

// ─── Prompt layers ───────────────────────────────────────────────────────────

export interface PromptLayer {
 readonly layer: number;
 readonly name: string;
 readonly content: string;
}
