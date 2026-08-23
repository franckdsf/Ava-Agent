---
applies_to: ["src/mastra/agents/**", "src/mastra/tools/**", "src/mastra/workflows/**", "src/config/**"]
---

# Models and prompts

Gotchas. The routing table is [README.md](README.md).

- **A reply that starts mid-word is the model, not the transport.** minimax-m3
  intermittently closes its `</think>` tag *inside* the answer it has already
  started writing, so OpenRouter routes the opening of the reply into the
  reasoning channel and only the tail reaches Telegram. Seen twice in one real
  session: the reader got `'as d'autres questions !` and a bare `✨`. It looks
  exactly like broken streaming, and it isn't — check
  `mastra_messages` before touching the adapter:

  ```
  reasoning: "…No tools needed.De rien 😄 N'hésite pas si t"
  text:      "\n\n'as d'autres questions !"    ← all Telegram is given
  ```

  `reasoning: { enabled: false }` does not suppress it — verified against the
  live API, m3 emits the think block regardless. The only real fix is a
  different orchestrator model; measured alternatives, same conversation, three
  runs each: `anthropic/claude-haiku-4.5` ($1/$5 per M) 1.0–1.8s and no think
  block at all, `google/gemini-3.6-flash` ($1.50/$7.50) 1.3–1.6s cleanly split,
  `deepseek/deepseek-v4-flash` ($0.14/$0.28) cleanly split but one run in three
  took 12s. Staying on m3 ($0.30/$1.20) is a deliberate cost call — the
  truncation is the price.

- **Model IDs need the `openrouter/` prefix.** Mastra's registry lists `deepseek`
  and `minimax` as *direct* providers too, so a bare `deepseek/deepseek-v4-flash`
  is valid — it just bills DeepSeek and demands a `DEEPSEEK_API_KEY`. `env.ts`
  rejects unprefixed IDs at startup; don't weaken that guard to "make it work".

- **A JSON schema is a request to OpenRouter, not a guarantee.** `structuredOutput`
  sends the schema as `response_format`, and the gateway routes to whichever
  provider is cheapest — some of them answer with well-formed JSON under a key
  of their own choosing. `deepseek-v4-flash` returned the ranker's whole batch,
  every item correctly shaped, wrapped as `{"scores":[…]}` for a schema that
  names `rankings` (2026-08-07), and Mastra threw the step. **Name the envelope
  key in the prompt as well as in the schema** — the ranker's instructions do —
  and keep the retry, because the key a provider picks varies per call.

- **A model call that fails must leave its batch untouched, not settle it.**
  `rankBeat` writes a zero verdict for every article the ranker did not score,
  which is right for a cluster duplicate and catastrophic for a failed call: the
  zeros are saved, the articles never re-enter the queue, and a beat silently
  loses a run's worth of news. It now returns early when nothing usable comes
  back, the same trade `scoreBatch` makes. "The model failed" and "none of these
  are any good" must never be the same value.

- **A memory is never rewritten, and that is not an oversight.** The obvious
  change to `memories` is to update a fact in place when it stops being true.
  Doing it deletes the only thing that makes the table more than a key-value
  store: "dark hair (2025-01)" followed by "blond hair (2026-01)" is what lets
  Newy answer *"blond, since January — dark before that"*. Verified against the
  live model, which said exactly that. `forget-memory` is for a fact that was
  never true, not for one that changed.
  ([0014](../decisions/0014-two-tier-memory-for-ava.md))

- **The memory reviewer's prompt was calibrated backwards on the first try, and
  a plausible prompt is not evidence.** Told to drop borderline notes, it
  returned an *empty list* on three runs out of three — which would have deleted
  a new job and a named sister. The asymmetry runs the other way: a wrongly kept
  note costs one line, a wrongly deleted one is gone silently. Then, told to drop
  duplicates, it returned the duplicate *with a reason saying it should be
  dropped* — the reason field is a scratchpad unless the prompt says everything
  returned is kept regardless of what its reason says. Re-run the fixture set
  three times after touching that prompt or changing `AVA_MODEL_MEMORY_REVIEWER`;
  one green run proves nothing.

