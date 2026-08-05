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
  /**
   * Conversational surface in Telegram. Vision-capable: images arrive inline.
   *
   * Named for the *role*, not for the agent, and deliberately so: Newy reads it
   * today and every later conversational agent reads the same one. One knob
   * moves all of them together, which is the point — retuning the model a reader
   * talks to is a decision about the surface, not about one persona.
   */
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
   * `/target`: turns a sentence about the work the reader wants into the filters
   * a job search is made of.
   *
   * Cheap and schema-constrained, exactly like the beat namer, and for the same
   * reasons: it runs once per search ever created, over one line of input, and
   * needs no web search. It is also the same *kind* of risk — a model writing
   * configuration — with one important difference in its favour. A bad rubric is
   * hidden by the ranker's ±10 noise floor; a bad filter is deterministic, and
   * `/target` echoes every field back, so the reader sees a wrong parse and can
   * say it again.
   */
  AVA_MODEL_JOB_TARGETER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash'),

  /**
   * The `sonar` job source: proposes companies hiring for one saved search.
   *
   * **The second model here that needs the open web**, and it is the job-side
   * counterpart to `AVA_MODEL_BEAT_SCOUT` in every respect — same provider, same
   * gateway, same key, and the same rule that nothing it returns is stored as a
   * URL without code verifying it first.
   *
   * If you change this, the replacement must actually search. A plain chat model
   * will confidently name companies from its training data, and the failures are
   * silent ones: a company that stopped hiring two years ago resolves a careers
   * page perfectly well.
   *
   * Its own variable rather than sharing the beat scout's, for the reason every
   * other pair here is split: the two are tuned against different costs. The beat
   * scout runs once per beat created plus once a week per under-filled beat; this
   * one runs up to `jobScout.maxSearchesPerRun` times every job cycle.
   *
   * **`sonar-reasoning-pro`, and it is the opposite of the beat scout's answer.**
   * Measured 2026-08-05, five Perplexity models × 3 runs on one search, scoring
   * *careers pages that survive the filter* rather than companies proposed:
   *
   * ```
   * sonar-reasoning-pro   16/18 survived   12 distinct   90s
   * sonar                 11/18            6 distinct    49s
   * sonar-pro             11/18            8 distinct    52s
   * sonar-pro-search       9/18            8 distinct    13s
   * sonar-deep-research    9/18            5 distinct   202s
   * ```
   *
   * The count understates it. `sonar-reasoning-pro` named Vercel, Linear,
   * Supabase, Grafana Labs, Sentry, Productboard and Doist — real product
   * employers — where `sonar` returned the same six small names every run and
   * `sonar-pro` twice returned a *description* instead of a company
   * (`Unnamed Austrian SaaS platform company`), which the prompt forbids outright.
   *
   * Why this differs from `AVA_MODEL_BEAT_SCOUT`, where plain `sonar` won: that
   * task is "name sites that publish about X" and a bigger model spends its extra
   * capacity inventing plausible domains. This task is "name employers hiring for
   * a stack, right now, in a region", which is a harder retrieval problem, and
   * the reasoning variant is measurably better at it. Do not copy either choice
   * to the other without re-measuring.
   *
   * The `</think>` truncation this repo documents for reasoning models did **not**
   * appear across 15 runs, and a failure degrades safely anyway — `proposeCompanies`
   * returns an empty list, so a bad response costs that run's leads and nothing else.
   */
  AVA_MODEL_JOB_SCOUT: gatewayModelId.default('openrouter/perplexity/sonar-reasoning-pro'),

  /**
   * The every-two-days run: scores a whole batch of postings against the CV.
   *
   * **The largest single prompt in this repo.** It carries the reader's CV in
   * full — measured at ~20k tokens — plus every posting that survived the
   * deterministic filters, once per run. Deliberately *not* sharing
   * `AVA_MODEL_RSS_RANKER`: that one sees hundreds of headlines a day against a
   * ~200-token rubric, this one runs once every two days against a document a
   * hundred times larger, and a model chosen for one is chosen against the wrong
   * cost for the other. They share a default value and nothing else.
   *
   * Must support schema-constrained output — the step reads `.object`.
   */
  AVA_MODEL_JOB_SCORER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash'),
  /**
   * Writes the brief for each posting that cleared the bar.
   *
   * A handful of calls per run over one posting each, and the only job-side
   * output a human actually reads — so it is tuned like `AVA_MODEL_SUMMARIZER`
   * rather than like the scorer. It never sees the CV.
   */
  AVA_MODEL_JOB_WRITER: gatewayModelId.default('openrouter/google/gemini-3.1-flash-lite'),

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

