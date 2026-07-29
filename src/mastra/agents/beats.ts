import { activeBeats } from '../../db/beats.js'

/**
 * The live beat list, rendered into Ava's per-turn system message.
 *
 * It used to be a module constant interpolated into her static instructions,
 * built from `CATEGORIES` at import. That cannot survive beats being rows: a
 * beat created this afternoon would be invisible to her until the process
 * restarted, and she would confidently describe a beat the reader had archived.
 *
 * It goes in the **second** system message, next to the notes, rather than into
 * the static prompt — the split exists so the long half stays byte-identical
 * between turns and remains a cacheable prefix, and a beat list that changes
 * would defeat that for the whole prompt rather than for the block that actually
 * moved.
 *
 * The slugs are rendered, not just the titles, because the news tools take a
 * beat *slug* and there is no longer an enum in their schema listing the valid
 * ones — that enum was fixed at boot for the same reason this block could not
 * be. This is now the only thing telling the model what a valid beat is.
 *
 * **Never throws.** A failed read here would take down a turn over the part of
 * it that is context; the same disposition as `memoryInstructions`, which
 * swallows the same error for the same reason.
 */
export async function beatInstructions(): Promise<string> {
  let beats: Awaited<ReturnType<typeof activeBeats>>
  try {
    beats = await activeBeats()
  } catch {
    return [
      '# Beats',
      'The beat list could not be read this turn. Answer without it, and do not say the reader ' +
      'has no beats — say you could not check.',
    ].join('\n\n')
  }

  if (beats.length === 0) {
    return [
      '# Beats',
      'There are no beats yet, so the pipeline has nothing to ingest and no digest will arrive. ' +
      'If they ask about news, say that outright rather than reporting an empty result.',
    ].join('\n\n')
  }

  const lines = beats.map(beat => `- \`${beat.slug}\` — ${beat.emoji} ${beat.title}`)
  return [
    '# Beats',
    'These are the beats the pipeline currently follows. The slug in backticks is what the news ' +
    'tools take as their `beat` argument — use it exactly, never the title.',
    lines.join('\n'),
  ].join('\n\n')
}
