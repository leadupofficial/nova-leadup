/**
 * @nova/tools/builtin/calculator — Safe math evaluation tool.
 *
 * Evaluates mathematical expressions with strict operator whitelisting.
 * Uses Function constructor with restricted scope to prevent code injection.
 */

import type { NovaToolDefinition, ToolExecutionContext, ToolResult } from '../types.js';
import { z } from 'zod';

// ─── Zod Schema ────────────────────────────────────────────────────────────────

export const CalculatorInputSchema = z.object({
	expression: z.string().min(1).max(500),
	precision: z.number().int().min(0).max(15).default(10),
});

export type CalculatorInput = z.infer<typeof CalculatorInputSchema>;

// ─── Tool Definition ───────────────────────────────────────────────────────────

export const CALCULATOR_TOOL: NovaToolDefinition = {
	id: 'calculator',
	name: 'calculator',
	description: 'Evaluate a mathematical expression safely. Supports +, -, *, /, ^, %, sqrt, min, max, round, floor, ceil, abs, log, sin, cos, tan, pi, e.',
	version: '1.0.0',
	permissionLevel: 0, // Pure computation, no side effects
	confirmationRequired: false,
	idempotencyRequired: true,
	inputSchema: {
		type: 'object',
		properties: {
			expression: { type: 'string', description: 'Mathematical expression to evaluate (max 500 chars)' },
			precision: { type: 'number', description: 'Decimal places for result (0-15, default 10)' },
		},
		required: ['expression'],
	},
	execute: async (input): Promise<ToolResult> => {
		const parsed = CalculatorInputSchema.safeParse(input);
		if (!parsed.success) {
			return {
				success: false,
				error: `Invalid input: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
				errorCode: 'VALIDATION_ERROR',
			};
		}

		const { expression, precision } = parsed.data;

		try {
			const result = evaluateExpression(expression, precision);
			return {
				success: true,
				data: { expression, result, precision },
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Calculation failed',
				errorCode: 'EVALUATION_ERROR',
			};
		}
	},
};

// ─── Evaluation Engine ─────────────────────────────────────────────────────────

const ALLOWED_FUNCTIONS: Record<string, (...args: number[]) => number> = {
	sqrt: (x) => Math.sqrt(x),
	abs: (x) => Math.abs(x),
	round: (x) => Math.round(x),
	floor: (x) => Math.floor(x),
	ceil: (x) => Math.ceil(x),
	log: (x) => Math.log(x),
	log10: (x) => Math.log10(x),
	sin: (x) => Math.sin(x),
	cos: (x) => Math.cos(x),
	tan: (x) => Math.tan(x),
	min: (...args) => Math.min(...args),
	max: (...args) => Math.max(...args),
	pow: (a, b) => Math.pow(a, b),
};

const ALLOWED_CONSTANTS: Record<string, number> = {
	pi: Math.PI,
	PI: Math.PI,
	e: Math.E,
	E: Math.E,
};

/**
 * Safely evaluate a mathematical expression.
 *
 * Security: Only numbers, operators (+, -, *, /, %, ^), parentheses,
 * and whitelisted function names are allowed. No variable access,
 * no property access, no method calls.
 */
function evaluateExpression(expression: string, precision: number): number {
	// Tokenize and validate the expression before evaluation
	const sanitized = expression.replace(/\s+/g, '');

	// Validate: only allowed characters
	if (!/^[0-9+\-*/().%^,\s]+$/.test(sanitized.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, ''))) {
		throw new Error('Expression contains disallowed characters');
	}

	// Build allowed names set
	const allowedNames = new Set([...Object.keys(ALLOWED_FUNCTIONS), ...Object.keys(ALLOWED_CONSTANTS)]);

	// Replace constants with their values
	let processed = sanitized;
	for (const [name, value] of Object.entries(ALLOWED_CONSTANTS)) {
		const regex = new RegExp(`\\b${name}\\b`, 'g');
		processed = processed.replace(regex, String(value));
	}

	// Replace ^ with ** for exponentiation
	processed = processed.replace(/\^/g, '**');

	// Validate all identifiers are whitelisted
	const identifierRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
	let match;
	const usedNames = new Set<string>();
	while ((match = identifierRegex.exec(processed)) !== null) {
		usedNames.add(match[1]!);
	}
	const disallowed = [...usedNames].filter((n) => !allowedNames.has(n));
	if (disallowed.length > 0) {
		throw new Error(`Disallowed function/constant: ${disallowed.join(', ')}`);
	}

	// Create a sandboxed function with only allowed functions
	const functionBody = `
		"use strict";
		const { ${Object.keys(ALLOWED_FUNCTIONS).join(', ')} } = allowed;
		return (${processed});
	`;

	const fn = new Function('allowed', functionBody);
	const result = fn(ALLOWED_FUNCTIONS);

	if (typeof result !== 'number' || !Number.isFinite(result)) {
		throw new Error('Expression did not evaluate to a finite number');
	}

	return Number(result.toFixed(precision));
}