- **The ranker moves ±10 points on identical input, so a prompt A/B without a
  control is worthless.** Adding the reader-notes block
  ([0016](../decisions/0016-reader-notes-in-the-ranker.md)) moved 11 of 14
  scores on the first measurement, which looks like a working feature and was
  nearly reported as one. Running the *same* prompt three times showed a mean
  max-min spread of **10.0 points per item** — almost every delta was inside it,
  and the two that weren't pointed the wrong way. Any claim about a ranking
  prompt needs both conditions run at least three times and the within-condition
  spread reported next to the between-condition delta. To measure whether the
  model acts on something at all, don't A/B *presence* — flip the input's
  *direction* and watch the items it names: `+80.0` on those against `+5.3` on
  the rest is a mechanism, `+15` on everything is weather.

- **French is a facade on Newy's replies, and nowhere else.** A memory may record
  that the reader writes in French and expects `vous`. That note is now in the
  *ranker's* prompt too, where obeying it would produce French `reason` strings
  in `items` — read later by `search-news`, by the article writer, and by
  whoever opens the database. Every stored string, every prompt, every note is
  English; only the text Telegram shows a human follows the reader's language.
  Both prompts say so explicitly (`curator.ts` for reasons, `newy.ts` for notes)
  because neither model infers it — verified across six ranking runs carrying a
  lasting "writes in French" note, all reasons English.

- **`decide` and `apply` are separate steps so a bad model response can't
  delete.** `reviewMemories` throws when the response has no parsed object rather
  than returning `[]`, because the caller deletes everything not promoted —
  "the model returned junk" and "nothing was worth keeping" must never be the
  same value. Promotion also runs *before* the sweep, and the sweep matches
  `tier = 'short'` only, so a note rescued this run cannot be deleted by it.

- **Newy's instructions are a function now, and the notes go in a second system
  message.** Concatenating them into the one string would change the whole
  prompt every turn and lose the cacheable prefix. The block also carries today's
  date — without it every date in the notes is an opaque string and the
  supersession reading doesn't happen at all.

- **A prompt rule obeyed 99% of the time is a bug at this volume.** Densely
  glossing an article asks the model for hundreds of small judgements in one
  response, so "never gloss a proper noun" still shipped
  `OlmoEarth (OlmoEarth)`, and "never gloss a grammatical word" still shipped
  `sont (are)` and `dans (in)`. Strengthening the prompt moved density from 47
  glosses per 100 words to 29 and eliminated neither. `pruneGlosses` in
  `translator.ts` strips exactly the two cases that need no judgement — an echo
  of the word in front of it, and a bare English function word. Anything needing
  taste stays in the prompt and stays imperfect. Note the elision split in there:
  without it `L'API (API)` is not an echo, and in French the article fuses to the
  noun constantly.

- **`translation.readerLevel` is the lever, not the gloss wording.** Both
  commands filter by CEFR level before anything else. Set to B2 the model glosses
  `raffinement` and `s'emboîtent`; with no level at all it glossed
  `vous n'avez (don't have)` and `petit (small)`, which is the feature failing
  while appearing to work. The two commands separate on the *same* axis —
  `/translearn` at the level and above, `/translate` only above it — and when
  that distinction was left to words like "dense" and "sparse" they converged to
  within two glosses of each other. Re-measure `minGlossesPer100Words` after
  changing the level; it went from ~27 per 100 words unlevelled to ~7.4 at B2,
  and a floor left at the old value retries every good run.

- **Telling a model to drop boilerplate makes it announce that it did.** The
  fetch fallback in `read-article` carries nav chrome, which a summary tolerates
  and a *translation* renders verbatim — a real run opened with
  `Retour aux Articles (Back to Articles)` and the CSS fragment `a]:hidden`.
  Adding a "drop page furniture" rule fixed that and produced a run whose first
  paragraph was a bulleted note listing what it had removed. Both rules are
  needed: drop it, **and** never describe the drop.

