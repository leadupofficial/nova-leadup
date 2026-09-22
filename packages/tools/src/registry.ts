/**
 * @nova/tools — Tool registry for registration, discovery, and lookup.
 *
 * Provides a centralized registry where tools declare themselves and
 * consumers discover available tools. Supports filtering, tagging,
 * and validation.
 */

import type {
	NovaToolDefinition,
	ToolRegistration,
	ToolFilterCriteria,
	RegistryStats,
	PermissionLevel,
} from './types.js';

export type {
	NovaToolDefinition,
	ToolRegistration,
	ToolExecutionContext,
	ToolResult,
	ToolFilterCriteria,
	RegistryStats,
} from './types.js';

// ─── Internal Registry ──────────────────────────────────────────────────────────

const REGISTRY = new Map<string, ToolRegistration>();

/**
 * Register a tool in the global registry.
 *
 * If a tool with the same id is already registered, the new definition
 * replaces it (idempotent re-registration).
 */
export function registerTool(tool: NovaToolDefinition, tags: readonly string[] = []): void {
	REGISTRY.set(tool.id, {
		tool,
		registeredAt: Date.now(),
		tags: [...tags],
	});
}

/**
 * Register multiple tools at once.
 */
export function registerTools(tools: readonly NovaToolDefinition[], tags: readonly string[] = []): void {
	for (const tool of tools) {
		registerTool(tool, tags);
	}
}

/**
 * Unregister a tool by id.
 */
export function unregisterTool(toolId: string): boolean {
	return REGISTRY.delete(toolId);
}

/**
 * Get a tool by id. Returns undefined if not registered.
 */
export function getTool(toolId: string): NovaToolDefinition | undefined {
	return REGISTRY.get(toolId)?.tool;
}

/**
 * Get a tool by name. Returns undefined if not registered.
 */
export function getToolByName(name: string): NovaToolDefinition | undefined {
	for (const entry of REGISTRY.values()) {
		if (entry.tool.name === name) {
			return entry.tool;
		}
	}
	return undefined;
}

/**
 * List all registered tools, optionally filtered.
 */
export function listTools(criteria: ToolFilterCriteria = {}): readonly NovaToolDefinition[] {
	let results = [...REGISTRY.values()].map((e) => e.tool);

	if (criteria.permissionLevel !== undefined) {
		results = results.filter((t) => t.permissionLevel <= criteria.permissionLevel!);
	}

	if (criteria.tags && criteria.tags.length > 0) {
		results = results.filter((t) => {
			const entry = REGISTRY.get(t.id);
			return entry?.tags?.some((tag) => criteria.tags!.includes(tag)) ?? false;
		});
	}

	if (criteria.searchQuery) {
		const query = criteria.searchQuery.toLowerCase();
		results = results.filter(
			(t) =>
				t.name.toLowerCase().includes(query) ||
				t.description.toLowerCase().includes(query),
		);
	}

	return results;
}

/**
 * List all registered tool ids.
 */
export function listToolIds(): readonly string[] {
	return [...REGISTRY.keys()];
}

/**
 * Clear the entire registry.
 */
export function clearRegistry(): void {
	REGISTRY.clear();
}

/**
 * Return registry statistics.
 */
export function getRegistryStats(): RegistryStats {
	const tools = [...REGISTRY.values()].map((e) => e.tool);
	const byPermissionLevel: Record<PermissionLevel, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
	const byTag: Record<string, number> = {};

	for (const entry of REGISTRY.values()) {
		byPermissionLevel[entry.tool.permissionLevel]++;
		for (const tag of entry.tags ?? []) {
			byTag[tag] = (byTag[tag] ?? 0) + 1;
		}
	}

	return {
		totalTools: tools.length,
		byPermissionLevel,
		byTag,
	};
}

// ─── ToolRegistry Class ─────────────────────────────────────────────────────────

export class ToolRegistry {
	private readonly tools = new Map<string, NovaToolDefinition>();

	register(tool: NovaToolDefinition, tags: readonly string[] = []): void {
		registerTool(tool, tags);
		this.tools.set(tool.id, tool);
	}

	unregister(toolId: string): boolean {
		this.tools.delete(toolId);
		return unregisterTool(toolId);
	}

	get(toolId: string): NovaToolDefinition | undefined {
		return this.tools.get(toolId) ?? getTool(toolId);
	}

	list(criteria: ToolFilterCriteria = {}): readonly NovaToolDefinition[] {
		return listTools(criteria);
	}

	stats(): RegistryStats {
		return getRegistryStats();
	}
}
