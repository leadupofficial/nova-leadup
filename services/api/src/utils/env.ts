import { z } from 'zod';

/**
 * A voice-cost unit rate: an optional decimal string in USD.
 *
 * There is deliberately no numeric default. A price is a contract term this
 * service does not know, so an unset rate must surface as "unknown cost" for
 * that leg rather than as a made-up number — and never as 0, because a
 * silently-zero leg makes the whole turn look cheap. Empty/whitespace and
 * non-numeric values are treated as unset for the same reason.
 */
const optionalRate = (what: string) =>
 z
  .string()
  .optional()
  .describe(
   `${what}. Contracted rate in USD. Unset = that leg's cost is logged as unknown (null), not 0. Placeholder example only, not a price: 0.01`,
  );

/**
 * A permission level in the 0–3 scale defined by blueprint §10.1.
 *
 * Declared as a plain literal union rather than imported from
 * `services/assistant-tools.ts`: `env.ts` validates process configuration and
 * must not pull the tool layer (and, through it, the database) into every
 * module that only wants `env`. The tool registry asserts the two stay in step
 * at compile time.
 */
type PermissionLevelValue = 0 | 1 | 2 | 3;

/**
 * The confirmation threshold: every tool at or above this level must be
 * confirmed by the user before it runs.
 *
 * Defaults to 1 — §10.1 requires L1 to be "configurable; confirm during beta",
 * so this service ships in the confirm-everything-that-writes state. A bare
 * number (`2`) and the level tags the blueprint uses (`L2`, `l2`, `L1`) are
 * both accepted, because an operator will write either. Anything else is
 * rejected loudly at boot: a typo that silently fell back to the default would
 * weaken the gate without anyone noticing.
 */
const confirmationLevel = z
  .string()
  .default('1')
  .transform((raw, ctx): PermissionLevelValue => {
    const match = /^(?:l)?([0-3])$/i.exec(raw.trim());
    if (!match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a permission level between 0 and 3 (e.g. 1, L1, 2)',
      });
      return z.NEVER;
    }
    return Number(match[1]) as PermissionLevelValue;
  })
  .describe(
    'Minimum tool permission level that requires user confirmation on the realtime voice path. 0 = never prompt, 1 = confirm every write (blueprint §10.1 beta default), 3 = confirm only the most sensitive. Blueprint levels are accepted too (L1, L2).',
  );

/**
 * A value where an empty string means "unset".
 *
 * `dotenv` turns `KEY=` into `''`, and `z.string().optional()` does not accept
 * it — so a placeholder line copied from `.env.example` would make boot fail on
 * a value that means exactly the same thing as absence. Treating a blank value
 * as absent keeps "leave it empty to disable this" honest.
 */
const blankIsUnset = (value: unknown): unknown =>
 typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * The secondary LLM provider, used automatically when the primary is unusable —
 * out of credit, `5xx`, timed out or unreachable — and only while the turn has
 * committed no side effect or spoken output. A request error (`400`), an auth
 * failure from this service's own middleware, and any error this service raised
 * itself are never retried. See `services/llm-fallback.ts`.
 *
 * Every name is optional, and the fallback counts as configured only when
 * **both** `LLM_FALLBACK_BASE_URL` and `LLM_FALLBACK_API_KEY` are set. Absence
 * means "no fallback configured", which is exactly the behaviour that existed
 * before one did. Read at call time in `services/llm-fallback.ts`, so a change
 * takes effect without a restart.
 */
const llmFallbackBaseUrl = z
 .preprocess(blankIsUnset, z.string().url().optional())
 .describe(
  'Base URL of the secondary LLM provider. Unset or blank disables the fallback entirely. OpenAI-compatible providers take {base}/chat/completions; Anthropic-protocol ones take {base}/v1/messages.',
 );

const llmFallbackApiKey = z
 .preprocess(blankIsUnset, z.string().optional())
 .describe(
  'Credential for the secondary LLM provider. Unset or blank disables the fallback entirely. Never logged, and redacted out of any provider error body before that body is stored or returned.',
 );

const llmFallbackAuthStyle = z
 .preprocess(blankIsUnset, z.enum(['bearer', 'api-key']).optional())
 .describe(
  'How the fallback credential is sent: bearer = Authorization: Bearer <key>; api-key = x-api-key: <key>. Defaults to bearer for the OpenAI-compatible protocol and api-key for the Anthropic one.',
 );

const llmFallbackProtocol = z
 .preprocess(blankIsUnset, z.enum(['openai', 'anthropic']).optional())
 .describe(
  'Wire protocol of the secondary provider: openai = POST {base}/chat/completions; anthropic = POST {base}/v1/messages. Defaults from the auth style: api-key implies anthropic, anything else implies openai (the likely fallbacks — apimaster.ai, Z.ai/GLM, Moonshot/Kimi, DeepSeek — are OpenAI-compatible).',
 );

/**
 * The output-token ceiling every chat call sends, when a call site does not name
 * its own.
 *
 * 4096 rather than the 1024 the voice and chat routes used to hard-code, because
 * the configured fallback is a **reasoning** model: `reasoning_content` is billed
 * against `max_tokens`, so 1024 bought ~1023 reasoning tokens and no answer at
 * all. On the measured turn the model spent 1023 of 1024 tokens thinking,
 * `finish_reason` came back `length`, `content` was empty, and the route replied
 * HTTP 200 with `text: ""`. A working turn of the same prompt used 842 output
 * tokens (506 of them reasoning), so 4096 leaves roughly four times the headroom
 * while staying the module's documented default.
 *
 * Bounded deliberately. `max_tokens` is a ceiling and not a charge, but an
 * unbounded one lets a runaway or looping model generate without limit, so a
 * misconfigured value is rejected at boot rather than quietly accepted. The
 * ceiling is the cap on one reply, not on one turn: a tool-using turn can make
 * up to `MAX_TOOL_ITERATIONS` such calls. Lower it if a provider bills more than
 * the turn is worth; raise it if a longer reasoning budget is genuinely needed.
 */
