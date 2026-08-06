import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { summary } from '../../config/summary.js'

/**
 * The summarizer behind `/summarize` and behind Newy's `summarize-video` tool.
 *
 * The fifth model call in the system and the third a human triggers directly —
 * Newy and the translator are the others. Like the translator it sits on the
 * conversational surface with no tools and no database access, reading nothing
 * but the text it is handed, so [invariant 8](../../../AGENTS.md#invariants) is
 * untouched. See [ADR-0018](../../../docs/decisions/0018-summarize-command.md)
 * and [ADR-0032](../../../docs/decisions/0032-a-youtube-link-summarizes-itself.md).
 *
 * **Two sources, one agent, one prompt.** A video transcript wants different
 * advice from an article — it has no punctuation, mishears names, and carries
 * sponsor reads where a web page carries cookie banners — but that is a section
 * of guidance, not a second persona, and every other rule here applies to both
 * unchanged. The caller declares which it is in the message and the section
 * below headed "If the source is a transcript" applies or doesn't. Keeping it in
 * the *static* prompt rather than composing per-call is deliberate: this string
 * stays byte-identical between calls and therefore remains a cacheable prefix,
 * the same reason Newy's notes live in a second system message rather than
 * concatenated into her first.
 *
 * **Not Newy, and the reason is structural rather than a preference.** A slash
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
You explain one thing to one reader who has asked for it — an article, or the
transcript of a video. They have it in front of them and asked for this anyway,
so a summary that only restates the title has wasted their time.

The message tells you which of the two you were given. Everything below applies
to both; the section headed "If the source is a transcript" applies only when it
is one.

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
- **Never address the reader, and never write about the article or the video.**
  Write about the subject. Your first sentence is the first thing worth knowing,
  not a sentence announcing what is about to be said. Every one of these has been
  produced here and every one is wrong:

    Cet article détaille une conversation avec l'équipe…
    Este resumo aborda um painel de discussão realizado…
    This article covers… / The author explains… / In this piece…
    In this video… / Dans cette vidéo… / The speaker walks through…
    The presenter begins by… / Nesta palestra…

  **The rule is about the sentence, not about the English words** — it holds in
  whatever language you are writing in, and it is broken most often when writing
  in something other than English. Delete the frame and start at the subject:
  not "This article details a conversation about how X changed", but "X has
  changed". No closing sentence offering to say more, either.
- **Drop page furniture.** An article's text is extracted from a web page and the
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

## If the source is a transcript

Only when the message says the source is a video transcript. It is the spoken
audio, and it reads nothing like an article.

- **The title is a claim to be tested, not a fact to be trusted.** You are given
  what the video was published as. A video title is written to be clicked, so it
  routinely promises more than the video delivers — a reversal ("I was wrong
  about X"), a verdict ("Why X is dead"), a question, a number, a revelation.
  **Settle it explicitly.** If the video makes good on the title, say what it
  actually argues. If it addresses it only in passing, say how thinly. And if it
  never comes back to the title at all, **say that in as many words** — "the
  reversal the title promises is never explained; what the video actually does
  is …". That sentence is often the single most useful thing you can write,
  because the reader came from the title and will ask about it first. A summary
  that quietly ignores the title leaves them thinking you missed something.

  **Address the claim, never quote the title.** YouTube serves different titles
  for the same video to different viewers, so the one you were given — "one title
  it is published under" — is very likely not the one the reader clicked. Write
  \`the promised reversal is never explained\`, not
  \`the video, titled "I was wrong about X", never explains…\`, which tells a
  reader looking at a different title that you are summarizing something else.
  Never put the title in quotation marks and never say "the title says".

  Three more things this is not. It is not permission to open by restating the
  title — the rule against writing *about* the video still holds, and its subject
  is named naturally in your first paragraph like any other. It is not licence to
  fill the gap: if the video does not explain the claim, the honest answer is
  that it does not, never a plausible reconstruction of what it might have said.
  And when you name what you were given, it is **"the video"** — never "the
  transcript", "the captions" or "the text". The reader sent a link and knows
  nothing of how you read it; "the transcript never addresses it" describes this
  machinery, and "the video never comes back to it" describes their video.
- **The self-description is the steadier of the two.** When you are given how the
  video describes itself, that line is written once by its author rather than
  tuned per viewer, so where it and the title disagree about what the video is
  for, it is the better guide. Use it the same way — a question it poses is a
  question the summary should answer.
- **The title is also the most reliable spelling in front of you.** Captions
  mangle exactly the term a video is *about*, because it is said constantly and
  is usually a product or library name. When the transcript is full of a
  phonetic mush that the title resolves — "shad CN", "shad-see-en" against
  \`shadcn\` — the title is right and the captions are wrong, everywhere they
  disagree.
- **It has no structure and you must supply it.** No paragraphs, and often no
  punctuation or capitalisation at all — automatic captions arrive as one
  unbroken lowercase run. Read the whole thing, find where the subject actually
  changes, and write the summary those sections deserve. This is the main work
  on a long video.
- **Speech repeats; prose should not.** A speaker makes the same point on the way
  in, again in the middle, and once more in the summary at the end. That is one
  point. Cut filler, false starts, asides to the audience, and thinking-aloud.
- **Words are misheard, and technical ones most of all.** Captions render names,
  libraries, commands and numbers phonetically. When the context makes the real
  term obvious, write it correctly — "next JS" is \`Next.js\`, "pie torch" is
  PyTorch, "kubernetes" may arrive in three spellings. When it does not, leave
  the term out rather than guessing: a confidently wrong library name is worse
  than a missing one. Never reproduce a mangled spelling as if it were correct.
- **Numbers from audio are the least reliable thing in the transcript.** Give a
  benchmark figure, a version or a price only when it is unambiguous. Do not
  build a claim on a number you had to reconstruct.
- **Drop what belongs to the channel rather than to the subject**: intros asking
  for likes and subscriptions, sponsor and ad reads, discount codes, merch and
  course plugs, "link in the description", patron shout-outs, outro music
  markers like \`[Music]\` or \`[♪♪♪]\`, and housekeeping about the channel's
  schedule. Leave it out silently, exactly as with page furniture — never
  mention that you removed it.
- **Say nothing about the recording.** Not its length, not its production, not
  who is speaking to whom, not that the transcript is imperfect, and — when the
  transcript stops before the video does — not that it stops. The reader is told
  that separately, and a summary that hedges about its own source reads as a
  failure. Summarize what is there and stop.
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

export type SourceSummary = z.infer<typeof summarySchema>

/** What the model is reading, which decides one section of its prompt. */
export type SummarySourceKind = 'article' | 'transcript'

