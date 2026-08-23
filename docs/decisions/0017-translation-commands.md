---
id: 0017
applies_to: ["src/mastra/commands/translate.ts", "src/mastra/agents/translator.ts", "src/config/translation.ts"]
status: accepted
supersedes: []
verify: "pnpm models:check"
---

# ADR-0017: Translation as slash commands, glossed inline, in their own tab

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The reader reads English news in French. They wanted the article back in their
own language with the English kept visible, so that reading the digest is also
vocabulary practice — densely glossed when studying, lightly glossed when just
reading.

Three things in the system already pointed at how to build it:

- A swipe-to-reply already identifies an article with no state kept anywhere. The
  item id is a hash of the canonical link and the digest carries that link in its
  heading, so the URL in the quoted message *is* the primary key
  ([ADR-0013](0013-swipe-to-reply-as-article-context.md)).
- The reader's language is already recorded, as an ordinary note in `memories`
  ([ADR-0014](0014-two-tier-memory-for-ava.md)). Nothing had to be asked for.
- A slash command is already intercepted before the agent sees it, and a
  catch-all handler already exists so none is silently dropped
  ([ADR-0010](0010-ava-answers-only-in-the-chat-tab.md)).

## Decision

**Two slash commands over one agent, differing only in gloss density.**
`/translearn` glosses most content words; `/translate` glosses only the terms
worth watching. Both are entries in `TRANSLATIONS` in `src/config/translation.ts`
— a third density is an entry, not a handler.

**A command, not a tool on Ava.** The adapter routes any message whose first
entity is a `bot_command` to `processSlashCommand` and skips the message path
entirely, so a command never reaches the agent anyway. It also passes the
untouched Telegram payload through as `event.raw`, which means the swipe survives
and the same parser and link lookup work unchanged.

**Its own tab.** Output goes to a third topic, `📜 Translations`. A translated
article is several thousand characters over several messages; in Chat it buries
the conversation.

**The model returns markdown, the template owns only the link.** Structured
output (`{ language, paragraphs[] }`), one entry per block. The first version
forbade the model any markup at all and escaped its output with
`escapeMarkdown`, on the digest writer's reasoning that a model emitting its own
markdown eventually breaks a link. That was the wrong boundary and it shipped an
unreadable message: every heading, list and code fence came out backslashed. The
risk was never markup in general, only the *link* — so the model now writes
headings, lists, quotes, inline code and fenced blocks, is forbidden to write a
link at all, and the heading carrying the article's URL is still templated.

**Glosses are italic: `mot (_word_)`.** Verified through the real format
converter that the underscore parses as emphasis against a parenthesis. Plain
`(word)` is visually indistinguishable from the article's own parentheticals.

**Glossing is levelled, not exhaustive.** `translation.readerLevel` (CEFR) is
what decides whether a word is worth glossing, and it is the single most useful
knob in the file. Without it the model glosses by word *class* and buries what
matters: a B2 reader got `vous n'avez (don't have)`, `est là (here)` and
`petit (small)`. The two commands then split on the same axis — `/translearn`
glosses at the reader's level *and above*, `/translate` only clearly above it
plus the subject's domain terms.

**Translated in parts, sent as each lands.** The article is chunked on paragraph
boundaries at `sourceChunkChars`, and each part is sent as it comes back. The
first part resolves the target language and every later part is pinned to it.

**Two gloss rules are enforced in code, not in the prompt.** A gloss that repeats
the word in front of it, and a gloss that is a bare English function word, are
stripped deterministically by `pruneGlosses`.

## Consequences

**It is slow, and the slowness is bought deliberately.** Ten runs against the
same 1556-character chunk on 2026-07-28: 9s, 11.6s, 21.1s, 25.7s, 52.8s, 68s,
107s, 160.8s, 207.7s, 282.8s. A factor of thirty, uncorrelated with output length
— the run that emitted the fewest words took 107s. A full article is several of
those in sequence, so minutes. Faster models exist and were rejected on cost:
this command emits several thousand characters per part. The mitigations are the
acknowledgement sent before the first part, and sending each part as it lands
rather than at the end.

**A reader gets an answer in a tab they are not looking at.** They type the
command in Chat or News and the output appears in Translations. Telegram floats
the tab with an unread badge, which is the whole affordance — there is no second
notification.

**Ranking against the tab order is not possible.** Telegram sorts tabs by most
recent message. Translations was added third in `TOPICS`, which decides creation
order and nothing else.

**The prompt could not be trusted on glossing, and this will recur.** Told not
to gloss proper nouns, the model produced `OlmoEarth (OlmoEarth)`; told not to
gloss grammatical words, it produced `sont (are)` and `dans (in)`. Strengthening
the prompt moved density from 47 glosses per 100 words to 29 without eliminating
either. Asking for hundreds of judgements in one response means a rule obeyed
99% of the time still fails several times per message. `pruneGlosses` covers only
what is decidable without judgement; anything needing taste stays in the prompt
and stays imperfect.

**Extraction noise became visible.** `read-article`'s fetch fallback carries nav
chrome — the summarizer tolerated it, a translation renders it as
`Retour aux Articles (Back to Articles)` and once a CSS fragment, `a]:hidden`.
The prompt now drops page furniture, and separately forbids *describing* the
drop, because the first fix produced a run that opened with a bulleted note
listing what it had removed. The same failure recurred a third time inside a
gloss — `a livré (la traduction est 'shipped' mais ici le mot est courant)` —
and needed its own rule. A model told to exercise judgement will narrate the
judgement unless told not to, in every place it exercises it.

**`htmlToText` was silently destroying code, and this is what exposed it.** Every
tag became a space, so `<code>WebAssembly</code>.<code>compileStreaming</code>()`
was stored as `WebAssembly . compileStreaming ()`. A summary never quoted code so
nothing noticed for the life of the project; a translation puts it in a fenced
block where invalid syntax is unmissable. Inline tags are now removed rather than
spaced, and `td`/`th` joined the block list so table cells still separate. **This
only helps newly ingested items** — a conditional GET means existing rows keep
their mangled bodies forever, so the prompt also has to repair code spacing.

**A fourth model call, and the second a human triggers.** Invariant 2 is about
*scheduled* calls choosing their own control flow; this is inbound and
human-initiated, like Ava. It holds invariant 8: it reads `items` and `memories`,
may fetch a page the feed shipped no body for, and writes nothing.

**Cost is now reader-driven.** Every other model call in the system is bounded by
a schedule. This one is bounded by how often the reader asks, and a full article
is several thousand output characters per part.

## Alternatives rejected

**A tool on Ava.** She would decide when to translate, which is exactly the
control-flow-choosing behaviour invariant 2 exists to avoid, and the output would
land mid-conversation. It also does not work: a slash command never reaches her.

**One call for the whole article.** Simpler and it keeps gloss choices consistent
across the piece, but it risks truncation on a long body and gives the reader
nothing until all of it is done — the worst version of a latency problem that is
already the main cost.

**A stored `language` column.** There is no language field and there should not
be: it is an ordinary fact Ava recorded, and reading the notes means the answer
updates itself when the reader says something new.

**A glossary at the end instead of inline parentheses.** Cleaner to read and
worse at the job — the word ends up far from the sentence that taught it.
