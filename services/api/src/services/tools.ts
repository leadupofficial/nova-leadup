/**
 * NOVA API — Tool execution service.
 *
 * Manages tool definitions, approval flow, and execution lifecycle.
 */
import { getDb } from '../db/connection.js';
import { toolDefinitions, toolExecutions, toolApprovals } from '@nova/database';
import { eq, desc, sql, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

export interface ToolExecutionInput {
 userId: string;
 tenantId?: string;
 toolId: string;
 input: Record<string, unknown>;
 permissionLevel: number;
 requiresConfirmation?: boolean;
}

export interface ToolExecutionResult {
 id: string;
 success: boolean;
 output?: Record<string, unknown>;
 errorCode?: string;
 errorMessage?: string;
 durationMs?: number;
}

export async function executeTool(input: ToolExecutionInput): Promise<ToolExecutionResult> {
 const db = getDb();
 const start = Date.now();
 const requestId = crypto.randomUUID();

 // Check tool is enabled
 const [tool] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, input.toolId));
 if (!tool || !tool.enabled) {
 return {
 id: '',
 success: false,
 errorCode: 'TOOL_DISABLED',
 errorMessage: 'Tool is not enabled',
 };
 }

 // Check permission level
 if (input.permissionLevel < (tool.permissionLevel ?? 0)) {
 const [approval] = await db.insert(toolApprovals).values({
 userId: input.userId,
 tenantId: input.tenantId ?? null,
 toolId: input.toolId,
 toolInput: input.input,
 permissionLevel: input.permissionLevel,
 status: 'pending',
 expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
 }).returning();

 return {
 id: approval.id,
 success: false,
 errorCode: 'APPROVAL_REQUIRED',
 errorMessage: 'Tool execution requires approval',
 };
 }

 // Execute
 try {
 const { name, inputSchema, permissionLevel } = tool;
 const output = await runTool({ name, inputSchema: inputSchema as Record<string, unknown>, permissionLevel }, input.input);
 const durationMs = Date.now() - start;

 const [execution] = await db.insert(toolExecutions).values({
 userId: input.userId,
 tenantId: input.tenantId ?? null,
 toolId: input.toolId,
 input: input.input,
 output,
 success: true,
 durationMs,
 requestId,
 }).returning();

 return {
 id: execution.id,
 success: true,
 output,
 durationMs,
 };
 } catch (err) {
 const durationMs = Date.now() - start;
 const errorMessage = err instanceof Error ? err.message : 'Unknown error';
 const errorCode = err instanceof Error && 'code' in err ? String((err as any).code) : 'EXECUTION_ERROR';

 await db.insert(toolExecutions).values({
 userId: input.userId,
 tenantId: input.tenantId ?? null,
 toolId: input.toolId,
 input: input.input,
 success: false,
 errorCode,
 errorMessage,
 durationMs,
 requestId,
 });

 return {
 id: '',
 success: false,
 errorCode,
 errorMessage,
 durationMs,
 };
 }
}

async function runTool(
 tool: { name: string; inputSchema: Record<string, unknown>; permissionLevel: number },
 input: Record<string, unknown>
): Promise<Record<string, unknown>> {
 // Tool execution is sandboxed. Each tool has its own handler.
 // This is the dispatcher — add tool implementations here.
 switch (tool.name) {
 default:
 throw new Error(`Unknown tool: ${tool.name}`);
 }
}

export async function getToolDefinition(toolId: string) {
 const db = getDb();
 const [tool] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, toolId));
 return tool ?? null;
}

export async function listToolDefinitions(tenantScope = 'personal') {
 const db = getDb();
 return db.select().from(toolDefinitions).where(and(eq(toolDefinitions.tenantScope, tenantScope), eq(toolDefinitions.enabled, true)));
}

export async function approveToolExecution(approvalId: string, approved: boolean) {
 const db = getDb();
 const now = new Date();

 if (approved) {
 const [approval] = await db.update(toolApprovals)
 .set({ status: 'approved', decidedAt: now })
 .where(eq(toolApprovals.id, approvalId))
 .returning();
 return approval ?? null;
 }

 const [approval] = await db.update(toolApprovals)
 .set({ status: 'denied', decidedAt: now })
 .where(eq(toolApprovals.id, approvalId))
 .returning();
 return approval ?? null;
}

export async function getExecutionHistory(userId: string, limit = 50) {
 const db = getDb();
 return db.select().from(toolExecutions)
 .where(eq(toolExecutions.userId, userId))
 .orderBy(desc(toolExecutions.createdAt))
 .limit(limit);
}
