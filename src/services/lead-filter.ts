import type { ClientProfile, Lead } from '../db/schema.js'

/**
 * The deterministic gate a lead passes before any model sees it
 * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * Two rules and no more, which is far less than `filterJob` applies — and the
 * asymmetry is deliberate rather than unfinished.
 *
 * **In the job pipeline, sources are broad and the filter does the narrowing.**
 * Here the narrowing is done by the *signal*: a company is only a candidate
 * because something dated happened to it inside `signalWindowDays`. Adding
 * criteria on top would spend the reader's coverage on rules that duplicate what
 * the signal already decided, and ADR-0028's lesson applies with full force — a
 * posting wrongly filtered is gone and the reader never learns it existed, while
 * one that survives the filter but not the batch cap is scored a day later.
 *
 * **Nothing here may read `lead.visionVerdict` or a scorer's reason.** That is
 * ADR-0026's rule and it is why this file imports no model output: the model
 * supplies prose, the web supplies facts, and a hard filter reading model-written
 * text lets a lead pass — or die — on invented evidence.
 */

export interface LeadFilterOutcome {
  keep: boolean
  /** Why it was rejected, recorded so a decision is answerable. Null when kept. */
  reason: string | null
}

/**
 * Everything about a lead that is a fact: its own words, off its own page.
 *
 * Company and location are included because a dealbreaker like "agencies" is as
 * likely to be in the name as in the body, and location is the only place a
 * geographic term reliably appears.
 */
function haystack(lead: Lead): string {
  return [lead.company, lead.location ?? '', lead.pageText ?? ''].join('\n').toLowerCase()
}

/**
 * Whether this lead is worth a model call for this profile.
 *
 * Order matters only for the reason string: dealbreakers are checked first
 * because "mentions crypto" is a more useful thing to read in a rejection log
 * than "outside the named locations".
 */
export function filterLead(lead: Lead, profile: ClientProfile): LeadFilterOutcome {
  const text = haystack(lead)

  /**
   * A term the reader said rules a company out. Literal, and literal on purpose:
   * these are their own words, and a synonym list would start rejecting on terms
   * they never typed.
   */
  const breaker = profile.dealbreakers.find(term => {
    const needle = term.trim().toLowerCase()
    return needle.length > 0 && text.includes(needle)
  })
  if (breaker) return { keep: false, reason: `mentions "${breaker}"` }

  /**
   * Locations, when the reader named any. **Empty means anywhere**, which is the
   * right and common answer for anyone working remotely.
   *
   * A lead with no location at all is **kept**, not rejected. Most company pages
   * never state where they are, and rejecting on a missing field would throw away
   * the majority of every batch on the strength of a fact nobody asserted — the
   * failure mode `flag:untagged` is deliberately let through for in the job
   * taxonomy.
   */
  if (profile.locations.length > 0) {
    const where = `${lead.location ?? ''}\n${lead.pageText ?? ''}`.toLowerCase()
    const stated = (lead.location ?? '').trim().length > 0
    const matches = profile.locations.some(place => {
      const needle = place.trim().toLowerCase()
      return needle.length > 0 && where.includes(needle)
    })
    if (stated && !matches) return { keep: false, reason: 'outside the named locations' }
  }

  return { keep: true, reason: null }
}

/**
 * Whether a stored vision verdict is still worth trusting.
 *
 * Kept here rather than in the workflow because it is the other half of the same
 * question — *does this lead need a model call?* — and because putting the two
 * together makes the expensive path readable in one place.
 */
export function visionIsStale(lead: Lead, staleDays: number, signalKind: string): boolean {
  if (!lead.visionVerdict || !lead.visionAt) return true
  // A rebrand or a launch is a claim that the visuals just changed, which is
  // exactly when a cached judgement is worth the least.
  if (signalKind === 'rebrand' || signalKind === 'launch') return true
  return Date.now() - lead.visionAt > staleDays * 86_400_000
}