function parse<T extends z.ZodType>(
  schema: T,
  scope: string,
  source: Record<string, unknown> = process.env,
  /** Prefixed back onto each reported key, so the message names the real variable. */
  keyPrefix = '',
): z.infer<T> {
  const result = schema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${keyPrefix}${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid ${scope} environment:\n${issues}\n\nSee .env.example.`)
  }
  return result.data
}

export const env = parse(coreSchema, 'core')

/**
 * Just enough of a bot to find its variables.
 *
 * Structural rather than an import of `BotDefinition`, so this module stays free
 * of config dependencies — every `BotDefinition` satisfies it, and nothing here
 * needs to know what a tab is.
 */
export interface BotEnvTarget {
  id: string
  envPrefix: string
}

/** This bot's three Telegram variables, read under its own prefix. */
function telegramVars(prefix: string): Record<string, unknown> {
  return {
    TELEGRAM_BOT_TOKEN: process.env[`${prefix}TELEGRAM_BOT_TOKEN`],
    TELEGRAM_ALLOWED_USER_IDS: process.env[`${prefix}TELEGRAM_ALLOWED_USER_IDS`],
    TELEGRAM_CHAT_ID: process.env[`${prefix}TELEGRAM_CHAT_ID`],
  }
}

const telegramCache = new Map<string, z.infer<typeof telegramSchema>>()

/**
 * Validated on first use so the news pipeline can run without Telegram
 * configured, and cached per bot rather than once for the process.
 */
export function telegramEnv(bot: BotEnvTarget): z.infer<typeof telegramSchema> {
  const cached = telegramCache.get(bot.id)
  if (cached) return cached

  const parsed = parse(
    telegramSchema,
    `${bot.id} Telegram`,
    telegramVars(bot.envPrefix),
    bot.envPrefix,
  )
  telegramCache.set(bot.id, parsed)
  return parsed
}

export function allowedTelegramUserIds(bot: BotEnvTarget): string[] {
  return splitUserIds(telegramEnv(bot).TELEGRAM_ALLOWED_USER_IDS)
}

/**
 * This bot's chat, or undefined when unset.
 *
 * The inbound tab router runs on every message and only needs to know whether a
 * thread belongs to *its* bot's chat; `telegramEnv()` would throw for a bot that
 * has a token and an allowlist but no chat id, taking the conversation down over
 * a value it can degrade without.
 */
export function telegramChatId(bot: BotEnvTarget): string | undefined {
  return process.env[`${bot.envPrefix}TELEGRAM_CHAT_ID`] || undefined
}

function splitUserIds(raw: string): string[] {
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
}

/**
 * Telegram config for one bot's *inbound* channel, or undefined when that bot
 * isn't configured.
 *
 * Deliberately does not throw when Telegram is absent, unlike `telegramEnv()`.
 * The agent that registers the channel is imported by the Mastra instance
 * itself, so throwing here would take the whole app — and Studio — down
 * whenever Telegram is unconfigured, which is the exact split this file exists
 * to preserve. It also means one bot can be configured and the other not,
 * which is the normal state while a second one is being brought up.
 *
 * It *does* throw when a token is present without an allowlist. The adapter
 * treats a missing allowlist as "everyone", so that combination is the one
 * misconfiguration that silently opens the bot to anyone who finds it.
 */
export function telegramChannelEnv(
  bot: BotEnvTarget,
): { botToken: string; allowedUserIds: string[] } | undefined {
  const botToken = process.env[`${bot.envPrefix}TELEGRAM_BOT_TOKEN`]
  if (!botToken) return undefined

  const allowedUserIds = splitUserIds(
    process.env[`${bot.envPrefix}TELEGRAM_ALLOWED_USER_IDS`] ?? '',
  )
  if (allowedUserIds.length === 0) {
    throw new Error(
      `${bot.envPrefix}TELEGRAM_BOT_TOKEN is set but ${bot.envPrefix}TELEGRAM_ALLOWED_USER_IDS ` +
      'is empty — the adapter would accept messages from anyone who finds the bot. ' +
      'See .env.example.',
    )
  }
  return { botToken, allowedUserIds }
}
