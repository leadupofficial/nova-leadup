/**
 * @nova/tools/builtin/web-search — Web search tool via Firecrawl.
 *
 * Performs web searches and returns ranked results with summaries.
 * Requires FIRECRAWL_API_KEY environment variable.
 */

import type { NovaToolDefinition, ToolExecutionContext, ToolResult } from '../types.js';
import { z } from 'zod';

// ─── Zod Schema ────────────────────────────────────────────────────────────────

export const WebSearchInputSchema = z.object({
	query: z.string().min(1).max(500),
	maxResults: z.number().int().min(1).max(20).default(5),
	category: z.string().optional(),
	excludeDomains: z.array(z.string()).optional(),
	includeDomains: z.array(z.string()).optional(),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

// ─── Tool Definition ───────────────────────────────────────────────────────────

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v1';

export const WEB_SEARCH_TOOL: NovaToolDefinition = {
	id: 'web_search',
	name: 'web_search',
	description: 'Search the web for information. Returns ranked results with titles, URLs, and summaries.',
	version: '1.0.0',
	permissionLevel: 0, // Read-only
	confirmationRequired: false,
	idempotencyRequired: true,
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Search query (1-500 characters)' },
			maxResults: { type: 'number', description: 'Maximum results to return (1-20, default 5)' },
			category: { type: 'string', description: 'Optional category filter' },
			excludeDomains: { type: 'array', items: { type: 'string' }, description: 'Domains to exclude' },
			includeDomains: { type: 'array', items: { type: 'string' }, description: 'Domains to include' },
		},
		required: ['query'],
	},
	execute: async (input, _context): Promise<ToolResult> => {
		const parsed = WebSearchInputSchema.safeParse(input);
		if (!parsed.success) {
			return {
				success: false,
				error: `Invalid input: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
				errorCode: 'VALIDATION_ERROR',
			};
		}

		const { query, maxResults, category, excludeDomains, includeDomains } = parsed.data;

		if (!FIRECRAWL_API_KEY) {
			return {
				success: false,
				error: 'Web search is not configured (FIRECRAWL_API_KEY missing)',
				errorCode: 'CONFIGURATION_ERROR',
			};
		}

		try {
			const response = await fetch(`${FIRECRAWL_API_URL}/search`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
				},
				body: JSON.stringify({
					query,
					limit: maxResults,
					...(category ? { category } : {}),
					...(excludeDomains?.length ? { excludeDomains } : {}),
					...(includeDomains?.length ? { includeDomains } : {}),
				}),
				signal: AbortSignal.timeout(15_000),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Firecrawl API error ${response.status}: ${body}`);
			}

			const data = (await response.json()) as {
				data: Array<{
					title: string;
					url: string;
					description: string;
					score?: number;
				}>;
			};

			return {
				success: true,
				data: {
					query,
					results: data.data.map((r) => ({
						title: r.title,
						url: r.url,
						description: r.description,
						score: r.score,
					})),
					provider: 'firecrawl',
				},
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Web search failed',
				errorCode: 'API_ERROR',
			};
		}
	},
};

// ─── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Create a web search tool definition with custom configuration.
 */
export function createWebSearchTool(apiKey?: string): NovaToolDefinition {
	const effectiveKey = apiKey ?? FIRECRAWL_API_KEY;
	if (!effectiveKey) {
		console.warn('[web-search] FIRECRAWL_API_KEY not set — tool will return errors at runtime');
	}

	return { ...WEB_SEARCH_TOOL, id: 'web_search' };
}
