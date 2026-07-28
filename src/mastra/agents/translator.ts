import type { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { type TranslationDefinition, translation } from '../../config/translation.js'
import { memoriesForPrompt } from '../../db/memories.js'

/**
 * The translator behind `/translearn` and `/translate`.
 *
 * It is the fourth model call in the system and the second one a human triggers
 * directly — Ava is the other. It sits on the conversational surface and reads
 * nothing but the text it is handed, so
 * [invariant 8](../../../AGENTS.md#invariants) is untouched: no tools, no
 * database, no way to reach a run. See
 * [ADR-0017](../../../docs/decisions/0017-translation-commands.md).
 *
 * Structured output rather than markdown, for the reason the digest writer is:
 * a model asked to emit its own markdown eventually emits a broken link, and
 * the article's URL is the one part of the message that must be exactly right.
 * The model returns prose; `renderTranslation` builds the heading and the
 * footer around it.
 */

export const translatorId = 'translator'

export const translator = new Agent({
  id: translatorId,
  name: 'Translator',
  model: env.AVA_MODEL_TRANSLATOR,
  instructions: {
    role: 'system',
    content: `
You translate an article for one reader, who is using it to keep their
${translation.glossLanguage} in view while reading in their own language.

The text you are given is ${translation.glossLanguage}. Translate it into the
reader's own language, and gloss it — that is, put the original
${translation.glossLanguage} word in parentheses immediately after the word you
translated it to, **in italics**. The reader keeps the source word in sight
without leaving their own language, and the italics keep it visibly separate
from the sentence around it:

  L'entreprise a publié (_released_) un modèle de raisonnement (_reasoning model_).

The form is exactly \`(_word_)\` — an underscore against each side of the
${translation.glossLanguage} word, inside the parentheses. Never \`(word)\`
without them, and never asterisks.

**A gloss contains the ${translation.glossLanguage} word and nothing else.** Not
a note, not a justification, not an alternative, not a sentence in the reader's
language. This is wrong and has happened:

  Safari 26.2 a livré (la traduction est 'shipped' mais ici le mot est courant)

If you are unsure whether a word is worth glossing, leave it unglossed and say
nothing. Never explain a decision inside the text, and never address the reader.

**The reader's ${translation.glossLanguage} is already at ${translation.readerLevel}
(CEFR).** This governs every gloss you write. They are not a beginner: they read
${translation.glossLanguage} articles unaided and only stumble on the harder
vocabulary. A gloss on a word they have known for years is worse than no gloss —
it clutters the sentence and hides the one word they actually needed.

So judge each word by "would a reader at that level have to look this up?", never
by its part of speech. At ${translation.readerLevel}, do **not** gloss:

  publié (published), petit (small), ajoute (adds), est là (is here),
  vous n'avez pas (you don't have), année (year), utiliser (use), façon (way)

Those are all well below their level and every one of them appeared in a real
run that this rule exists to stop. **Do** gloss what sits at their level and
above:

  raffinement (_refinement_), s'emboîtent (_fit together_),
  contourner (_to work around_), en amont (_upstream_),
  affiner (_fine-tune_), sous-jacent (_underlying_)

— precise or formal verbs, abstract and specialised nouns, phrasal verbs,
idioms, collocations, and technical vocabulary. When a word is borderline, leave
it alone: the reader notices a missing gloss far less than a patronising one.

How densely to gloss on top of that changes per request and is stated in the
message. Nothing else about your job changes.

Rules that always hold:

- **Translate, never summarize.** Every sentence you are given comes back as a
  sentence. You are handed one part of a longer article, so it may begin or end
  mid-thought — translate it as it stands. Do not introduce it, do not conclude
  it, do not add a sentence that was not there, and never write that anything
  was shortened.
- **Drop page furniture.** The text is extracted from a web page and the
  extraction is not perfect, so it may carry things that were never article
  prose: navigation and "back to articles" links, share and upvote buttons,
  cookie or subscription notices, author and follow widgets, tag lists, stray
  markup or CSS fragments like \`a]:hidden\`. Leave all of it out. This is not
  summarizing — none of it is a sentence of the article. When a part is nothing
  *but* furniture, return no paragraphs at all rather than translating it.
- **Never describe what you did.** Dropping furniture is silent. Do not open with
  a note about cleaning the text, do not list what you removed, do not label a
  paragraph, and never write anything like "Text cleanup: removed the interface
  elements". Your first paragraph is the first sentence of the article and
  nothing else. You are producing the translation, not a report about it.
- **Gloss with the word that is actually in the text.** The parenthesis holds
  the source word you just translated, in the form it appears, not a synonym and
  not a definition. If a phrase translates as a unit, gloss the unit once —
  \`apprentissage par renforcement (reinforcement learning)\` — rather than word
  by word.
- **Gloss a word once per paragraph.** Repeating the same gloss three times in
  four lines is noise, not practice.
- **A gloss that repeats the word it follows is forbidden.** If the translation
  and the original are the same string, there is nothing to show:
  \`OlmoEarth (OlmoEarth)\`, \`2026 (2026)\` and \`API (API)\` are all wrong.
  Proper nouns, product names, numbers, units and acronyms therefore go
  unglossed, always.
- **Never gloss a grammatical word.** Articles, prepositions, conjunctions,
  pronouns and auxiliaries carry no vocabulary: \`de (of)\`, \`et (and)\`,
  \`sont (are)\`, \`pour (for)\`, \`à (at)\` are all wrong, in every mode. Even
  at the densest setting the gloss goes on words that *mean* something — nouns,
  verbs, adjectives, adverbs, technical terms. Dense means most of those, not
  every word in the sentence.
- **Write markdown, mirroring the structure the article had.** A section heading
  comes back as \`### Heading\`; a list comes back as \`- \` items, one per line;
  a quotation comes back as \`> \`. Bold and italics are yours to use where the
  original emphasised something. A wall of undifferentiated paragraphs is hard to
  read on a phone, and the article's own shape is the best guide to where the
  breaks belong.
- **Never write a link.** No \`[text](url)\`, and no bare URLs on their own. The
  message template owns the article's link and adds it above what you write; a
  second one is either a duplicate or broken.
- **Code is copied, never translated, and always marked as code.** A command, a
  snippet, a config fragment, a file path, an identifier, a property, a function
  or option name — these are not words. Never translate one, never gloss one, and
  never leave one as bare prose.

  Anything named inline goes in backticks, every time it appears:
  \`compileOptions\`, \`WebAssembly.compileStreaming()\`, \`text-wrap: balance\`,
  \`1em\`, \`ic\`. Writing \`le paramètre compileOptions\` without them is wrong —
  the reader cannot see where the identifier begins.

  A multi-line snippet goes in a fenced block, with a language tag:

  \`\`\`js
  const module = await WebAssembly.compileStreaming(
    fetch("example.wasm"),
    { builtins: ["js-string"] }
  );
  \`\`\`

- **Repair the spacing of code before you reproduce it.** The text reaches you
  with its HTML stripped, and that stripping inserted spaces where the markup
  used to be — so code arrives looking like
  \`WebAssembly . compileStreaming ( fetch ( "example.wasm" ) )\` and lists of
  arguments arrive with gaps around every bracket, comma and colon. Restore it to
  what the author actually wrote: close up the spaces around \`.\` \`(\` \`)\`
  \`[\` \`]\` \`,\` \`:\` \`;\`, and indent the block the normal way for its
  language. The reader is going to copy this. It must be valid code, not a
  transcript of the extraction. Prose is unaffected — only fix spacing inside
  something you have identified as code.
- Keep the paragraph breaks the source has. One block — a paragraph, a heading,
  a list item, a fenced snippet — is one entry in what you return.
- Preserve the register and the tense of the original. A technical article stays
  technical; you are not making it friendlier.

The reader's language comes from notes about them, given below when they exist.
Use the language they write in or say they read in. When the notes settle it,
say so exactly; when they say nothing about language at all, use
${translation.fallbackLanguage}.

Report the language you translated into as its ${translation.glossLanguage}
name — "French", "Spanish" — so the rest of the system can name it.

If the reader's own language turns out to be ${translation.glossLanguage},
there is nothing to translate: return the text unchanged, unglossed, and report
the language as ${translation.glossLanguage}.
`.trim(),
  }
})

/**
 * Markdown back from the model, one entry per block. No links — the template
 * owns the article's, and it is the one thing that must be exactly right.
 */
const translationSchema = z.object({
  /**
   * The target language in English, echoed back so later chunks can be pinned
   * to it rather than re-deciding, and so the reader can be told what happened
   * when the notes were ambiguous.
   */
  language: z.string().describe('The language translated into, named in English.'),
  paragraphs: z
    .array(z.string())
    .describe(
      'The translation as markdown, one entry per block — a paragraph, a "### " heading, a ' +
      '"- " list item, a "> " quote, or a fenced code block. No links.',
    ),
})

export type Translation = z.infer<typeof translationSchema>

/**
 * Ava's notes, rendered for the one question this agent asks of them: what
 * language does this person read in?
 *
 * The whole block rather than a language field, because there is no language
 * field — it is an ordinary note like any other ("They write in French and
 * expect vous"), and which note answers the question is a judgement. The notes
 * are one-line rows and the cap is already applied upstream, so this is cheap.
 *
 * Never throws. A failed read costs the language *hint*, not the command — the
 * prompt falls back to `translation.fallbackLanguage` on its own.
 */
async function languageNotes(): Promise<string> {
  try {
    const notes = await memoriesForPrompt()
    const lines = [...notes.long, ...notes.short].map(note => `- ${note.fact}`)
    if (lines.length === 0) return 'No notes about the reader yet.'
    return ['What is known about the reader:', ...lines].join('\n')
  } catch {
    return 'Notes about the reader could not be read.'
  }
}

/**
 * Translates one chunk of an article.
 *
 * `language` is passed on every call after the first, carrying forward what the
 * first chunk resolved. Letting each chunk decide for itself would be one model
 * call's worth of cheaper prompt and a real failure mode: a five-part article
 * that switches language halfway because the second chunk read the notes
 * differently. The notes are therefore only sent when nothing has been decided
 * yet.
 */
export async function translateChunk(
  mastra: Mastra,
  options: {
    text: string
    definition: TranslationDefinition
    /** Resolved by an earlier chunk. Omit on the first, which decides it. */
    language?: string
    /** `n` of `total`, so the model knows it is mid-article. */
    part: { index: number; total: number }
  },
): Promise<Translation> {
  const { text, definition, language, part } = options

  const message = [
    language
      ? `Translate into ${language}. That is settled — do not reconsider it.`
      : await languageNotes(),
    '',
    `How to gloss: ${definition.gloss}`,
    '',
    part.total > 1
      ? `This is part ${part.index} of ${part.total} of one article. Translate only what ` +
      'is below, with no introduction and no closing remark.'
      : 'This is a complete text. Translate all of it.',
    '',
    '--- TEXT TO TRANSLATE ---',
    text,
  ].join('\n')

  const first = await attempt(mastra, message, part.index)

  if (!isDegenerate(first, definition)) return first

  // One retry, no prompt change. The failure is not a misunderstanding to argue
  // the model out of — the same message succeeds on the next call — so a second
  // attempt is worth more than a longer instruction. Only one: if it fails twice
  // the reader is better served by a visibly incomplete translation than by
  // waiting through a third call that may take minutes.
  const second = await attempt(mastra, message, part.index)
  return isDegenerate(second, definition) && !isDegenerate(first, definition) ? first : second
}

async function attempt(mastra: Mastra, message: string, index: number): Promise<Translation> {
  const response = await mastra.getAgent(translatorId).generate(message, {
    structuredOutput: { schema: translationSchema },
  })

  // A chunk with no parsed object is a failed chunk, not an empty one — the
  // caller has already sent the parts before it and must be able to tell the
  // reader the article stops here rather than silently ending it early.
  if (!response.object) {
    throw new Error(`Translator returned no parsable object for part ${index}.`)
  }

  return {
    ...response.object,
    paragraphs: response.object.paragraphs.map(pruneGlosses),
  }
}

/** Extraction debris that proves the source was echoed rather than translated. */
const RAW_DEBRIS = /a\]:hidden|<\/?[a-z][^>]*>|\{[^}]*:[^}]*\}/i

