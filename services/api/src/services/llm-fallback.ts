/**
 * NOVA API — the secondary LLM provider: its configuration, and the rules for
 * when it may be used.
 *
 * NOVA had no fallback anywhere on the chat-model path. The configured relay
 * (`ANTHROPIC_BASE_URL`) answered `402 {"error":{"message":"Insufficient
 * Balance","type":"billing_error"}}` for every request for hours, and every
 * assistant turn failed. `withCircuitBreaker` in `./ai.js` cannot help: it only
 * accepts `'elevenlabs' | 'google'`, so it covers TTS and Google STT and never
 * the model.
 *
 * This module owns the two decisions a fallback needs, in one place so the REST
 * path (`services/ai.ts#chatCompletion`) and the streaming voice path
 * (`realtime/llm.ts#streamChatCompletion`) cannot drift apart:
 *
 *   1. configuration — `LLM_FALLBACK_*`, absent meaning "no fallback configured";
 *   2. policy — which failures mean "the provider is unusable"
 *      (`isProviderUnusableFailure`) and, critically, when a retry is safe
 *      (`shouldUseFallback`).
 *
 * `withProviderFallback` is then the single retry engine both entry points
 * call. The wire calls themselves live in `./llm-transport.js`; the *primary*
 * call is deliberately implemented by each entry point, because the REST path
 * goes through the Anthropic SDK and the voice path through raw SSE and
 * wrapping either in a third implementation is the drift this module exists to
 * prevent.
 *
 * Nothing here imports `./ai.js` at runtime (types only), so `./ai.js` can
 * import this module without a cycle.
 */
import { logger } from '../utils/logger.js';
import { isCreditExhausted } from './assistant.js';

/** How much of a provider's own error body may reach a message or a log line. */
export const PROVIDER_DETAIL_LIMIT = 300;

/** True when a rejection is a cancellation rather than a provider fault. */
export function isAbortError(err: unknown): boolean {
	return (
		!!err &&
		typeof err === 'object' &&
		((err as { name?: string }).name === 'AbortError' ||
			(err as { code?: string }).code === 'ABORT_ERR')
	);
}

// ─── Provider notices ───────────────────────────────────────────────

/**
 * True when a nominally-successful completion actually carries a provider
 * credential, quota or billing notice rather than an answer.
 *
 * Only consulted when the response reported zero output tokens, so a genuine
 * reply that happens to discuss API keys is never suppressed. It lives here
 * rather than in `./ai.js` because the fallback transport needs the same guard
 * and this module must not import `./ai.js` at runtime; `./ai.js` re-exports it
 * so its public surface is unchanged.
 */
export function looksLikeProviderNotice(content: string): boolean {
	if (!content) return false;
	return /api[\s_-]?key|quota|credit|billing|rate limit|expired|unauthori[sz]ed|invalid.*(token|key)|contact your administrator/i.test(
		content,
	);
}

// ─── Configuration ──────────────────────────────────────────────────

/** Wire protocol of a provider endpoint. */
export type LlmProtocol = 'openai' | 'anthropic';

/** How the credential is carried. */
export type LlmAuthStyle = 'bearer' | 'api-key';

/**
 * The label every log line and every result uses for the secondary provider.
 *
 * Deliberately a constant, not the base URL and not the key: a provider
 * identity in a log is useful, a credential is not, and the URL is not needed
 * to spot an outage.
 */
export const FALLBACK_PROVIDER_LABEL = 'llm-fallback';

export interface LlmEndpoint {
	/** Identity for logs and responses. Never a URL and never a credential. */
	label: string;
	baseURL: string;
	apiKey: string;
	authStyle: LlmAuthStyle;
	protocol: LlmProtocol;
}

/** A configured secondary provider, ready to call. */
export interface LlmFallbackConfig extends LlmEndpoint {
	model: string;
}