const llmMaxOutputTokens = z
 .preprocess(
  blankIsUnset,
  z.coerce
   .number()
   .int('LLM_MAX_OUTPUT_TOKENS must be a whole number of tokens')
   .min(256, 'LLM_MAX_OUTPUT_TOKENS must be at least 256; a reasoning model needs room to think and answer')
   .max(32768, 'LLM_MAX_OUTPUT_TOKENS must be at most 32768 — a larger per-reply ceiling is a runaway-cost risk')
   .default(4096),
 )
 .describe(
  'Maximum output tokens per chat completion (reasoning tokens included). Default 4096. Too low for a reasoning model returns an empty reply; too high risks an unbounded-cost reply. Allowed 256–32768.',
 );

const envSchema = z.object({
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 PORT: z.string().default('3001'),
 DATABASE_URL: z.string().url(),
 JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
 REDIS_URL: z.string().url().optional(),
 ANTHROPIC_API_KEY: z.string().optional(),
 ELEVENLABS_API_KEY: z.string().optional(),
 SARVAM_API_KEY: z.string().optional(),
 OPENAI_API_KEY: z.string().optional(),
 DEEPGRAM_API_KEY: z.string().optional(),
 GOOGLE_CLOUD_API_KEY: z.string().optional(),

 // Secondary LLM provider — see the block above for the semantics of each name.
 LLM_FALLBACK_BASE_URL: llmFallbackBaseUrl,
 LLM_FALLBACK_API_KEY: llmFallbackApiKey,
 LLM_FALLBACK_MODEL: z
  .preprocess(blankIsUnset, z.string().optional())
  .describe(
   'Model id to ask the secondary provider for. Unset = the primary model id (ANTHROPIC_MODEL). A gateway that namespaces its model ids (for example deepseek-chat) should set this explicitly.',
  ),
 LLM_FALLBACK_AUTH_STYLE: llmFallbackAuthStyle,
 LLM_FALLBACK_PROTOCOL: llmFallbackProtocol,

 // One shared ceiling for every chat/reply call site — see the block above.
 LLM_MAX_OUTPUT_TOKENS: llmMaxOutputTokens,

 LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
 CORS_ORIGIN: z.string().default('http://localhost:19000'),

 // ── Tool approval (blueprint §5.7 / §10.1) ───────────────────────────
 // Every side-effecting voice tool at or above this level is confirmed by the
 // user before it executes. L1 by default: the blueprint says L1 is
 // configurable and must be confirmed during beta, which is also the setting
 // that closes the hole where `create_reminder`, `create_task` and
 // `save_memory` ran on a spoken command with no prompt at all. L0 never
 // prompts, at any setting.
 VOICE_TOOL_CONFIRM_LEVEL: confirmationLevel,

 // ── Per-turn voice cost rates (logging only) ─────────────────────────
 // All optional and in USD. The defaults are intentionally "unset": set your
 // contracted rates to populate the `Realtime voice turn cost` log line.
 // Per-provider keys take precedence over the generic ones because the
 // pipeline can fall back to a different provider, which bills differently
 // (STT: Sarvam or Deepgram; TTS: Sarvam, ElevenLabs or Deepgram).
 VOICE_COST_STT_PER_MINUTE: optionalRate('STT, any provider, per minute of audio'),
 VOICE_COST_STT_SARVAM_PER_MINUTE: optionalRate('STT via Sarvam, per minute of audio'),
 VOICE_COST_STT_DEEPGRAM_PER_MINUTE: optionalRate('STT via Deepgram, per minute of audio'),
 VOICE_COST_LLM_INPUT_PER_MTOK: optionalRate('LLM input tokens, per million tokens'),
 VOICE_COST_LLM_OUTPUT_PER_MTOK: optionalRate('LLM output tokens, per million tokens'),
 VOICE_COST_TTS_PER_1K_CHARS: optionalRate('TTS, any provider, per 1,000 characters'),
 VOICE_COST_TTS_SARVAM_PER_1K_CHARS: optionalRate('TTS via Sarvam, per 1,000 characters'),
 VOICE_COST_TTS_ELEVENLABS_PER_1K_CHARS: optionalRate('TTS via ElevenLabs, per 1,000 characters'),
 VOICE_COST_TTS_DEEPGRAM_PER_1K_CHARS: optionalRate('TTS via Deepgram, per 1,000 characters'),
});

export type Env = z.infer<typeof envSchema>;

let _cached: Env | undefined;

export function validateEnv(envInput?: Record<string, string | undefined>): Env {
 const target = envInput || process.env;
 _cached = envSchema.parse(target);
 return _cached;
}

/**
 * Lazy env proxy. Reads through to process.env and validates on first access.
 * Use `env.X` and the validation runs once.
 */
export const env = new Proxy({} as Env, {
 get(_target, prop: string) {
 if (!_cached) {
 _cached = envSchema.parse(process.env);
 }
 return _cached![prop as keyof Env];
 },
});