- **A prompt rule written in English gets applied to English.** `/summarize`
  was told never to write about the article, only about its subject — the usual
  "no 'This article covers…'" rule. Four live runs on one article: both English
  runs obeyed it and both non-English runs broke it, with
  `Cet article détaille une conversation…` and
  `Este resumo aborda um painel de discussão…`. The model was matching the
  *strings* the rule named rather than the shape of sentence it described. The
  fix was to quote the observed non-English openers verbatim and say outright
  that the rule is about the sentence, not about the English words — zero of
  four on a re-run of the same article. **So test a multilingual prompt in the
  languages it will actually run in**; an English pass proves nothing about the
  others, and this is the same class of failure as the reasons-must-be-English
  rule in the ranker, seen from the other side.

- **The rule that kills "This article covers…" also kills the author.** On a
  video *review* of two skill collections, `/summarize` returned a correct,
  well-organised, completely voiceless summary: the tools were described, and
  every verdict was gone — what the reviewer dismissed at first, what changed
  their mind, which of the two sets they preferred and why, the complaint about
  the writing in one of them. The closing argument, which the whole video builds
  to, arrived as unattributed advice. `kind` does not help, because it switches
  only a section about caption defects — nothing in the prompt knew the piece was
  arguing rather than reporting, and three rules were actively flattening it:
  "write about the subject, never about the piece" (for a review, the reviewer's
  position *is* the subject), "no hype" (a genuine strong reaction is
  indistinguishable from a press release under that rule), and a body rubric
  written for a findings piece. The prompt now carries a second axis the caller
  never declares — **what the piece is**, decided by the model from the text —
  saying that a verdict is a fact about the subject rather than a frame, and that
  an author's view is not hype. Not yet re-measured across languages; the
  English-rule lesson above says an English pass would not settle it anyway.

- **"Code goes in backticks" over-applies to proper nouns.** The same command
  came back with `Claude Code`, `Claude Tag` and `Fable` fenced as code
  throughout, which reads like a config file. Adding an explicit "a name is not
  code — backticks are for things you would *type*" cut it to three instances in
  one run of four (`Bun`, `Rust`, `Slack`) and did not eliminate it. Left in the
  prompt deliberately: a deterministic backtick-stripper would corrupt the real
  code spans the rule exists to produce.

- **`deepseek-v4-flash` has a latency range, not a latency.** Ten runs on one
  1556-character chunk: 9s, 11.6s, 21.1s, 25.7s, 52.8s, 68s, 107s, 160.8s,
  207.7s, 282.8s — a factor of thirty, uncorrelated with output length. Two runs
  will tell you whatever you want to hear, in either direction; the first pair
  measured here said 68s/107s and nearly justified switching models on it. Don't
  quote a number for this model, and don't tune a timeout against one.

- **The `0731` snapshot did not fix that, and it is not the model to put back on
  a reader-facing call.** Re-measured 2026-08-17 with `pnpm models:check`, since
  the numbers above were taken on the April `deepseek-v4-flash` and a newer
  snapshot deserved its own reading. Ten translator draws on one 1500-character
  chunk, eight in flight: 82.7s, 101.3s, 108.9s, 124.7s, 141.0s, 148.2s, 162.7s,
  220.3s, 233.9s, 250.8s — median **148s** against `gemini-3.1-flash-lite`'s
  **8.5s** (10/10, worst 11.3s) on the same chunk in the same run. Six summarizer
  draws run **serially**, so contention explains nothing: 11.3s, 31.4s, 87.3s,
  111.8s, 164.6s, 207.3s — median **112s** against gemini's **7.4s**. The spread
  survived; what disappeared is the fast end. April produced draws under 30s and
  `0731` produced one in sixteen, which is worse than it looks — a model that is
  *reliably* slow cannot be rescued by a retry.