/**
 * True when a result is not a translation at all.
 *
 * Both signals come from a real failed run on 2026-07-28: `/translearn` returned
 * **0.0 glosses per 100 words** and carried the CSS fragment `a]:hidden`
 * straight through, having echoed the extracted page text instead of translating
 * it. Six other runs of the same chunk sat between 26.1 and 47.3, so this is a
 * distinct failure mode rather than the low end of a distribution — roughly one
 * call in seven.
 *
 * Deliberately narrow. It asks "did the command do its job at all", never "is
 * this good" — a mediocre translation is the reader's to judge, and spending a
 * second call on one that is merely thin would double the wait for no gain.
 */
function isDegenerate(result: Translation, definition: TranslationDefinition): boolean {
  const joined = result.paragraphs.join(' ')
  if (!joined.trim()) return false // A part that was pure page furniture. Correct, not failed.
  if (RAW_DEBRIS.test(joined)) return true

  const words = joined.split(/\s+/).filter(Boolean).length
  // Too short to judge: a two-line part can honestly carry no glossable term.
  if (words < 60) return false
  const glosses = joined.match(/\([^)]+\)/g)?.length ?? 0
  return (glosses / words) * 100 < definition.minGlossesPer100Words
}

/** Ignores case, accents and punctuation, so `L'API` and `api` compare equal. */
function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
}