/**
 * Reads the secondary provider's configuration, or returns `null` when none is
 * configured — which is the documented meaning of "absent means no fallback".
 *
 * Read straight from `process.env` rather than through the cached `env` proxy,
 * exactly like `getAnthropicHttpConfig()`, so an operator (or a test) can point
 * the fallback at a different endpoint and see the effect on the next call
 * without a restart. `utils/env.ts` validates the same names at boot.
 *
 * Defaulting rules, chosen so an operator only has to set the two things that
 * are genuinely theirs (the URL and the key):
 *
 *  - `LLM_FALLBACK_PROTOCOL` — `openai` or `anthropic`. When unset it is
 *    inferred from the auth style: `api-key` means Anthropic's own protocol,
 *    anything else means OpenAI-compatible. That is the right default because
 *    the likely providers (apimaster.ai, Z.ai/GLM, Moonshot/Kimi, DeepSeek) all
 *    speak `POST {base}/chat/completions` with a bearer token, while a key in an
 *    `x-api-key` header is Anthropic's convention.
 *  - `LLM_FALLBACK_AUTH_STYLE` — `bearer` or `api-key`. When unset it follows
 *    the protocol: `bearer` for OpenAI-compatible, `api-key` for Anthropic.
 *  - `LLM_FALLBACK_MODEL` — when unset, the primary model id. A gateway that
 *    namespaces its model ids should set this explicitly.
 *
 * The fallback counts as configured only when **both** the base URL and the API
 * key are non-empty, so a half-filled block never turns one provider failure
 * into two.
 */
export function getLlmFallbackConfig(defaultModel: string): LlmFallbackConfig | null {
	const baseURL = (process.env.LLM_FALLBACK_BASE_URL || '').trim();
	const apiKey = (process.env.LLM_FALLBACK_API_KEY || '').trim();
	if (!baseURL || !apiKey) return null;

	const rawAuth = (process.env.LLM_FALLBACK_AUTH_STYLE || '').trim().toLowerCase();
	const rawProtocol = (process.env.LLM_FALLBACK_PROTOCOL || '').trim().toLowerCase();

	const protocol: LlmProtocol =
		rawProtocol === 'anthropic' || rawProtocol === 'openai'
			? rawProtocol
			: rawAuth === 'api-key'
				? 'anthropic'
				: 'openai';

	const authStyle: LlmAuthStyle =
		rawAuth === 'bearer' || rawAuth === 'api-key'
			? rawAuth
			: protocol === 'openai'
				? 'bearer'
				: 'api-key';

	return {
		label: FALLBACK_PROVIDER_LABEL,
		baseURL,
		apiKey,
		authStyle,
		protocol,
		model: (process.env.LLM_FALLBACK_MODEL || '').trim() || defaultModel,
	};
}

// ─── Secrets ────────────────────────────────────────────────────────

/**
 * Removes any configured credential from free text before it is logged or put
 * into an error message.
 *
 * A provider that echoes the submitted credential in its error body would
 * otherwise write it into the log store and into whatever error object travels
 * back up the stack. This is applied at the one place a provider's own bytes
 * are admitted to this service, so no later code has to remember to do it.
 */
export function redactSecret(text: string, ...secrets: Array<string | undefined>): string {
	let out = text;
	for (const secret of secrets) {
		if (!secret || secret.length < 8) continue;
		out = out.split(secret).join('[redacted]');
	}
	return out;
}

// ─── Failure classification ─────────────────────────────────────────

/** The upstream HTTP status an error carries, when it carries one. */
export function providerFailureStatus(err: unknown): number | null {
	const candidate = (err as { status?: unknown; statusCode?: unknown }) ?? {};
	const value = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
	return typeof value === 'number' ? value : null;
}

/** Node/undici error codes that mean the request never got an answer. */
const TRANSPORT_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ENOTFOUND',
	'EAI_AGAIN',
	'ETIMEDOUT',
	'EPIPE',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
]);

