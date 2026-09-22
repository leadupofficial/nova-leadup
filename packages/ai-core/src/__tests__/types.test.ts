import { describe, it, expect } from 'vitest';
import { ClaudeModel, ClaudeMessage, ClaudeCompletionRequest, ClaudeCompletionResponse, ClaudeToolDefinition, RouteContext, PromptLayer, ToolCall } from '../types.js';

describe('Types', () => {
 it('ClaudeModel accepts valid values', () => {
 const models: ClaudeModel[] = ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-custom-20240101'];
 for (const model of models) {
 expect(typeof model).toBe('string');
 expect(model.startsWith('claude-')).toBe(true);
 }
 });

 it('ClaudeMessage has required properties', () => {
 const message: ClaudeMessage = {
 role: 'user',
 content: 'Hello',
 };
 expect(message).toHaveProperty('role');
 expect(message).toHaveProperty('content');
 expect(['user', 'assistant', 'system']).toContain(message.role);
 });

 it('ClaudeCompletionRequest structure', () => {
 const request: ClaudeCompletionRequest = {
 model: 'claude-sonnet-4-20250514',
 max_tokens: 1024,
 messages: [{ role: 'user', content: 'Test' }],
 };
 expect(request).toHaveProperty('model');
 expect(request).toHaveProperty('max_tokens');
 expect(request).toHaveProperty('messages');
 expect(Array.isArray(request.messages)).toBe(true);
 });

 it('ClaudeCompletionResponse structure', () => {
 const response: ClaudeCompletionResponse = {
 content: [{ type: 'text', text: 'Response' }],
 id: 'msg_123',
 model: 'claude-sonnet-4-20250514',
 stop_reason: 'end_turn',
 usage: { input_tokens: 10, output_tokens: 5 },
 };
 expect(response).toHaveProperty('content');
 expect(response).toHaveProperty('id');
 expect(response).toHaveProperty('model');
 expect(response).toHaveProperty('stop_reason');
 expect(response).toHaveProperty('usage');
 expect(response.usage).toHaveProperty('input_tokens');
 expect(response.usage).toHaveProperty('output_tokens');
 });

 it('ClaudeToolDefinition structure', () => {
 const tool: ClaudeToolDefinition = {
 name: 'search',
 description: 'Search',
 inputSchema: {
 type: 'object',
 properties: { query: { type: 'string' } },
 required: ['query'],
 },
 };
 expect(tool).toHaveProperty('name');
 expect(tool).toHaveProperty('description');
 expect(tool).toHaveProperty('inputSchema');
 expect(tool.inputSchema.type).toBe('object');
 });

 it('RouteContext structure', () => {
 const context: RouteContext = { risk: false, structured: true };
 expect(context).toHaveProperty('risk');
 expect(context).toHaveProperty('structured');
 expect(typeof context.risk).toBe('boolean');
 expect(typeof context.structured).toBe('boolean');
 });

 it('PromptLayer structure', () => {
 const layer: PromptLayer = { layer: 1, name: 'Context', content: 'You are helpful' };
 expect(layer).toHaveProperty('layer');
 expect(layer).toHaveProperty('name');
 expect(layer).toHaveProperty('content');
 expect(typeof layer.layer).toBe('number');
 });

 it('ToolCall structure', () => {
 const call: ToolCall = { name: 'search', input: { query: 'test' } };
 expect(call).toHaveProperty('name');
 expect(call).toHaveProperty('input');
 });
});
