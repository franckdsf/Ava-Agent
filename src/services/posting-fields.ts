import { jobPipeline } from '../config/jobs.js'

/**
 * The field normalizers every job source shares — the ATS adapters in `ats.ts`,
 * the boards in `job-fetch.ts` and the HN thread in `job-hn.ts`, which each had
 * their own copy.
 *
 * A leaf on purpose: `job-fetch` imports `ats`, so a helper living in either
 * would make the other reach back across that edge (C2).
 */

/** A trimmed string, or null for anything that isn't one or is blank. */
export const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** A description cut to `jobPipeline.maxDescriptionChars`. */
export const truncate = (value: string | null): string | null =>
  value === null ? null : value.slice(0, jobPipeline.maxDescriptionChars)

/**
 * Parses a date a board printed, in whatever form, to epoch ms or null. A number
 * is taken as seconds below 1e12 — boards send both.
 */
export function parseDate(value: unknown): number | null {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}