/**
 * True when the failure means no usable HTTP response ever arrived: a timeout, a
 * refused/reset connection, or a DNS failure. These are transport faults rather
 * than the request being wrong, so a different provider is worth trying.
 */
function isTransportFailure(err: unknown, raw: string): boolean {
	if (isAbortError(err)) return true;
	const code = (err as { code?: unknown })?.code;
	if (typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code)) return true;
	return /fetch failed|socket hang up|network|timed?\s?out|timeout|connection (refused|reset|closed)|getaddrinfo|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(
		raw,
	);
}

/**
 * Whether a failure means the *provider* is unusable, rather than the request
 * being wrong or this service having a bug.
 *
 * **Classified by origin first, status second.** A provider's own request path
 * can raise any status, and a `404` from a relay whose route has gone away
 * (`404 404 page not found`) means exactly what a `5xx` means — the provider is
 * down — even though the same number raised by *our* handlers means "no such
 * row or route". The two are told apart by the wrapper and not by the number:
 * everything the wire transports raise is a `ProviderRequestError`, and that is
 * where this list starts. A bare `{ status: 404 }` with no provider provenance
 * is this service's own error and stays non-retryable.
 *
 * The rules, in order:
 *
 *  1. the credit/billing condition, detected with the shared
 *     `isCreditExhausted(status, raw)` so this and `toAssistantError` agree;
 *  2. **provider-originated `4xx`** — the provider was reached and refused. A
 *     `401`/`403` is excluded: that is a credential or configuration problem for
 *     *that* provider, and the operator has to see it rather than have it masked
 *     by a silent switch. `400` is excluded too: a body this service built and
 *     the provider rejected is our bug, and retrying it would fail identically
 *     against a second provider and hide the defect;
 *  3. the provider's own `5xx`;
 *  4. a stream the provider accepted and then aborted with an `error` event.
 *     That is the provider's fault, not the request's. Whether it may be retried
 *     is still decided by the caller's `retrySafe` answer, which is false once a
 *     delta has been spoken;
 *  5. nothing answered at all: timeout, refused/reset connection, DNS failure;
 *  6. anything else — including everything this service raised itself.
 */
export function isProviderUnusableFailure(err: unknown): boolean {
	const raw = err instanceof Error ? err.message : String(err);
	const status = providerFailureStatus(err);

	// 1. The account cannot pay for the next call. Recognised from the status
	//    *or* the wording, because a gateway may answer 200 with the notice as
	//    ordinary content and no usage.
	if (isCreditExhausted(status, raw)) return true;

	// Everything below this line needs provenance: only an error the provider's
	// own request path produced may switch provider.
	if (err instanceof ProviderRequestError) {
		// 2. The provider was reached and refused the request.
		if (err.kind === 'http' && status !== null && status >= 400 && status < 500) {
			return status !== 400 && status !== 401 && status !== 403;
		}
		// 4. The provider started a stream and then aborted it.
		if (err.kind === 'stream') return true;
		// A `200` that carried a credential/quota notice instead of an answer:
		// the provider is reachable but unusable for this account.
		if (err.kind === 'notice') return true;
	}

	// 3. The provider answered, and said it is broken.
	if (status !== null && status >= 500) return true;

	// 5. Nothing was answered: timeout, refused/reset connection, DNS failure.
	if (status === null && isTransportFailure(err, raw)) return true;

	// 6. Anything else — including everything this service raised itself.
	return false;
}

