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
 * `deepseek/deepseek-v4-flash-0731` is perfectly valid — it just bills DeepSeek and
 * demands a `DEEPSEEK_API_KEY`. The failure surfaces at first model call, naming
 * a provider that was never chosen. Catching it at startup is far cheaper.
 */
const gatewayModelId = z
  .string()
  .min(1)
  .refine(id => id.startsWith('openrouter/'), {
    message:
      'must start with "openrouter/" — a bare "<provider>/<model>" routes directly to that ' +
      'provider and needs its own API key (e.g. use openrouter/deepseek/deepseek-v4-flash-0731)',
  })

const coreSchema = z.object({
  /** Single key for every model below — chat routes through the OpenRouter gateway. */
  OPENROUTER_API_KEY: z.string().min(1),
  /**
   * Replicate, for Newy's `generateImage` tool — the one thing here that does
   * *not* route through OpenRouter.
   *
   * Optional, and the only optional key: without it `imageTools` is empty and
   * Newy is constructed without the tool, rather than with a tool that throws on
   * first use. A deployment that never asks her for a picture should not have to
   * find a second API key to boot
   * ([ADR-0041](../../docs/decisions/0041-one-deployment-one-reader.md)).
   */
  REPLICATE_API_KEY: z.string().min(1).optional(),

  /**
   * Cheap and high-volume: scores + labels every incoming headline. Text only,
   * but must support schema-constrained output — the rank step reads `.object`.
   *
   * `pnpm bench ranker`, 2026-10-12, 2 beats × 3 runs, at `effort: 'low'` (set
   * on the agent): tied the previous `deepseek-v4-flash-0731` on the judge — each
   * first on one beat — at 14.9s median against 76.6s (worst 16.8s against
   * 178.7s), $0.0048 a batch against $0.0063, and a run-to-run score spread of
   * 5 points against 13. The old model ran with no effort set and spent ~7k
   * reasoning tokens a batch. `claude-haiku-5.5 @ low` was cheaper but judged
   * lower and scored about half as many articles over the digest bar. No votes
   * existed, so none of this is measured against the reader's taste. Re-run on
   * price-routed, 2026-10-12: 18.6s median, $0.0050 a batch.
   */
  AVA_MODEL_RSS_RANKER: gatewayModelId.default('openrouter/deepseek/deepseek-v4.1-flash'),
  /**
   * Strong: writes the digest for the handful of items that survive ranking.
   *
   * `pnpm bench article-writer`, 2026-10-12, 2 × 4 delivered articles × 3 runs,
   * price-sorted routing, with **reasoning off** (set on the agent): judged
   * level with the previous `deepseek-v4-flash-0731` at 12.8s against 60.1s for
   * four articles and $0.0013 against $0.0020. The same model at `low` cost twice
   * as much and was judged worse — on prose, thinking bought nothing here.
   * `gpt-5.6-luna @ low` tied on the judge at a higher price; `claude-haiku-5.5`
   * came last, padding points and writing about "the article". The judge ranked
   * mostly on rule-keeping (≤ 3 points, no filler), which code also checks.
   * "Level" means each was placed above the other on one of the two fixtures
   * (ranks 3/1 against 2/2) — inside the noise floor, as the table said. The
   * field it ran is recorded in `scripts/bench/tasks/article-writer.ts`.
   */
  AVA_MODEL_RSS_SUMMARIZER: gatewayModelId.default('openrouter/deepseek/deepseek-v4.1-flash'),
  /**
   * Conversational surface in Telegram. Vision-capable: images arrive inline.
   *
   * Named for the *role*, not for the agent, and deliberately so: Newy reads it
   * today and every later conversational agent reads the same one. One knob
   * moves all of them together, which is the point — retuning the model a reader
   * talks to is a decision about the surface, not about one persona.
   */
  AVA_MODEL_ORCHESTRATOR: gatewayModelId.default('openrouter/deepseek/deepseek-v4.1-flash'),
  /**
   * Weekly memory review: decides which short-term notes become biography.
   *
   * Schema-constrained like the ranker, and it runs once a week over a few dozen
   * one-line rows — so the volume argument for a cheap model barely applies, and
   * `deepseek-v4-pro` is what the running deployment had been pointed at for
   * months while this default still said `flash`. Promoting what runs over what
   * was written is the point of ADR-0041: what a decision is worth is decided by
   * what the deployment actually uses.
   *
   * The judgement is also the one here with no undo — a note dropped at review
   * is gone, and nothing re-reads the article it came from.
   */
  AVA_MODEL_MEMORY_REVIEWER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-pro'),
  /**
   * `/translearn` and `/translate`: translates an article into the reader's own
   * language, glossed with the English original.
   *
   * Schema-constrained like the ranker, but the resemblance stops there — this
   * one writes long-form prose a human reads, several thousand characters per
   * command, so it is closer to the summarizer in what it needs to be good at.
   * It is also the only model call a reader waits on synchronously, which makes
   * a slow model expensive in a way the ranker's slowness never is.
   *
   * `pnpm bench translator`, 2026-10-12, 2 article parts × 3 runs, kept: luna
   * at `low` routed by latency (as shipped) tied the field's best on the judge
   * at 5.3s median, 7.6s worst, $0.0009 a part. The same model routed by price
   * was slower and dearer (6.7s, $0.0011) — one provider, nothing cheaper to
   * route to. Reasoning off was judged clearly worse: glosses too sparse for
   * study mode, page furniture translated. deepseek-v4.1-flash at `low` took
   * 33s and cost 9× more on ~6k reasoning tokens.
   */
  AVA_MODEL_TRANSLATOR: gatewayModelId.default('openrouter/openai/gpt-5.6-luna'),
  /**
   * `/summarize`: explains one article at length, in whatever language the
   * reader named.
   *
   * Its own entry rather than sharing `AVA_MODEL_RSS_SUMMARIZER`, which is the
   * *digest* writer — that one runs on a schedule nobody waits on and emits two
   * fields, this one is a reader waiting on their phone for several paragraphs.
   * The two are tuned against different costs and want to move independently.
   *
   * Not the orchestrator either, deliberately: that one was chosen for chat, and
   * its predecessor `minimax-m3` carried the `</think>` truncation documented in
   * AGENTS.md — a summary that starts mid-word is this command's worst failure.
   *
   * `pnpm bench summarizer`, 2026-10-12, 2 articles into French × 3 runs, kept:
   * luna at `low` routed by latency (as shipped), 6.1s median, 9.4s worst,
   * $0.0012. Reasoning off by price was faster (6.5s worst) but wrote about
   * the article on both fixtures; deepseek-v4.1-flash tied on the judge at
   * twice the worst-case wait and cost. The judge's noise here was ~1.5 ranks —
   * one setting under two routings landed 3.0 and 4.5 — so nothing beat it.
   */
  AVA_MODEL_SUMMARIZER: gatewayModelId.default('openrouter/openai/gpt-5.6-luna'),

  /**
   * `/follow`: turns the subject the reader typed into an English beat
   * definition — title, emoji, subtopics, rubric bullets.
   *
   * Cheap and schema-constrained, like the ranker. It runs once per beat ever
   * created, over one line of input, and needs no search — which is the whole
   * reason it is not the scout below.
   */
  AVA_MODEL_BEAT_NAMER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash-0731'),
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
  AVA_MODEL_JOB_TARGETER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash-0731'),

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
   * ~200-token rubric, this one runs once a day against a document a
   * hundred times larger, and a model chosen for one is chosen against the wrong
   * cost for the other. They share a default value and nothing else.
   *
   * Must support schema-constrained output — the step reads `.object`.
   *
   * `pnpm bench job-scorer`, 2026-10-12, 2 searches × 30 postings × 3 runs, at
   * `effort: 'low'` (set on the agent): judged level with the previous
   * `deepseek-v4-flash-0731` and `claude-haiku-5.5 @ low` — the three within half
   * a rank — at 25.5s median against 96.7s and $0.0052 a batch against $0.0109.
   * Haiku cost 45% more and sent fewer postings over the bar. Reasoning off was
   * clearly worse on both deepseeks: one v4.1 run returned a single verdict for
   * thirty postings. Stored fits, not reader verdicts, so none of this is
   * measured against what the reader would have applied to. Re-run on
   * price-routed, 2026-10-12: 34.3s median, $0.0038 a batch — slower and
   * cheaper than default routing, the trade `sort: 'price'` makes.
   */
  AVA_MODEL_JOB_SCORER: gatewayModelId.default('openrouter/deepseek/deepseek-v4.1-flash'),
  /**
   * Writes the brief for each posting that cleared the bar.
   *
   * A handful of calls per run over one posting each, and the only job-side
   * output a human actually reads — so it is tuned like `AVA_MODEL_SUMMARIZER`
   * rather than like the scorer. It never sees the CV.
   *
   * `pnpm bench job-writer`, 2026-10-12, 2 × 4 delivered postings × 3 runs,
   * price-routed: kept, with **reasoning off** (set on the agent). Judged level
   * with luna at its provider default — each first on one fixture, 8.7/10
   * against 8.0 — at 9.0s against 18.2s for four briefs and $0.0016 against
   * $0.0021. With reasoning on — the default and `low`, 48 briefs — luna twice
   * leaked its own JSON into a field ("…experience.], / watchOuts"), which the
   * schema accepts as a string; none in the 24 briefs with it off. deepseek-v4.1-flash invented facts and took up
   * to two minutes; claude-haiku-5.5 added watch-outs the scorer never found.
   */
  AVA_MODEL_JOB_WRITER: gatewayModelId.default('openrouter/openai/gpt-5.6-luna'),

  /**
   * `/client`: turns a sentence about who the reader sells to into a
   * `client_profiles` row
   * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
   *
   * The lead-side twin of `AVA_MODEL_JOB_TARGETER` — but **not** tuned
   * identically, and the difference was measured rather than assumed.
   *
   * It started on `deepseek-v4-flash` like the job targeter. Two live runs on
   * 2026-08-19 parsed one sentence in **9.0s and 232.8s** — the same 25× spread
   * `AVA_MODEL_TRANSLATOR` already documents for that model, and the reason that
   * variable no longer points at it. `/client` is a command a reader is *waiting
   * on*, so a four-minute parse is not a slow background step; it is a bot that
   * looks broken, and they will type it again and get a second row.
   *
   * `/client` now also acknowledges after `leadPipeline.ackAfterMs` when a parse
   * runs long, so the reader is never left watching nothing — which makes this
   * variable a **cost/quality** choice rather than a UX one. It stays on the
   * faster model anyway: the call runs once per profile the reader ever creates,
   * so the saving from a cheaper model is a rounding error against a command
   * someone is sitting and waiting for.
   *
   * The job targeter is left alone deliberately: it has the same exposure, but
   * changing it is a decision about the job pipeline and belongs to whoever
   * measures that one.
   */
  AVA_MODEL_LEAD_TARGETER: gatewayModelId.default('openrouter/openai/gpt-5.6-luna'),
  /**
   * Scores a batch of leads against the portfolio, on text alone.
   *
   * The same shape as `AVA_MODEL_JOB_SCORER` — one call, the whole batch, the
   * portfolio in the prompt once — over a smaller batch with less text per item,
   * since a lead carries a page excerpt rather than a full advert.
   *
   * **This is the cheap stage on purpose.** It exists so the expensive one below
   * only ever sees leads that already cleared a bar.
   *
   * Must support schema-constrained output — the step reads `.object`.
   */
  AVA_MODEL_LEAD_SCORER: gatewayModelId.default('openrouter/deepseek/deepseek-v4-flash-0731'),
  /**
   * The `sonar` lead source: which companies recently raised, launched or
   * rebranded such that they now need what the reader sells
   * ([ADR-0039](../../docs/decisions/0039-a-lead-scout-with-its-own-budget.md)).
   *
   * **The third model here that needs the open web**, and the same rule applies
   * as to the other two: it must actually search, or it names companies that
   * raised in 2023 and the failure is silent.
   *
   * `sonar-reasoning-pro` rather than plain `sonar`, following the job scout's
   * measurement rather than re-deriving it — that comparison scored *verified*
   * careers pages and found 16/18 against 11, with plain `sonar` returning
   * substantially the same six small names every run. Name variety is exactly
   * what a prospecting source lives on, so the failure mode it avoids matters
   * more here than it did there.
   *
   * **Nothing it returns is stored unverified.** Code fetches the company's own
   * site, requires real text back *and* the company's name on the page, and
   * fetches the announcement it cites. A lead that resolves nothing is dropped —
   * an unverifiable lead is precisely the one most likely to have been invented,
   * and "does this company need better visuals" is checkable against nothing,
   * unlike "is this company hiring".
   *
   * Cost is capped by `leadScout.maxProfilesPerRun` in `src/config/leads.ts`, not
   * by this variable.
   */
  AVA_MODEL_LEAD_SCOUT: gatewayModelId.default('openrouter/perplexity/sonar-reasoning-pro'),
  /**
   * **Looks at a lead's own images and says whether the reader could improve
   * them.** The most expensive call in this repo, per call and by a distance.
   *
   * It exists because the leads pipeline serves people whose work is visual — an
   * ad creator, a product photographer — and for them the qualifying evidence is
   * *what the company's images look like*, which every other stage of this system
   * is structurally blind to: `mustHave` scans text, `htmlToText` discards
   * images, `minPageChars` is a text floor.
   *
   * `deepseek-v4.1-flash` reads images and replaced `minimax-m3` here as both
   * cheaper and smarter — but it is still a call per lead. Three rules bound it,
   * and all three are load-bearing rather than tuning:
   *
   * 1. It runs **only on leads that already cleared the text score**, one call
   *    each — the writer's side of the line, never the scorer's batch.
   * 2. `leadPipeline.maxVisionCallsPerRun` is a hard stop per run. Lead intake is
   *    unbounded in a way job intake is not, so this is the difference between a
   *    proportional bill and an unwatched one.
   * 3. Its verdict is cached on the lead row and re-run only after
   *    `leadPipeline.visionStaleDays`. A company's site does not change weekly.
   *
   * **Its output may never reach a hard filter.** ADR-0026's rule, unamended:
   * the model supplies prose, the web supplies facts. A filter reading
   * model-written text lets a lead pass on invented evidence.
   *
   * Note this is the same model as `AVA_MODEL_ORCHESTRATOR`. The vision call is
   * schema-constrained rather than free prose, a guard set up against the
   * `</think>` truncation documented in AGENTS.md for `minimax-m3`, and kept. A truncated
   * judgement inside a JSON field is a short judgement; a truncated message is a
   * sentence that stops mid-word.
   */
  AVA_MODEL_LEAD_VISION: gatewayModelId.default('openrouter/deepseek/deepseek-v4.1-flash'),
  /**
   * Writes the short brief and the opening line for each lead that cleared the
   * bar.
   *
   * Tuned like `AVA_MODEL_JOB_WRITER` — a handful of calls a run over one lead
   * each, and the only lead-side output a human reads. It never sees the
   * portfolio in full; it is given the verdict and the signal and turns them into
   * something readable.
   */
  AVA_MODEL_LEAD_WRITER: gatewayModelId.default('openrouter/openai/gpt-5.6-luna'),

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


/**
 * One bot's Telegram identity, as it exists in the environment.
 *
 * Two variables, not three
 * ([ADR-0041](../../docs/decisions/0041-one-deployment-one-reader.md)): a token
 * that is this bot's alone, and `AVA_TELEGRAM_USER_ID` — the one person the
 * deployment serves — which every bot here shares.
 */
const telegramSchema = z.object({
  botToken: z.string().min(1),
  /**
   * The reader's numeric Telegram user id. It is both the allowlist and, in a
   * private chat, the chat id: Telegram's `chat_id` in a DM *is* the user id.
   *
   * Numeric rather than `min(1)` because the wrong thing to paste here is an
   * `@username`, which every API call then rejects one layer further down with
   * "chat not found".
   */
  userId: z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be a numeric Telegram user id — an @username will not work'),
})

/** What the rest of the app reads: a token, who may talk, and where to push. */
export interface TelegramConfig {
  botToken: string
  /** Always exactly the reader — one deployment, one reader. */
  allowedUserIds: string[]
  /** The reader's DM, unless a supergroup override is set. */
  chatId: string
}

/**
 * An empty variable is an unset variable.
 *
 * `dotenv` reads `REPLICATE_API_KEY=` as `''`, which is *present* as far as zod
 * is concerned — so `.default()` never fires and `.optional()` never applies,
 * and a commented-out line behaves differently from an empty one for no reason
 * a reader could guess. Stripping the empties here is what lets `.env.example`
 * ship a key with nothing after the `=`.
 */
function withoutEmpties(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
}

function parse<T extends z.ZodType>(
  schema: T,
  scope: string,
  source: Record<string, unknown> = process.env,
  /** Maps a schema key back to the variable it came from, so the message names the real one. */
  varName: (key: string) => string = key => key,
): z.infer<T> {
  const result = schema.safeParse(withoutEmpties(source))
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${varName(i.path.join('.'))}: ${i.message}`)
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

/** The reader, shared by every bot in this deployment. */
const OWNER_VAR = 'AVA_TELEGRAM_USER_ID'

/** This bot's variables: its own token, plus the deployment's reader. */
function telegramVars(prefix: string): Record<string, unknown> {
  return {
    botToken: process.env[`${prefix}TELEGRAM_BOT_TOKEN`],
    userId: process.env[OWNER_VAR],
  }
}

function telegramVarName(prefix: string, key: string): string {
  return key === 'botToken' ? `${prefix}TELEGRAM_BOT_TOKEN` : OWNER_VAR
}

/**
 * Where this bot pushes, when that is *not* the reader's DM.
 *
 * Optional, unset in every ordinary deployment, and the one thing that keeps
 * the supergroup-forum route alive after the merge above: a group's chat id is
 * a `-100…` number that is nobody's user id, so it cannot be derived and has to
 * be typed. `pnpm telegram:check` prints it when it is in play.
 */
function chatIdOverride(bot: BotEnvTarget): string | undefined {
  return process.env[`${bot.envPrefix}TELEGRAM_CHAT_ID`]?.trim() || undefined
}

const telegramCache = new Map<string, TelegramConfig>()

/**
 * Validated on first use so the news pipeline can run without Telegram
 * configured, and cached per bot rather than once for the process.
 */
export function telegramEnv(bot: BotEnvTarget): TelegramConfig {
  const cached = telegramCache.get(bot.id)
  if (cached) return cached

  const { botToken, userId } = parse(
    telegramSchema,
    `${bot.id} Telegram`,
    telegramVars(bot.envPrefix),
    key => telegramVarName(bot.envPrefix, key),
  )

  const config: TelegramConfig = {
    botToken,
    allowedUserIds: [userId],
    chatId: chatIdOverride(bot) ?? userId,
  }
  telegramCache.set(bot.id, config)
  return config
}

export function allowedTelegramUserIds(bot: BotEnvTarget): string[] {
  return telegramEnv(bot).allowedUserIds
}

/**
 * This bot's chat, or undefined when the deployment has no reader yet.
 *
 * The inbound tab router runs on every message and only needs to know whether a
 * thread belongs to *its* bot's chat; `telegramEnv()` would throw for a
 * deployment mid-setup, taking the conversation down over a value it can
 * degrade without.
 */
export function telegramChatId(bot: BotEnvTarget): string | undefined {
  return chatIdOverride(bot) ?? (process.env[OWNER_VAR]?.trim() || undefined)
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
 * It *does* throw when a token is present without a reader. The adapter treats
 * a missing allowlist as "everyone", so that combination is the one
 * misconfiguration that silently opens the bot to anyone who finds it.
 */
export function telegramChannelEnv(
  bot: BotEnvTarget,
): { botToken: string; allowedUserIds: string[] } | undefined {
  const botToken = process.env[`${bot.envPrefix}TELEGRAM_BOT_TOKEN`]
  if (!botToken) return undefined

  const userId = process.env[OWNER_VAR]?.trim()
  if (!userId) {
    throw new Error(
      `${bot.envPrefix}TELEGRAM_BOT_TOKEN is set but ${OWNER_VAR} is empty — the adapter ` +
      'would accept messages from anyone who finds the bot. See .env.example.',
    )
  }
  return { botToken, allowedUserIds: [userId] }
}
