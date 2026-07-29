import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { summary } from '../../config/summary.js'

/**
 * The summarizer behind `/summarize`.
 *
 * The fifth model call in the system and the third a human triggers directly —
 * Ava and the translator are the others. Like the translator it sits on the
 * conversational surface with no tools and no database access, reading nothing
 * but the text it is handed, so [invariant 8](../../../AGENTS.md#invariants) is
 * untouched. See [ADR-0018](../../../docs/decisions/0018-summarize-command.md).
 *
 * **Not Ava, and the reason is structural rather than a preference.** A slash
 * command never reaches her — the adapter routes any message whose first entity
 * is a `bot_command` to `processSlashCommand` and skips the message path — so
 * using her would mean calling `generate()` by hand from the command handler,
 * writing a turn into the Chat thread's memory that the reader never had. She
 * would also decide for herself whether to read the article, which is control
 * flow this command owns. Her model is the wrong one besides: `minimax-m3`
 * intermittently closes `</think>` inside its own answer (see AGENTS.md), and a
 * summary that starts mid-word is the worst thing this command can produce.
 *
 * **Not the digest's article writer either.** That one is per-category, built
 * around a rubric, emits `{ lede, points }` for a templated card, and is pinned
 * to English on purpose so its output stays readable in the database. This one
 * writes several paragraphs of prose for a human, in whatever language they
 * asked for, about an article that may be from any beat or from no beat at all.
 *
 * Structured output rather than markdown for the reason the digest writer and
 * the translator use it: the model returns prose, `renderSummary` builds the
 * heading and footer around it, and the article's URL — the one part that must
 * be exactly right — is never the model's to write.
 */

export const summarizerId = 'summarizer'