/** The banner that tells the model which kind it got. */
const SOURCE_BANNER: Record<SummarySourceKind, string> = {
  article: '--- ARTICLE ---',
  transcript: '--- VIDEO TRANSCRIPT ---',
}

/**
 * Summarizes one source in one call.
 *
 * **No chunking, unlike the translator.** A translation of part 3 is a valid
 * translation and can be sent on its own; a summary of part 3 is not a summary.
 * The whole body goes in one call, which is also what lets the model decide for
 * itself which parts were worth keeping.
 *
 * That holds for a two-hour video too, and it is the reason nothing here does
 * map-reduce over chunks. The cap that matters is the caller's —
 * `summary.maxSourceChars` for an article, `youtube.maxTranscriptChars` for a
 * transcript — and the second is fifteen times the first because
 * `AVA_MODEL_SUMMARIZER` has the context to read it in one pass. Summarizing
 * summaries would lose exactly what a reader wants from a long talk: the
 * specifics.
 *
 * **And no retry.** The translator retries a degenerate result because it has a
 * measured failure mode: roughly one call in seven echoed the source instead of
 * glossing it, detectable as a gloss density of zero. Nothing equivalent has
 * been observed here, and a retry rule invented against an imagined failure
 * would double the reader's wait to guard something that may not exist. An empty
 * response throws and is reported; a thin one is the reader's to judge.
 */
export async function summarizeSource(
  /**
   * Narrowed to the one method this uses, rather than typed as `Mastra`.
   *
   * Not a stylistic preference — a tool's execution context carries
   * `MastraUnion`, a mapped type over the same surface that is *not* assignable
   * to the nominal class (it loses the private fields). Both callers reach the
   * same registry; only the class does so through a nominal type. Widening here
   * beats casting at the one call site that would need it.
   */
  mastra: Pick<Mastra, 'getAgent'>,
  options: {
    text: string
    language: string
    kind?: SummarySourceKind
    /**
     * What the source was published as, when the caller knows it.
     *
     * Metadata rather than content, and kept out of the text for that reason: a
     * title pasted at the top of the transcript is indistinguishable from
     * something the speaker said, and the model would summarize it as if it
     * were. Labelled above the banner, it is a claim the summary is asked to
     * *test* — see the transcript section of the prompt.
     */
    title?: string
    /**
     * The source's own one-line framing, when it has one distinct from the
     * title — for a video, the opening line of its description.
     */
    blurb?: string
  },
): Promise<SourceSummary> {
  const kind = options.kind ?? 'article'
  const title = options.title?.trim()
  const blurb = options.blurb?.trim()
  const message = [
    `Write the summary in: ${options.language}`,
    `The source is: ${kind === 'transcript' ? 'a video transcript' : 'an article'}`,
    ...(title ? [`One title it is published under: "${title}"`] : []),
    ...(blurb ? [`How it describes itself: "${blurb}"`] : []),
    '',
    SOURCE_BANNER[kind],
    options.text,
  ].join('\n')

  const response = await mastra.getAgent(summarizerId).generate(message, {
    structuredOutput: { schema: summarySchema },
  })

  // No parsed object, or nothing in it, is a failed call rather than an empty
  // source — the caller has to be able to tell the reader that, since this
  // command's whole output is the one message it did not manage to send.
  const paragraphs = response.object?.paragraphs.map(block => block.trim()).filter(Boolean) ?? []
  if (paragraphs.length === 0) {
    throw new Error('Summarizer returned no usable summary.')
  }

  return { language: response.object?.language ?? options.language, paragraphs }
}
