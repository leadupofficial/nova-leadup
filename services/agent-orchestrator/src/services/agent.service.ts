/**
 * Agent service — manages AI agent definitions, versions, and capabilities.
 */

import { db } from '@nova/database';
import type { Agent, CreateAgentInput, UpdateAgentInput, AgentCapability } from '@nova/shared-types';

export interface AgentServiceOptions {
	db: typeof db;
}

export class AgentService {
	constructor(private readonly opts: AgentServiceOptions) {}

	/**
	 * List agents for an organization.
	 */
	async list(organizationId: string, filters?: { active?: boolean; capability?: string }): Promise<Agent[]> {
		let query = 'SELECT * FROM agents WHERE organization_id = $1';
		const params: unknown[] = [organizationId];
		let idx = 2;

		if (filters?.active !== undefined) {
			query += ` AND active = $${idx++}`;
			params.push(filters.active);
		}
		if (filters?.capability) {
			query += ` AND $${idx++} = ANY(capabilities)`;
			params.push(filters.capability);
		}

		query += ' ORDER BY created_at DESC';
		const result = await this.opts.db.query(query, params);
		return result.rows.map(this.mapRow);
	}

	/**
	 * Get a single agent by ID.
	 */
	async get(agentId: string): Promise<Agent | null> {
		const result = await this.opts.db.query('SELECT * FROM agents WHERE id = $1', [agentId]);
		return result.rows[0] ? this.mapRow(result.rows[0]) : null;
	}

	/**
	 * Create a new agent.
	 */
	async create(input: CreateAgentInput): Promise<Agent> {
		const result = await this.opts.db.query(
			`INSERT INTO agents (organization_id, name, description, system_prompt, capabilities, model, temperature, max_tokens, active, created_by, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()) RETURNING *`,
			[
				input.organizationId,
				input.name,
				input.description ?? null,
				input.systemPrompt ?? null,
				input.capabilities ?? [],
				input.model ?? 'claude-3-5-sonnet',
				input.temperature ?? 0.7,
				input.maxTokens ?? 4096,
				input.active ?? true,
				input.createdBy,
			]
		);
		return this.mapRow(result.rows[0]);
	}

	/**
	 * Update an existing agent.
	 */
	async update(agentId: string, input: UpdateAgentInput): Promise<Agent> {
		const existing = await this.get(agentId);
		if (!existing) throw new Error(`Agent not found: ${agentId}`);

		const updates: string[] = [];
		const params: unknown[] = [agentId];
		let idx = 2;

		if (input.name !== undefined) { updates.push(`name = $${idx++}`); params.push(input.name); }
		if (input.description !== undefined) { updates.push(`description = $${idx++}`); params.push(input.description); }
		if (input.systemPrompt !== undefined) { updates.push(`system_prompt = $${idx++}`); params.push(input.systemPrompt); }
		if (input.capabilities !== undefined) { updates.push(`capabilities = $${idx++}`); params.push(input.capabilities); }
		if (input.model !== undefined) { updates.push(`model = $${idx++}`); params.push(input.model); }
		if (input.temperature !== undefined) { updates.push(`temperature = $${idx++}`); params.push(input.temperature); }
		if (input.maxTokens !== undefined) { updates.push(`max_tokens = $${idx++}`); params.push(input.maxTokens); }
		if (input.active !== undefined) { updates.push(`active = $${idx++}`); params.push(input.active); }

		if (updates.length === 0) return existing;

		updates.push(`updated_at = NOW()`);
		const query = `UPDATE agents SET ${updates.join(', ')} WHERE id = $1 RETURNING *`;
		const result = await this.opts.db.query(query, params);
		return this.mapRow(result.rows[0]);
	}

	/**
	 * Delete an agent (hard delete — consider soft-delete based on requirements).
	 */
	async delete(agentId: string): Promise<void> {
		const result = await this.opts.db.query('DELETE FROM agents WHERE id = $1 RETURNING id', [agentId]);
		if (result.rows.length === 0) {
			throw new Error(`Agent not found: ${agentId}`);
		}
	}

	/**
	 * Execute an agent with a prompt and optional context.
	 */
	async execute(agentId: string, input: { prompt: string; context?: Record<string, unknown>; userId: string }): Promise<{ response: string; usage: { inputTokens: number; outputTokens: number } }> {
		const agent = await this.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);
		if (!agent.active) throw new Error(`Agent is inactive: ${agentId}`);

		const Anthropic = (await import('@anthropic-ai/sdk')).default;
		const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

		const messages = [
			{ role: 'user' as const, content: input.prompt },
		];

		try {
			const response = await anthropic.messages.create({
				model: agent.model,
				max_tokens: agent.maxTokens,
				system: agent.systemPrompt ?? undefined,
				messages,
			});

			const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
			return {
				response: text,
				usage: {
					inputTokens: response.usage.input_tokens,
					outputTokens: response.usage.output_tokens,
				},
			};
		} catch (err) {
			console.error(`[agent-service] Execution failed for agent ${agentId}:`, err);
			throw new Error(`Agent execution failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ─── Private helpers ────────────────────────────────────────────────────────

	private mapRow(row: Record<string, unknown>): Agent {
		return {
			id: row.id as string,
			organizationId: row.organization_id as string,
			name: row.name as string,
			description: row.description as string | undefined,
			systemPrompt: row.system_prompt as string | undefined,
			capabilities: (row.capabilities as string[]) ?? [],
			model: row.model as string,
			temperature: Number(row.temperature),
			maxTokens: Number(row.max_tokens),
			active: row.active as boolean,
			createdBy: row.created_by as string,
			createdAt: new Date(row.created_at as string),
			updatedAt: new Date(row.updated_at as string),
		};
	}
}
