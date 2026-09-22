/**
 * Execution service — tracks and manages agent execution runs.
 */

import { db } from '@nova/database';

export interface ExecutionRecord {
	id: string;
	agentId: string;
	userId: string;
	organizationId: string;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
	input: Record<string, unknown>;
	output?: Record<string, unknown>;
	error?: string;
	startedAt: Date;
	completedAt?: Date;
	latencyMs?: number;
	tokensUsed?: number;
}

export interface ExecutionServiceOptions {
	db: typeof db;
}

export class ExecutionService {
	constructor(private readonly opts: ExecutionServiceOptions) {}

	/**
	 * Create a new execution record.
	 */
	async create(data: {
		agentId: string;
		userId: string;
		organizationId: string;
		input: Record<string, unknown>;
	}): Promise<ExecutionRecord> {
		const result = await this.opts.db.query(
			`INSERT INTO agent_executions (agent_id, user_id, organization_id, status, input, started_at)
			 VALUES ($1, $2, $3, 'pending', $4, NOW()) RETURNING *`,
			[data.agentId, data.userId, data.organizationId, JSON.stringify(data.input)]
		);
		return this.mapRow(result.rows[0]);
	}

	/**
	 * Update execution status.
	 */
	async updateStatus(
		executionId: string,
		status: ExecutionRecord['status'],
		extra?: { output?: Record<string, unknown>; error?: string; latencyMs?: number; tokensUsed?: number }
	): Promise<ExecutionRecord> {
		const updates: string[] = ["status = $2"];
		const params: unknown[] = [executionId, status];
		let idx = 3;

		if (extra?.output) { updates.push(`output = $${idx++}`); params.push(JSON.stringify(extra.output)); }
		if (extra?.error) { updates.push(`error = $${idx++}`); params.push(extra.error); }
		if (extra?.latencyMs !== undefined) { updates.push(`latency_ms = $${idx++}`); params.push(extra.latencyMs); }
		if (extra?.tokensUsed !== undefined) { updates.push(`tokens_used = $${idx++}`); params.push(extra.tokensUsed); }

		if (status === 'completed' || status === 'failed' || status === 'cancelled') {
			updates.push(`completed_at = NOW()`);
		}

		const query = `UPDATE agent_executions SET ${updates.join(', ')} WHERE id = $1 RETURNING *`;
		const result = await this.opts.db.query(query, params);
		if (result.rows.length === 0) throw new Error(`Execution not found: ${executionId}`);
		return this.mapRow(result.rows[0]);
	}

	/**
	 * List executions for an organization with optional filters.
	 */
	async list(organizationId: string, filters?: { agentId?: string; userId?: string; status?: ExecutionRecord['status']; limit?: number; offset?: number }): Promise<ExecutionRecord[]> {
		let query = 'SELECT * FROM agent_executions WHERE organization_id = $1';
		const params: unknown[] = [organizationId];
		let idx = 2;

		if (filters?.agentId) { query += ` AND agent_id = $${idx++}`; params.push(filters.agentId); }
		if (filters?.userId) { query += ` AND user_id = $${idx++}`; params.push(filters.userId); }
		if (filters?.status) { query += ` AND status = $${idx++}`; params.push(filters.status); }

		query += ' ORDER BY started_at DESC';
		if (filters?.limit) { query += ` LIMIT $${idx++}`; params.push(filters.limit); }
		if (filters?.offset) { query += ` OFFSET $${idx++}`; params.push(filters.offset); }

		const result = await this.opts.db.query(query, params);
		return result.rows.map(this.mapRow);
	}

	/**
	 * Get a single execution by ID.
	 */
	async get(executionId: string): Promise<ExecutionRecord | null> {
		const result = await this.opts.db.query('SELECT * FROM agent_executions WHERE id = $1', [executionId]);
		return result.rows[0] ? this.mapRow(result.rows[0]) : null;
	}

	/**
	 * Cancel a pending/running execution.
	 */
	async cancel(executionId: string): Promise<ExecutionRecord> {
		return this.updateStatus(executionId, 'cancelled');
	}

	private mapRow(row: Record<string, unknown>): ExecutionRecord {
		return {
			id: row.id as string,
			agentId: row.agent_id as string,
			userId: row.user_id as string,
			organizationId: row.organization_id as string,
			status: row.status as ExecutionRecord['status'],
			input: (row.input as Record<string, unknown>) ?? {},
			output: row.output ? (row.output as Record<string, unknown>) : undefined,
			error: row.error as string | undefined,
			startedAt: new Date(row.started_at as string),
			completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
			latencyMs: row.latency_ms ? Number(row.latency_ms) : undefined,
			tokensUsed: row.tokens_used ? Number(row.tokens_used) : undefined,
		};
	}
}
