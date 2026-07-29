import { z } from 'zod'

/**
 * Environment is split in two so Mastra Studio stays usable before Telegram is
 * wired up. Core config is validated at import time and fails fast; Telegram
 * config is validated only when something actually tries to send a message.
 */

/**
 * Every model must route through the OpenRouter gateway.
 *
 * This guard exists because the mistake is silent and confusing: Mastra's
 * registry lists `deepseek` and `minimax` as *direct* providers too, so a bare
 * `deepseek/deepseek-v4-flash` is perfectly valid — it just bills DeepSeek and
 * demands a `DEEPSEEK_API_KEY`. The failure surfaces at first model call, naming
 * a provider that was never chosen. Catching it at startup is far cheaper.
 */
const gatewayModelId = z
  .string()
  .min(1)
  .refine(id => id.startsWith('openrouter/'), {
    message:
      'must start with "openrouter/" — a bare "<provider>/<model>" routes directly to that ' +
      'provider and needs its own API key (e.g. use openrouter/deepseek/deepseek-v4-flash)',
  })

const coreSchema = z.object({
  /** Single key for every model below — chat routes through the OpenRouter gateway. */
  OPENROUTER_API_KEY: z.string().min(1),
  REPLICATE_API_KEY: z.string().min(1),

  /**
   * Cheap and high-volume: scores + labels every incoming headline. Text only,
   * but must support schema-constrained output — the rank step reads `.object`.
   */
  AVA_MODEL_RSS_RANKER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash'),
  /** Strong: writes the digest for the handful of items that survive ranking. */
  AVA_MODEL_RSS_SUMMARIZER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash'),
  /** Conversational surface in Telegram. Vision-capable: images arrive inline. */
  AVA_MODEL_ORCHESTRATOR: gatewayModelId.default('openrouter/minimax/minimax-m3'),
  /**
   * Weekly memory review: decides which short-term notes become biography.
   * Cheap and schema-constrained like the ranker — it runs once a week over a
   * few dozen one-line rows, and its output is a list of ids, not prose.
   */
  AVA_MODEL_MEMORY_REVIEWER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash'),
  /**
   * `/translearn` and `/translate`: translates an article into the reader's own
   * language, glossed with the English original.
   *
   * Schema-constrained like the ranker, but the resemblance stops there — this
   * one writes long-form prose a human reads, several thousand characters per
   * command, so it is closer to the summarizer in what it needs to be good at.
   * It is also the only model call a reader waits on synchronously, which makes
   * a slow model expensive in a way the ranker's slowness never is.
   */
  AVA_MODEL_TRANSLATOR: gatewayModelId.default('openrouter/google/gemini-3.1-flash-lite'),
  /**
   * `/summarize`: explains one article at length, in whatever language the
   * reader named.
   *
   * Its own entry rather than sharing `AVA_MODEL_RSS_SUMMARIZER`, which is the
   * *digest* writer — that one runs on a schedule nobody waits on and emits two
   * fields, this one is a reader waiting on their phone for several paragraphs.
   * The two are tuned against different costs and want to move independently.
   *
   * Not the orchestrator either, deliberately: `minimax-m3` is the model with
   * the `</think>` truncation documented in AGENTS.md, and a summary that starts
   * mid-word is this command's worst failure.
   */
  AVA_MODEL_SUMMARIZER: gatewayModelId.default('openrouter/google/gemini-3.1-flash-lite'),

  /**
   * `/follow`: turns the subject the reader typed into an English beat
   * definition — title, emoji, subtopics, rubric bullets.
   *
   * Cheap and schema-constrained, like the ranker. It runs once per beat ever
   * created, over one line of input, and needs no search — which is the whole
   * reason it is not the scout below.
   */
  AVA_MODEL_BEAT_NAMER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash'),
  /**
   * `/follow`: proposes websites that publish about the subject.
   *
   * **The only model here that needs the open web**, and the reason no search
   * dependency was added — `perplexity/sonar` searches natively and bills
   * through the same `OPENROUTER_API_KEY` as everything else.
   *
   * `sonar` rather than `sonar-pro` is measured, not assumed: 18/24 verified
   * feeds against 16/24 over three subjects, faster and cheaper, with sonar-pro
   * inventing a domain on one of them. See `src/mastra/agents/scout.ts`. If you
   * change this, the replacement must actually search — a plain chat model will
   * confidently return sites from its training data and the misses will be
   * silent ones.
   */
  AVA_MODEL_BEAT_SCOUT: gatewayModelId.default('openrouter/perplexity/sonar'),

  /**
   * Durable state: Mastra memory/workflows/scores plus the app's own tables.
   * `file:` for local dev, `libsql://…` (Turso) in production so the container
   * stays stateless and needs no volume.
   */
  AVA_DATA_DB_URL: z.string().min(1).default('file:./.data/ava.db'),
  /** Required only for remote libsql/Turso URLs. */
  AVA_DATA_DB_AUTH_TOKEN: z.string().optional(),

  /** Traces are a dev-time artifact — a local file is the right home for them. */
  AVA_TRACES_DB_URL: z.string().min(1).default('file:./.data/traces.db'),

  /** Relative paths anchor to the project root, not cwd; must ship with the built server. */
  AVA_MIGRATIONS_DIR: z.string().min(1).default('drizzle'),

  /** IANA zone for digest schedules. Set explicitly so fire times don't follow server locale. */
  AGENT_TIMEZONE: z.string().min(1).default('Europe/Paris'),
})

const telegramSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Comma-separated. Without it, anyone who finds the bot can spend your tokens. */
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  /** Chat that scheduled digests are pushed to. */
  TELEGRAM_CHAT_ID: z.string().min(1),
})

function parse<T extends z.ZodType>(schema: T, scope: string): z.infer<T> {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid ${scope} environment:\n${issues}\n\nSee .env.example.`)
  }
  return result.data
}

export const env = parse(coreSchema, 'core')

let telegramCache: z.infer<typeof telegramSchema> | undefined

/** Validated on first use so the news pipeline can run without Telegram configured. */
export function telegramEnv(): z.infer<typeof telegramSchema> {
  telegramCache ??= parse(telegramSchema, 'Telegram')
  return telegramCache
}

export function allowedTelegramUserIds(): string[] {
  return splitUserIds(telegramEnv().TELEGRAM_ALLOWED_USER_IDS)
}

/**
 * The digest chat, or undefined when unset.
 *
 * The inbound tab router runs on every message and only needs to know whether a
 * thread belongs to *this* chat; `telegramEnv()` would throw for a bot that has
 * a token and an allowlist but no chat id, taking the conversation down over a
 * value it can degrade without.
 */
export function telegramChatId(): string | undefined {
  return process.env.TELEGRAM_CHAT_ID || undefined
}

function splitUserIds(raw: string): string[] {
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
}

/**
 * Telegram config for the *inbound* channel, or undefined when Telegram isn't
 * configured.
 *
 * Deliberately does not throw when Telegram is absent, unlike `telegramEnv()`.
 * The agent that registers the channel is imported by the Mastra instance
 * itself, so throwing here would take the whole app — and Studio — down
 * whenever Telegram is unconfigured, which is the exact split this file exists
 * to preserve.
 *
 * It *does* throw when a token is present without an allowlist. The adapter
 * treats a missing allowlist as "everyone", so that combination is the one
 * misconfiguration that silently opens the bot to anyone who finds it.
 */
export function telegramChannelEnv(): { botToken: string; allowedUserIds: string[] } | undefined {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return undefined

  const allowedUserIds = splitUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS ?? '')
  if (allowedUserIds.length === 0) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is set but TELEGRAM_ALLOWED_USER_IDS is empty — the adapter would ' +
      'accept messages from anyone who finds the bot. See .env.example.',
    )
  }
  return { botToken, allowedUserIds }
}