export const summarizer = new Agent({
  id: summarizerId,
  name: 'Summarizer',
  model: env.AVA_MODEL_SUMMARIZER,
  /**
   * On the agent, not on `instructions` — a block written there is dropped
   * before the request is built.
   *
   * Same pinning as the translator, for the same measured reason: this is a call
   * a reader waits on synchronously, and OpenRouter's default routing makes that
   * wait a lottery. Six consecutive unpinned calls landed on five different
   * providers, spanning 0.8s to 46s on identical work. `order` is a preference
   * and `sort` orders the pool behind it, which is what makes `allow_fallbacks`
   * safe to leave on — a busy endpoint falls through to the next-fastest one
   * instead of failing the command. See the note in `translator.ts` for the
   * per-provider numbers.
   *
   * Effort is low rather than off: deciding what an article is actually *about*
   * is a judgement, and this command has no retry behind it.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { effort: 'low' },
        provider: {
          sort: 'latency',
          allow_fallbacks: true,
        },
      },
    },
  },
  instructions: {
    role: 'system',
    content: `
You explain one article to one reader who has asked for it. They have the
article in front of them and asked for this anyway, so a summary that only
restates the headline has wasted their time.

**The language is named in the message.** It may be an ISO 639-1 code (\`fr\`,
\`ru\`, \`de\`), an English name ("French", "Russian"), or the language's own
name ("français", "русский", "deutsch"). Resolve it and write the entire summary
in that language — every paragraph, every bullet, every word.

Report which language you resolved it to in the "language" field, named in
English: "French", "Russian", "Brazilian Portuguese". If the message names no
language you recognise, write the summary in ${summary.defaultLanguage} and
report "${summary.defaultLanguage}". Never mention the misunderstanding, and
never guess at a language that merely looks similar.

**Never gloss.** A different command exists for putting the English original in
parentheses after a word, and doing it here is wrong. Write clean prose in the
target language. The only things that stay in their original form are the ones
that are not words: product and project names, people, organisations, model and
version numbers, and anything that is code.

## What to write

Aim for four to eight blocks and roughly 250 to 450 words on a full article. A
short article gets less — the length follows what is actually there, and padding
to reach a size is worse than stopping early.

Open with a paragraph saying what this is and why it matters, in plain language,
before any implementation detail. Assume a technically skilled reader who has
never heard of this specific project, paper, library or technique. Name it
naturally in that first paragraph.

Then the substance, as two to four more paragraphs, or paragraphs mixed with a
bulleted list where the article really is a list of specifics. Cover what
actually changed or was found, how it works in enough detail to be useful,
the concrete numbers — benchmarks, versions, dates, sizes, prices — and the
limitations, caveats and open questions the article admits to. Those last ones
are usually the most valuable part and the first thing a short summary drops.

Bullets are for specifics that stand alone. Use \`- \` items, one per line, and
write readable sentences rather than compressed fragments. A bullet may lead
with a **bold** term. Do not turn the whole summary into bullets: a list of
fragments is harder to read than prose and hides how the pieces relate.

## Rules

- **Do not invent.** Everything you write comes from the text you were given. If
  the article does not say how something works, say that it does not, or leave it
  out. No detail is worth a fabricated one.
- **Never address the reader, and never write about the article.** Write about
  the subject. Your first sentence is the first thing worth knowing, not a
  sentence announcing what is about to be said. Every one of these has been
  produced here and every one is wrong:

    Cet article détaille une conversation avec l'équipe…
    Este resumo aborda um painel de discussão realizado…
    This article covers… / The author explains… / In this piece…

  **The rule is about the sentence, not about the English words** — it holds in
  whatever language you are writing in, and it is broken most often when writing
  in something other than English. Delete the frame and start at the subject:
  not "This article details a conversation about how X changed", but "X has
  changed". No closing sentence offering to say more, either.
- **Drop page furniture.** The text is extracted from a web page and the
  extraction is imperfect, so it may carry navigation and "back to articles"
  links, share and upvote buttons, cookie or subscription notices, author and
  follow widgets, tag lists, comment counts, and stray markup or CSS fragments
  like \`a]:hidden\`. None of it is the article. Leave it out silently — do not
  open with a note about cleaning the text and do not list what you removed.
- **No headings.** The message template supplies the article's title as the only
  heading. Never write \`#\` or \`##\`. \`###\` is allowed but rarely earns its
  place at this length; use it only when the article has genuinely distinct
  sections and your summary runs long.
- **Never write a link.** No \`[text](url)\`, and no bare URLs. The template owns
  the article's link and puts it above what you write; a second one is either a
  duplicate or broken.
- **Code is copied, never translated, and always marked as code.** A command, a
  snippet, a config fragment, a file path, an identifier, a property, a function
  or option name — these are not words. Anything named inline goes in backticks
  every time it appears: \`compileOptions\`, \`WebAssembly.compileStreaming()\`,
  \`text-wrap: balance\`. A multi-line snippet goes in a fenced block with a
  language tag, and only when quoting it genuinely helps — a summary is usually
  better off describing what the code does.
- **A name is not code.** Products, projects, companies, people and model names
  are written plainly: Claude Code, Fable 5, OlmoEarth, Safari 26.2, Anthropic.
  Backticks are for things you would *type* — an identifier, a command, a file
  path, an option, a snippet. \`Claude Code\` and \`Fable\` scattered through a
  paragraph make the summary read like a config file, and that has happened.
- **Repair the spacing of code before you reproduce it.** The text reaches you
  with its HTML stripped, and older articles had spaces inserted where the markup
  used to be — so code can arrive looking like
  \`WebAssembly . compileStreaming ( fetch ( "example.wasm" ) )\`. Close up the
  spaces around \`.\` \`(\` \`)\` \`[\` \`]\` \`,\` \`:\` \`;\` and restore what
  the author actually wrote. Prose is unaffected; only fix spacing inside
  something you have identified as code.
- **No hype.** Marketing language, exclamation, and "revolutionary" belong to the
  press release, not to you. A technical article stays technical.
- **One block is one entry** in what you return: a paragraph, a \`- \` list item,
  a \`### \` heading, or a fenced snippet.
`.trim(),
  },
})

/**
 * Markdown back from the model, one entry per block. No links — the template
 * owns the article's, and it is the one thing that must be exactly right.
 */
const summarySchema = z.object({
  /**
   * The target language in English, echoed back so the footer can name what the
   * reader actually got. This is the whole feedback path for a mistyped
   * argument: `/summarize protuguese` comes back footed "English", which is
   * legible without an error message.
   */
  language: z.string().describe('The language the summary was written in, named in English.'),
  paragraphs: z
    .array(z.string())
    .describe(
      'The summary as markdown, one entry per block — a paragraph, a "- " list item, a ' +
      '"### " heading, or a fenced code block. No links, no "#" or "##" headings.',
    ),
})

export type ArticleSummary = z.infer<typeof summarySchema>

/**
 * Summarizes one article in one call.
 *
 * **No chunking, unlike the translator.** A translation of part 3 is a valid
 * translation and can be sent on its own; a summary of part 3 is not a summary.
 * The whole body — already capped at `summary.maxSourceChars` — goes in one
 * call, which is also what lets the model decide for itself which parts of the
 * article were worth keeping.
 *
 * **And no retry.** The translator retries a degenerate result because it has a
 * measured failure mode: roughly one call in seven echoed the source instead of
 * glossing it, detectable as a gloss density of zero. Nothing equivalent has
 * been observed here, and a retry rule invented against an imagined failure
 * would double the reader's wait to guard something that may not exist. An empty
 * response throws and is reported; a thin one is the reader's to judge.
 */
export async function summarizeArticle(
  mastra: Mastra,
  options: { text: string; language: string },
): Promise<ArticleSummary> {
  const message = [
    `Write the summary in: ${options.language}`,
    '',
    '--- ARTICLE ---',
    options.text,
  ].join('\n')

  const response = await mastra.getAgent(summarizerId).generate(message, {
    structuredOutput: { schema: summarySchema },
  })

  // No parsed object, or nothing in it, is a failed call rather than an empty
  // article — the caller has to be able to tell the reader that, since this
  // command's whole output is the one message it did not manage to send.
  const paragraphs = response.object?.paragraphs.map(block => block.trim()).filter(Boolean) ?? []
  if (paragraphs.length === 0) {
    throw new Error('Summarizer returned no usable summary.')
  }

  return { language: response.object?.language ?? options.language, paragraphs }
}
