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
