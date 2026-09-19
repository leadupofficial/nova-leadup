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