/**
 * THE RETRY-SAFETY RULE.
 *
 * A provider call may only be retried while the turn has committed nothing that
 * a second attempt could duplicate or repeat out loud. `retrySafe` is the
 * caller's answer to "has this turn emitted output or executed a tool?", and it
 * is a *function of the moment the failure happens*, not of the request.
 *
 * The distinction the callers must make, in both entry points:
 *
 *  - **Before** the turn has emitted text or run a tool, a failure is safe to
 *    retry. That covers the initial model call, and every call in
 *    `runAssistantToolLoop` up to — but not including — the first tool
 *    execution.
 *  - **After** a tool has executed, or after a token has been handed to the
 *    socket/TTS, the failure is NOT retried. `runAssistantToolLoop` creates
 *    reminders, tasks and memories as it goes, so re-running a turn whose tool
 *    has already fired would create the reminder twice; and streamed audio
 *    cannot be unsaid, so a retry would make the user hear half a sentence
 *    twice.
 *
 * Note the retry unit: the fallback replays *one provider request* with the
 * conversation exactly as the caller passed it (including any `tool_result`
 * blocks already sent back), never the user's original turn. A mid-loop retry
 * would therefore not itself re-execute a tool — but the policy stays at "no
 * committed side effect" anyway, so that no future change to how a turn is
 * replayed can silently turn a fallback into a duplicate.
 *
 * This rule governs *retrying a failed call*. It is deliberately separate from
 * sticky selection ([ProviderFallbackAttempt.preferFallback]), which governs
 * *which provider the turn's next call goes to*: a turn that has already fallen
 * back sends its later iterations to the fallback without probing the primary
 * again, which is not a retry. Keeping them apart is what lets a tool-using turn
 * finish after its first call fell back without ever re-issuing a failed call.
 * What remains un-covered is the reverse case: a turn the **primary itself**
 * serves and then loses mid-loop, after a tool has run. That turn still fails —
 * the guard must refuse — and with sticky selection in place it is the only
 * shape that can.
 */
export function shouldUseFallback(err: unknown, retrySafe: boolean): boolean {
	if (!retrySafe) return false;
	return isProviderUnusableFailure(err);
}

// ─── Errors ─────────────────────────────────────────────────────────

/** How a provider call failed. Kept as data so callers can map it stably. */
export type ProviderFailureKind =
	/** A non-2xx response. */
	| 'http'
	/** A `200` that carried a credential/quota notice instead of an answer. */
	| 'notice'
	/** An `error` event on the stream. */
	| 'stream';

/**
 * A provider's own failure, carrying the upstream status as data.
 *
 * The message is redacted of every configured credential at construction, so an
 * error body can never carry a key into a log line or an API response — which
 * matters because several gateways echo the submitted credential back. It
 * exposes `status`, so the existing `isCreditExhausted` / `toAssistantError`
 * classifiers read a fallback failure exactly like a primary one.
 */
export class ProviderRequestError extends Error {
	readonly status: number | null;
	readonly kind: ProviderFailureKind;
	readonly provider: string;

	constructor(
		provider: string,
		kind: ProviderFailureKind,
		status: number | null,
		detail: string,
		secrets: Array<string | undefined> = [],
	) {
		super(redactSecret(detail.slice(0, PROVIDER_DETAIL_LIMIT), ...secrets));
		this.name = 'ProviderRequestError';
		this.provider = provider;
		this.kind = kind;
		this.status = status;
	}
}

// ─── The retry engine ───────────────────────────────────────────────

export interface ProviderFallbackAttempt<T> {
	/** Identity of the provider that answers when all is well. */
	primaryProvider: string;
	primaryModel: string;
	primary: () => Promise<T>;
	/**
	 * Whether a retry is safe *right now* — see `shouldUseFallback`. A function,
	 * not a value, because the answer changes as a turn emits and executes.
	 */
	isRetrySafe: () => boolean;
	/**
	 * Skip the primary and go straight to the configured fallback.
	 *
	 * This is **sticky provider selection for one assistant turn**. The fallback
	 * is chosen per *turn*: the moment a turn has fallen back, every later model
	 * call of that same turn must use the fallback instead of re-probing a
	 * provider already known to be unusable.
	 *
	 * Not probing again is not a retry — nothing is retried, the request is
	 * simply sent to the provider the turn has already chosen — so this is
	 * deliberately independent of [isRetrySafe], which governs *retrying the
	 * primary*. That separation is what lets a tool-using turn finish after its
	 * first call fell back without ever violating the no-duplicate-side-effect
	 * rule: at no point is a failed call re-issued.
	 *
	 * It is per-call state owned by the caller's loop, never module state: one
	 * turn falling back must not pin another user, or a later turn, to the
	 * fallback. A provider that recovers is used again on the next turn.
	 *
	 * When no fallback is configured this is inert — the primary runs, exactly
	 * as it would have.
	 */
	preferFallback?: boolean;
	/** The configured secondary provider, or `null` when none is configured. */
	fallback: {
		provider: string;
		model: string;
		protocol: LlmProtocol;
		call: () => Promise<T>;
	} | null;
	/** Credentials to scrub from any logged failure detail. */
	secrets?: Array<string | undefined>;
}

