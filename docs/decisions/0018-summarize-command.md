---
id: 0018
applies_to: ["src/mastra/commands/summarize.ts", "src/mastra/agents/summarizer.ts", "src/config/summary.ts"]
status: accepted
supersedes: []
verify: "pnpm models:check"
---

# ADR-0018: `/summarize [language]`, answered in Chat, with the language typed rather than remembered

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

The digest already carries a summary of every delivered article — a one or two
sentence lede and up to three points
([ADR-0008](0008-categories-as-configuration.md)). It is deliberately short,
because it is a card in a scrolling feed, and it is pinned to English because its
output is stored and read again by `search-news`, by the ranker, and by whoever
opens the database.

Neither property survives contact with the reader who wants to *understand* an
article without opening it. They want the caveats, the numbers, and the parts the
card had to drop; and they may want it in a language that is not English, chosen
per article rather than configured once — English for something they will discuss
at work, French to read properly, Russian because they are learning it.

The swipe-to-reply plumbing for this already existed and was already shared by
two callers ([ADR-0013](0013-swipe-to-reply-as-article-context.md),
[ADR-0017](0017-translation-commands.md)).

## Decision

**A slash command over its own agent, `/summarize [language]`.** A command rather
than a tool on Ava for the two reasons in ADR-0017, the first of which is not a
preference: a slash command never reaches the agent — the adapter routes any
message whose first entity is a `bot_command` to `processSlashCommand` and skips
the message path entirely. Using Ava would mean calling `generate()` by hand from
the command handler, writing a turn into the Chat thread's memory that the reader
never had, and handing her the decision of whether to read the article at all.
Her model is wrong for it besides: `minimax-m3` intermittently closes `</think>`
inside its own answer, and a summary that starts mid-word is this command's worst
output.

**The argument is the language, not the text.** This is the one place these
commands diverge and it is worth stating loudly: `/translate <text>` translates
what you typed, `/summarize <language>` summarizes what you *swiped*, into the
language you typed. The two therefore cannot share an argument parser, and
`/summarize` cannot be a third entry in `TRANSLATIONS` — those entries differ only
by a prompt string.

**The default is English, and it does not consult Ava's notes.** The translation
commands read `memories` for the reader's language because translating *into
English* is the one thing they can never usefully do. A summary has no such
asymmetry, the articles are English, and the reader typing a language is a
clearer signal than a note written weeks ago. It also keeps this path off
`memories` entirely.

**Which language a token names is the model's judgement, and only the shape is
checked in code.** `summary.languageArgument` accepts letters, marks, spaces,
apostrophes and hyphens, 2–32 characters — so `fr`, `ru`, `français`, `русский`
and `brazilian portuguese` all pass and a pasted article does not. Resolving the
token is left to the model, which reports back what it decided; that report is
rendered in the footer, so a mistyped language is legible without an error path.
An allowlist would have to be a full ISO-639 table to be honest and would still
reject `brazilian portuguese`.

**One call, no chunking, no retry.** A translation of part 3 is a valid
translation and can be sent on its own; a summary of part 3 is not a summary. The
whole capped body goes in one call, which is also what lets the model decide which
parts of the article mattered. And there is no degenerate-result retry, unlike the
translator: that one has a *measured* failure mode at roughly one call in seven.
Nothing equivalent has been observed here, and a retry invented against an
imagined failure would double the reader's wait to guard something that may not
exist.

**It answers in Chat, not in a new tab.** Translations got their own tab because a
translated article is several thousand characters over several messages and buries
a conversation ([invariant 9](../../AGENTS.md#invariants)). A summary measured
296–465 words in one message, which is the size of thing Chat is for — the same
reasoning that already puts `/start`, the unknown-command reply and
`nothingToTranslate` there.

**Its own model entry, `AVA_MODEL_SUMMARIZER`.** Not `AVA_MODEL_RSS_SUMMARIZER`,
which is the digest writer: that one runs on a schedule nobody waits on and emits
two fields, this one is a reader waiting on their phone for several paragraphs.
They are tuned against different costs and must move independently.

## Consequences

**It is fast, and that was not a given.** Eight runs against the same 7998-character
article on 2026-07-29 landed between 5.4s and 11.8s, on
`google/gemini-3.1-flash-lite` with the same provider pinning the translator uses.
That is a different animal from ADR-0017's 9s–283s and it is why no partial-output
machinery was built here — an acknowledgement covers the wait on its own.

**A model that writes about the article instead of the subject, and the fix was
measurable.** The first four live runs opened two of four summaries with
`Cet article détaille une conversation…` and `Este resumo aborda um painel…` —
in French and Portuguese, while the English runs obeyed the same rule. The rule
had been written in English and was being applied to English words rather than to
the sentence. Naming the observed openers verbatim and saying explicitly that the
rule holds in whatever language is being written took it to zero of four on a
re-run of the same article.

**Product names came back as code, and that one is only mostly fixed.** The first
runs put `Claude Code`, `Claude Tag` and `Fable` in backticks throughout — the
"code goes in backticks" rule over-applied to anything that looked like a proper
noun. Adding "a name is not code" cut it to three instances in one run of four
(`Bun`, `Rust`, `Slack`). It is cosmetic, and stripping backticks in code would
corrupt real code spans, so it stays in the prompt and stays imperfect — the same
resolution ADR-0017 reached about glossing.

**A summary is not in Ava's memory.** It is pushed with `postMessage` rather than
produced through her channel, so she does not know she "said" it, and a follow-up
like "what did you mean by the second point?" asks about something she cannot
see. That is already true of every command reply, and the fix — routing it through
her — is exactly what this command exists to avoid.

**Cost is reader-driven, like the translation commands.** Every scheduled model
call is bounded by a cron; this one is bounded by how often the reader asks, at up
to 8000 characters in and several hundred words out per invocation.

**A fifth model call, and the third a human triggers.** Invariant 2 concerns
*scheduled* calls choosing their own control flow; this is inbound and
human-initiated, like Ava and the translator. It holds invariant 8: it reads
`items`, may fetch a page the feed shipped no body for, and writes nothing — and
unlike the translator it does not read `memories` either.

**Revisit if:** the reader starts asking for a summary of something they did not
swipe, or wants their notes' language to be the default after all. Both are small
changes and both are currently speculation.

## Alternatives rejected

**A tool on Ava.** She would decide when to summarize, which is the
control-flow-choosing behaviour invariant 2 avoids, and it does not work anyway —
a slash command never reaches her.

**A fourth `📝 Summaries` tab.** Consistent-looking, and it applies ADR-0017's
*conclusion* while ignoring its *reason*: length. One short message in the tab the
reader is already reading is better than a badge on a tab they must switch to.
Telegram sorts tabs by recency, so a fourth would also push the others down every
time it was used.

**A third entry in `TRANSLATIONS`.** The entries there differ only in a prompt
string, and this differs in what the reader's own words mean. Forcing it in would
require the dispatcher to know which commands take text and which take a language
— exactly the "if adding one means touching the dispatcher, the split is in the
wrong place" that the file's own comment warns about.

**A hardcoded language table.** Deterministic where nothing needs judging is this
repo's habit, and it is the wrong instinct here. A table honest enough to cover
`ru` must be all of ISO-639, and it would still fail `brazilian portuguese` or
`русский`. It is also *one* judgement per command, not the hundreds per response
that made the translator's prompt untrustworthy.

**Reusing the digest's article writer.** Per-category, rubric-bound,
`{ lede, points }`, English-pinned, and pointed at a templated card. Every one of
those is wrong for this, and loosening them would damage the digest.