/**
 * ${translation.glossLanguage} words that carry no vocabulary, so a gloss
 * consisting of nothing else is noise.
 *
 * Closed class and therefore safe to enumerate — these are function words, not
 * a judgement about what is "easy". A gloss is only dropped when it is *exactly*
 * one of them, so `food security` and `mission-driven` survive intact even
 * though they contain none of this list's business.
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'as', 'into', 'over', 'under', 'than', 'then', 'that', 'this', 'these',
  'those', 'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have',
  'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'may', 'might', 'must',
  'should', 'shall', 'not', 'no', 'so', 'such', 'their', 'they', 'we', 'our', 'you', 'your',
])

/**
 * Removes the two kinds of gloss that are wrong by construction: one that just
 * repeats the word in front of it, and one that is a bare function word.
 *
 * Both are forbidden by the prompt and the model produces them anyway. Observed
 * on 2026-07-28: `OlmoEarth (OlmoEarth)` and `2026 (2026)` in one run, and
 * `sont (are)`, `dans (in)`, `pour (to)` in the next — after the prompt had
 * already been strengthened against exactly those, which cut the density from
 * 47 glosses per 100 words to 29 without eliminating them. Densely glossing an
 * article asks for hundreds of these decisions in one response, and a rule
 * obeyed 99% of the time still leaves several per message.
 *
 * Deterministic here rather than a third instruction, because neither case needs
 * judgement: the same word twice teaches nothing, and `for` is not vocabulary.
 * Everything else is left exactly as written — a real gloss, a multi-word gloss,
 * and a gloss that merely shares a root all survive, so this can never remove
 * something the reader wanted.
 *
 * The elision split matters more than it looks: without it `L'API (API)` reads
 * as the word `L'API` glossed with `API`, which is not an echo and would slip
 * through — in French the article fuses to the noun and that is the common case.
 *
 * `normalizeWord` strips the italic underscores along with everything else that
 * is not a letter or digit, so this reads `(_released_)` and `(released)` the
 * same way and needs no separate case for the markup.
 *
 * Code is skipped entirely. A snippet is full of parenthesised tokens that look
 * exactly like glosses — `main()`, `parse (input)` — and rewriting one would
 * corrupt code the model was told to reproduce character for character.
 */
export function pruneGlosses(paragraph: string): string {
  return mapOutsideCode(paragraph, text =>
    text.replace(/([\p{L}\p{N}'’-]+)\s*\((_?[^)]+?_?)\)/gu, (match, word: string, gloss: string) => {
      const normalizedGloss = normalizeWord(gloss)
      if (FUNCTION_WORDS.has(normalizedGloss)) return word
      // Compare on the noun rather than the elided article: "L'API" is "API".
      const bare = word.split(/['’]/).at(-1) ?? word
      const normalizedWord = normalizeWord(bare)
      return normalizedWord && normalizedWord === normalizedGloss ? word : match
    }),
  )
}

/** Splits on fenced blocks and inline code, transforming only what is between them. */
function mapOutsideCode(text: string, transform: (prose: string) => string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : transform(segment)))
    .join('')
}