export interface ServedResult<T> {
	result: T;
	/** Which provider actually served the request. */
	provider: string;
	model: string;
	fellBack: boolean;
}

/**
 * The single retry engine both LLM entry points use.
 *
 * Runs the primary; if it fails in a way that means the provider is unusable
 * *and* the caller says a retry is safe, runs the same request against the
 * configured fallback instead. The fallback's own failure propagates — a
 * fallback that is also down must not be reported as the primary's failure.
 *
 * When the caller has already chosen the fallback for this turn
 * (`preferFallback`), the primary is not contacted at all: the engine goes
 * straight to the fallback and reports `fellBack: true`, so logs and clients see
 * the same provider identity they saw on the turn's first call. Nothing is
 * retried there — the request is the turn's *next* call — which is what keeps
 * this compatible with "never retry after a tool has executed".
 *
 * When no fallback is configured, the primary's error is rethrown untouched: an
 * unconfigured fallback must degrade to exactly today's behaviour, not to a new
 * crash.
 */
export async function withProviderFallback<T>(
	attempt: ProviderFallbackAttempt<T>,
): Promise<ServedResult<T>> {
	// Sticky selection: the turn already knows the primary is unusable.
	if (attempt.preferFallback && attempt.fallback) {
		logger.info(
			{
				provider: attempt.fallback.provider,
				protocol: attempt.fallback.protocol,
				model: attempt.fallback.model,
				primary: attempt.primaryProvider,
				fellBack: true,
				sticky: true,
			},
			'LLM request served by the fallback provider chosen earlier in this turn',
		);
		const stickyResult = await attempt.fallback.call();
		return {
			result: stickyResult,
			provider: attempt.fallback.provider,
			model: attempt.fallback.model,
			fellBack: true,
		};
	}

	try {
		const result = await attempt.primary();
		logger.info(
			{ provider: attempt.primaryProvider, model: attempt.primaryModel, fellBack: false },
			'LLM request served by the primary provider',
		);
		return { result, provider: attempt.primaryProvider, model: attempt.primaryModel, fellBack: false };
	} catch (err) {
		if (!attempt.fallback || !shouldUseFallback(err, attempt.isRetrySafe())) throw err;

		logger.warn(
			{
				provider: attempt.fallback.provider,
				protocol: attempt.fallback.protocol,
				model: attempt.fallback.model,
				primary: attempt.primaryProvider,
				primaryStatus: providerFailureStatus(err),
				// The provider's own wording, scrubbed of every configured credential.
				detail: redactSecret(
					err instanceof Error ? err.message : String(err),
					...(attempt.secrets ?? []),
				).slice(0, PROVIDER_DETAIL_LIMIT),
				fellBack: true,
			},
			'Primary LLM provider unusable — retrying on the configured fallback provider',
		);

		const result = await attempt.fallback.call();
		logger.info(
			{ provider: attempt.fallback.provider, model: attempt.fallback.model, fellBack: true },
			'LLM request served by the fallback provider',
		);
		return { result, provider: attempt.fallback.provider, model: attempt.fallback.model, fellBack: true };
	}
}
