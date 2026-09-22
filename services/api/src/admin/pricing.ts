/**
 * NOVA — Model price table for cost estimation.
 *
 * These are **published list prices**, per million tokens, in USD. They are an
 * estimate to help an operator spot an abnormal spend trend, not a billed figure:
 * no provider invoice is read by this system, negotiated rates are not modelled, and
 * cached-token discounts are ignored.
 *
 * The important behaviour is the **unknown model**: `estimateCost` returns
 * `pricingKnown: false` and a zero cost rather than applying a guessed rate. A
 * model that is not in this table is a real gap — `glm-5.3` appears in this
 * environment's data and is one — and the console renders those rows as
 * "cost not estimated" so the total is never mistaken for complete.
 *
 * Update by adding an entry; the table is matched by substring, longest key first, so
 * `claude-3-5-sonnet` matches before `claude-3-5`.
 */

export type ModelPrice = {
	/** USD per million input tokens. */
	inputPerMillion: number;
	/** USD per million output tokens. */
	outputPerMillion: number;
	label: string;
};

export const AI_PRICING: Record<string, ModelPrice> = {
	// Anthropic
	'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15, label: 'Anthropic Claude Sonnet 4' },
	'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15, label: 'Anthropic Claude 3.5 Sonnet' },
	'claude-3-7-sonnet': { inputPerMillion: 3, outputPerMillion: 15, label: 'Anthropic Claude 3.7 Sonnet' },
	'claude-opus-4': { inputPerMillion: 15, outputPerMillion: 75, label: 'Anthropic Claude Opus 4' },
	'claude-3-opus': { inputPerMillion: 15, outputPerMillion: 75, label: 'Anthropic Claude 3 Opus' },
	'claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4, label: 'Anthropic Claude 3.5 Haiku' },
	'claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25, label: 'Anthropic Claude 3 Haiku' },

	// OpenAI
	'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6, label: 'OpenAI GPT-4o mini' },
	'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10, label: 'OpenAI GPT-4o' },
	'gpt-4-turbo': { inputPerMillion: 10, outputPerMillion: 30, label: 'OpenAI GPT-4 Turbo' },
	'o1-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, label: 'OpenAI o1-mini' },
	'o1': { inputPerMillion: 15, outputPerMillion: 60, label: 'OpenAI o1' },

	// Google
	'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3, label: 'Google Gemini 1.5 Flash' },
	'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5, label: 'Google Gemini 1.5 Pro' },
	'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4, label: 'Google Gemini 2.0 Flash' },

	// DeepSeek
	'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1, label: 'DeepSeek Chat' },
	'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19, label: 'DeepSeek Reasoner' },
};

/** Longest matching key, so a specific model id wins over a family prefix. */
function priceFor(model: string | null | undefined): ModelPrice | null {
	if (!model) return null;
	const lower = model.toLowerCase();

	const matches = Object.keys(AI_PRICING)
		.filter((key) => lower.includes(key))
		.sort((a, b) => b.length - a.length);

	return matches.length > 0 ? AI_PRICING[matches[0]] : null;
}

export type CostEstimate = {
	costUsd: number;
	pricingKnown: boolean;
	/** The rate applied, for the console to show its working. */
	rate: ModelPrice | null;
};

/**
 * Estimates the cost of a token count.
 *
 * When `model` is null the blended default rate is used — used for day-level
 * series where the per-model split is not available — and `pricingKnown` is true
 * because the blended rate is a stated assumption rather than a missing one.
 */
export function estimateCost(
	model: string | null,
	inputTokens: number,
	outputTokens: number,
): CostEstimate {
	const price = priceFor(model);

	if (!price) {
		if (model === null) {
			// Blended fallback: Sonnet-class input, Haiku-class output is not
			// meaningful, so use a single representative mid rate.
			const blended: ModelPrice = { inputPerMillion: 3, outputPerMillion: 15, label: 'blended default' };
			const cost = (inputTokens / 1_000_000) * blended.inputPerMillion
				+ (outputTokens / 1_000_000) * blended.outputPerMillion;
			return { costUsd: round6(cost), pricingKnown: true, rate: blended };
		}
		return { costUsd: 0, pricingKnown: false, rate: null };
	}

	const cost = (inputTokens / 1_000_000) * price.inputPerMillion
		+ (outputTokens / 1_000_000) * price.outputPerMillion;

	return { costUsd: round6(cost), pricingKnown: true, rate: price };
}

function round6(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

/** True when at least one model in the list has no known price. */
export function hasUnknownPricing(models: Array<string | null>): boolean {
	return models.some((model) => model !== null && priceFor(model) === null);
}
