import { pipeline } from './pipeline.js'

/**
 * The translation commands, and the knobs behind them.
 *
 * Separate from `pipeline.ts` for the same reason `memory.ts` is: none of this
 * touches ingest, ranking or delivery. It governs a slash command on the
 * conversational surface — see
 * [ADR-0017](../../docs/decisions/0017-translation-commands.md).
 *
 * Commands are configuration, not code, in the same sense categories are
 * ([invariant 3](../../AGENTS.md#invariants)): the two below differ *only* in
 * how densely they gloss, so a third density is an entry in `TRANSLATIONS`, not
 * a second handler. If adding one ever means touching the agent or the command
 * dispatcher, the split is in the wrong place.
 */

/** Which command was typed. The key is the literal Telegram command. */
export type TranslationCommand = keyof typeof TRANSLATIONS

export interface TranslationDefinition {
  /**
   * The gloss rule, dropped verbatim into the model's message.
   *
   * Written as an instruction to the translator rather than a label, because a
   * label ("dense", "sparse") is a word the model has to interpret and these two
   * have to stay reliably distinguishable — the whole difference between the
   * commands lives in these two paragraphs.
   */
  gloss: string
  /** One line, shown by `/start` and by the unknown-command reply. */
  help: string
  /**
   * Glosses per 100 words below which the result is treated as a failed call and
   * retried once.
   *
   * A floor on *this command's whole point*, not a quality target. `/translearn`
   * returning ungloved prose has done nothing the reader asked for, so it is
   * worth one more call; `/translate` legitimately finds nothing worth glossing
   * in a passage, so its floor is zero and it never retries on density.
   */
  minGlossesPer100Words: number
}

export const TRANSLATIONS = {
  '/translearn': {
    gloss:
      'This is the study mode, so gloss at the reader\'s own level AND above. ' +
      'Include the words they probably already recognise but would not produce ' +
      'themselves — the ones worth reinforcing — alongside everything harder: ' +
      'precise or formal verbs, abstract and specialised nouns, evaluative ' +
      'adjectives and adverbs, technical terms, idioms, phrasal verbs, collocations ' +
      'and fixed expressions. Leave alone only what is well below their level: ' +
      'everyday verbs, common nouns, basic adjectives, the few thousand commonest ' +
      'words. Aim for four to eight glosses in an average paragraph — noticeably ' +
      'more than a reading aid would carry. When a word is borderline, gloss it: ' +
      'this mode errs toward more.',
    help: 'the article in your language, with the English behind every word worth learning.',
    /**
     * Was 10 when this glossed every content word and measured in the high
     * twenties per 100 words. Levelling the rule cut that by design — most of
     * what it used to gloss is below B2 — and a real run then measured **~3.6 per
     * 100 words**, so 10 would have retried every good translation and 3 was
     * close enough to trip on an ordinary one.
     *
     * One, because this is a floor against *nothing happening*, not a quality
     * target. The failure it catches returned 0.0 while echoing raw source, and
     * `RAW_DEBRIS` catches that case independently — this is the second lock, and
     * a second lock that fires on good input is worse than no second lock.
     *
     * **Re-measure whenever `readerLevel` changes.** A C1 reader needs fewer
     * glosses than a B1 one, so this floor is only meaningful relative to it.
     */
    minGlossesPer100Words: 1,
  },
  '/translate': {
    gloss:
      'This is the reading mode, so gloss only what is clearly ABOVE the reader\'s ' +
      'level — never at it. Two things qualify and nothing else. First, and always: ' +
      'the technical and domain vocabulary of this subject, which is the whole ' +
      'reason this mode exists — never let a passage of specialised writing go by ' +
      'with nothing marked. Second: ordinary words a reader at their level would ' +
      'genuinely have to look up. Everything they could already read unaided goes ' +
      'unglossed, including words they might not produce themselves. Aim for one or ' +
      'two glosses in an average paragraph. When an ordinary word is borderline, ' +
      'leave it — but a domain term is never borderline.',
    help: 'the article in your language, with only the key terms shown in English.',
    /**
     * Zero, so density never triggers a retry. A passage whose vocabulary sits
     * entirely at or below the reader's level should come back clean — retrying
     * that would spend a second call to force glosses the command exists to
     * withhold.
     */
    minGlossesPer100Words: 0,
  },
} as const satisfies Record<`/${string}`, TranslationDefinition>

export const translation = {
  /**
   * The language the glosses are in — what the reader is keeping an eye on.
   *
   * A constant rather than a per-command setting because it is not a preference:
   * every feed on every beat publishes in English, so the gloss is the *source*
   * word, not a second translation. Changing this would mean glossing with a
   * word that appears nowhere in the article.
   */
  glossLanguage: 'English',

  /**
   * How good the reader's English already is, on the CEFR scale
   * (A1, A2, B1, B2, C1, C2).
   *
   * **The single most useful knob here.** Without it the model glosses by word
   * *class* — every verb, every noun — and buries the words worth learning under
   * ones the reader has known for years: a real run produced
   * `vous n'avez (don't have)`, `est là (here)` and `petit (small)` for a B2
   * reader, which is the feature failing while looking like it works.
   *
   * A level, not a word list, because the judgement is per word in context and
   * the model already knows the CEFR bands. It is deliberately one setting rather
   * than one per command: it describes the *reader*, and both commands need the
   * same answer — they differ in how much to gloss, not in who is reading.
   *
   * Raising it makes glosses rarer and more specialised; lowering it makes them
   * denser. Re-measure `minGlossesPer100Words` after changing it — that floor is
   * only meaningful relative to this.
   */
  readerLevel: 'B2, approaching C1',

  /**
   * Target language when the notes say nothing about what the reader reads in.
   *
   * The real answer comes from Ava's notes — this is what a fresh database
   * falls back to, so the command works on day one rather than failing on a
   * fact nobody has told her yet.
   */
  fallbackLanguage: 'French',

  /**
   * Source characters handed to the model per call.
   *
   * The article is translated in sequence, one chunk per call, and each result
   * is sent as it lands. That bounds two different things at once: the output of
   * any single call stays well inside what a model will emit before truncating
   * — a densely glossed translation runs to roughly 2× its source — and the
   * reader sees the opening of the article in ~15s instead of waiting out the
   * whole piece in silence.
   *
   * Chunks split on paragraph boundaries, so this is a ceiling rather than a
   * stride; a chunk is usually smaller.
   *
   * Set against `telegramMaxMessageChars` rather than against a token budget:
   * dense glossing roughly doubles the text, so this has to leave room for 2×
   * plus the heading and footer inside one 3900-character message. A larger
   * chunk still arrives — it is split again on the way out — but then one
   * "part 2 of 4" is two messages and the numbering stops matching what the
   * reader sees, and worse, the second split is not markdown-aware: it can land
   * inside a fenced code block and break it.
   *
   * 1500 rather than 1800 because the output grew: every gloss now carries two
   * italic underscores, and markdown structure (`### `, `- `, fences) adds more.
   * At ~90 glosses per part that alone is ~180 characters that were not there
   * when this was first sized.
   */
  sourceChunkChars: 1_500,

  /**
   * Ceiling on the text one command will translate.
   *
   * Stored bodies are already capped at `articleMaxChars` on the way in, so this
   * binds only the loose paths — text typed after the command, or a quoted
   * message. Matching the store's cap keeps one number in the reader's head:
   * whatever the pipeline kept is what can be translated.
   */
  maxSourceChars: pipeline.articleMaxChars,
} as const