- **A cheap output rate is not a cheap call when the model thinks more than it
  writes.** `deepseek-v4-flash-0731` bills output at $0.28/M against
  `gemini-3.1-flash-lite`'s $1.50 — 5.4× cheaper on paper — and measured **0.63×
  per translator call**, because at `reasoning: { effort: 'low' }` it spends
  **87%** of its output tokens on reasoning. Effort is a per-model dialect, not a
  setting: on the same prompt gemini spent 81% and `solar-pro4` 95%. Two
  consequences. Price a model on `$/call` from `pnpm models:check`, never on the
  rate card. And read `reasoningTokens` before believing a latency figure — a
  model emitting three thinking tokens per written one is slow for a structural
  reason no endpoint change will fix.

- **A model can pass every latency and price bar and still be unusable because it
  ignores the schema.** `tencent/hy3` failed **5 of 10** translator calls on
  2026-08-17 with `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED`: it returns
  `{"language":"French","translation":"…one long string…"}` where
  `translationSchema` requires `paragraphs` as an array of blocks. The prose in
  those strings was good, which is the trap — the failure is invisible in a
  spot-check that only reads output, and `translateChunk` throws on it. Any
  candidate for these two agents has to be measured on *parse rate first*;
  `pnpm models:check` reports it as the `ok` column for that reason.

- **The thinking share is where the money was, and it is the one number the rate
  card cannot show you.** `gpt-5.6-luna` replaced `gemini-3.1-flash-lite` on the
  translator and the summarizer on 2026-08-19, measured with `pnpm models:check
  --models luna --fixtures 1 --repeats 10`. Parse rate **10/10 on both tasks**,
  which is the bar `tencent/hy3` failed above and the one to clear first.
  Translator: median **6.7s** against **8.8s**, `$0.00130` against `$0.00468` —
  **0.28×**. Summarizer: median **7.3s** against **7.8s**, `$0.00162` against
  `$0.00448` — **0.36×**. The rate card predicted 1.25×, so nearly all of the
  real 3.6× came from somewhere else: luna spent **25%** of its output tokens on
  reasoning where gemini spent **82%** (translator), and **8%** against **73%**
  (summarizer). Same prompt, same `reasoning: { effort: 'low' }`, same provider
  pinning — a reminder that effort is a per-model dialect and the cheap call is
  the one that thinks less, not the one with the lower posted rate.

- **Fewer bullets and fewer backticks was the model obeying the prompt, not
  losing detail.** The same run moved the summarizer from 4.3 bullets per
  summary to 2.0, which reads like a regression in the table and is not one:
  the prompt asks for bullets only "where the article really is a list of
  specifics" and warns against turning the whole summary into them. Read the
  transcripts before believing a shape metric — luna's prose carried the
  saturation-versus-brightness measurement that gemini's bulleted version
  dropped, and emitted zero code spans against gemini's two, on the same
  proper-noun-backticking failure documented above.

- **`generate()` throws on a schema mismatch rather than returning a null
  `object`.** The job writer's first live response came back truncated mid-string
  — `{"summary":"…This role is fully` — and the `?? fallback` pattern used
  everywhere else in this repo does **not** catch it. It would have taken down the
  whole delivery step and lost every other posting in the batch.

- **Mastra retries requests, not malformed answers.** `modelSettings.maxRetries`
  covers a failed HTTP call, and `structuredOutput.errorStrategy: 'fallback'`
  substitutes a value *without asking again* — so neither re-prompts a model that
  returned truncated JSON, which is the one thing worth doing about it, the
  truncation being stochastic. `withRetry` in `src/services/structured-output.ts`
  is the explicit loop, shared by both pipelines; `jobPipeline.modelAttempts`,
  `pipeline.modelAttempts` and `leadPipeline.modelAttempts` are all 2. Proven by
  capping the writer at 40 output tokens: attempt 1 truncated, attempt 2
  truncated, returned null, caller degraded to the scorer's own reason.

- **`.default([])` on a schema field is the wrong answer to a truncated response,
  and was tried first.** It stops the throw, and that is the problem: a reply that
  lost two thirds of its content silently becomes a valid one and nothing reports
  it. A strict schema is what *tells you* to retry. (It also makes zod's input
  type optional while the output type stays required, and `response.object` is
  typed from the input side, so every caller normalizes fields the schema already
  promised.)
