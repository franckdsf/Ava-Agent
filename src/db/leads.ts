import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { leadPipeline, type LeadSignalKind } from '../config/leads.js'
import { db, migrate } from './client.js'
import {
  clientProfiles,
  leadDeliveries,
  leadMatches,
  leadSignals,
  leads,
  type ClientProfile,
  type Lead,
  type LeadSignal,
  type NewClientProfile,
  type NewLead,
  type NewLeadSignal,
} from './schema.js'

/**
 * Reads and writes the lead tables
 * ([ADR-0038](../../docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)).
 *
 * Mirrors `src/db/jobs.ts` in shape — insert-many ignoring conflicts, list
 * unscored, save verdicts, mark delivered — because the stages are the same.
 * **What differs is the delivery ledger, and it differs on purpose.** There, one
 * identity is delivered once and never again. Here the ledger is keyed
 * `(leadId, signalId)` so a *new reason* to contact a known company can reach the
 * reader, and a cooldown rather than the key is what stops a company arriving
 * three times in a week.
 *
 * Nothing in this file reads or writes a job table. The one place the two
 * pipelines meet is `hiringSignalsFromJobs`, which selects from `jobs`
 * **read-only**.
 */

// --- Client profiles -------------------------------------------------------

/** Every profile still being prospected for. */
export async function activeProfiles(): Promise<ClientProfile[]> {
  await migrate()
  return db()
    .select()
    .from(clientProfiles)
    .where(isNull(clientProfiles.archivedAt))
    .orderBy(asc(clientProfiles.createdAt))
}

/** Every profile, archived ones included, for `/clients`. */
export async function allProfiles(): Promise<ClientProfile[]> {
  await migrate()
  return db().select().from(clientProfiles).orderBy(asc(clientProfiles.createdAt))
}

export async function getProfile(slug: string): Promise<ClientProfile | null> {
  await migrate()
  const [row] = await db()
    .select()
    .from(clientProfiles)
    .where(eq(clientProfiles.slug, slug))
    .limit(1)
  return row ?? null
}

/**
 * Writes a profile, keeping `createdAt` and `fitThreshold` when one already
 * exists.
 *
 * `fitThreshold` is preserved rather than overwritten for the reason ADR-0036
 * gives about `/retarget`: a threshold the reader tuned by hand is not something
 * a re-parse of their *wording* knows about. Re-describing who you want to work
 * with should not silently reset how strict you were being.
 */
export async function upsertProfile(profile: NewClientProfile): Promise<void> {
  await migrate()
  await db()
    .insert(clientProfiles)
    .values(profile)
    .onConflictDoUpdate({
      target: clientProfiles.slug,
      set: {
        label: profile.label,
        request: profile.request,
        offer: profile.offer,
        industries: profile.industries,
        locations: profile.locations,
        signalKinds: profile.signalKinds,
        dealbreakers: profile.dealbreakers,
        minDealSize: profile.minDealSize ?? null,
        currency: profile.currency ?? null,
        notes: profile.notes ?? null,
        updatedAt: profile.updatedAt,
        // Un-archives, so `/client` on an archived slug resumes it rather than
        // writing a row that silently never runs.
        archivedAt: null,
      },
    })
}

/** Archives a profile. Nothing already delivered is lost. */
export async function archiveProfile(slug: string): Promise<boolean> {
  await migrate()
  const result = await db()
    .update(clientProfiles)
    .set({ archivedAt: Date.now() })
    .where(and(eq(clientProfiles.slug, slug), isNull(clientProfiles.archivedAt)))
  return (result.rowsAffected ?? 0) > 0
}

// --- Leads and signals -----------------------------------------------------

/**
 * Inserts leads, ignoring ones already known, and bumps `lastSignalAt` on those.
 *
 * The bump matters more than it looks: retention is measured from the last
 * signal, so a company that keeps producing events stays warm and one that goes
 * quiet for half a year is pruned. Nothing else on an existing row is
 * overwritten here — the resolved page and the vision verdict are expensive and
 * are refreshed deliberately, not as a side effect of a new signal.
 */
export async function upsertLeads(rows: NewLead[]): Promise<number> {
  if (rows.length === 0) return 0
  await migrate()
  let inserted = 0
  for (const row of rows) {
    const result = await db()
      .insert(leads)
      .values(row)
      .onConflictDoUpdate({
        target: leads.id,
        set: {
          lastSignalAt: sql`max(${leads.lastSignalAt}, ${row.lastSignalAt})`,
          company: sql`coalesce(nullif(${leads.company}, ''), ${row.company})`,
        },
      })
    inserted += result.rowsAffected ?? 0
  }
  return inserted
}

/** Stores what a page resolution found. Separate from the upsert above — it costs a fetch. */
export async function saveLeadPage(
  leadId: string,
  pageText: string,
  location: string | null,
): Promise<void> {
  await migrate()
  await db()
    .update(leads)
    .set({ pageText, pageFetchedAt: Date.now(), ...(location ? { location } : {}) })
    .where(eq(leads.id, leadId))
}

/** Stores a vision verdict, so it is paid for once per company rather than per signal. */
export async function saveVisionVerdict(leadId: string, verdict: string): Promise<void> {
  await migrate()
  await db()
    .update(leads)
    .set({ visionVerdict: verdict, visionAt: Date.now() })
    .where(eq(leads.id, leadId))
}

/** Inserts signals, ignoring ones already seen. The id already collapses syndication. */
export async function insertSignals(rows: NewLeadSignal[]): Promise<number> {
  if (rows.length === 0) return 0
  await migrate()
  const result = await db().insert(leadSignals).values(rows).onConflictDoNothing()
  return result.rowsAffected ?? 0
}

export async function getLeads(ids: string[]): Promise<Lead[]> {
  if (ids.length === 0) return []
  await migrate()
  return db().select().from(leads).where(inArray(leads.id, ids))
}

/**
 * Signals recent enough to act on, of the kinds this profile cares about, whose
 * `(lead, signal, profile)` has not been scored yet.
 *
 * The window is the narrowing. Lead intake is otherwise unbounded — every
 * company on the web — and this is where "why now" becomes a `WHERE` clause.
 */
export async function listUnscoredSignals(
  profileSlug: string,
  kinds: LeadSignalKind[],
  limit: number,
): Promise<LeadSignal[]> {
  await migrate()
  const cutoff = Date.now() - leadPipeline.signalWindowDays * 86_400_000

  const scored = db()
    .select({ signalId: leadMatches.signalId })
    .from(leadMatches)
    .where(eq(leadMatches.profileSlug, profileSlug))

  const conditions = [
    gte(leadSignals.occurredAt, cutoff),
    sql`${leadSignals.id} not in ${scored}`,
  ]
  if (kinds.length > 0) conditions.push(inArray(leadSignals.kind, kinds))

  return db()
    .select()
    .from(leadSignals)
    .where(and(...conditions))
    // Recency, which ADR-0038 makes the batch ordering: "raised last week" beats
    // "raised in March", and portfolio overlap answers a question that is already
    // true of every lead.
    .orderBy(desc(leadSignals.occurredAt))
    .limit(limit)
}

/** Writes one batch of verdicts. Unscored and scored-zero stay distinguishable. */
export async function saveLeadVerdicts(
  profileSlug: string,
  verdicts: {
    leadId: string
    signalId: string
    fit: number
    reason: string
    mismatches: string[]
  }[],
): Promise<void> {
  if (verdicts.length === 0) return
  await migrate()
  const now = Date.now()
  for (const verdict of verdicts) {
    await db()
      .insert(leadMatches)
      .values({
        leadId: verdict.leadId,
        signalId: verdict.signalId,
        profileSlug,
        fit: verdict.fit,
        reason: verdict.reason,
        mismatches: verdict.mismatches,
        scoredAt: now,
      })
      .onConflictDoUpdate({
        target: [leadMatches.leadId, leadMatches.signalId, leadMatches.profileSlug],
        set: {
          fit: verdict.fit,
          reason: verdict.reason,
          mismatches: verdict.mismatches,
          scoredAt: now,
        },
      })
  }
}

/** Stores the outreach angle beside the verdict, so it survives without a second call. */
export async function saveLeadAngle(
  leadId: string,
  signalId: string,
  profileSlug: string,
  angle: string,
): Promise<void> {
  await migrate()
  await db()
    .update(leadMatches)
    .set({ angle })
    .where(
      and(
        eq(leadMatches.leadId, leadId),
        eq(leadMatches.signalId, signalId),
        eq(leadMatches.profileSlug, profileSlug),
      ),
    )
}

export interface ScoredLead {
  leadId: string
  signalId: string
  fit: number
  reason: string
  mismatches: string[]
}

/** Scored above the bar and not yet delivered, best first. */
export async function listDeliverable(
  profileSlug: string,
  threshold: number,
  limit: number,
): Promise<ScoredLead[]> {
  await migrate()
  const delivered = db().select({ signalId: leadDeliveries.signalId }).from(leadDeliveries)

  const rows = await db()
    .select({
      leadId: leadMatches.leadId,
      signalId: leadMatches.signalId,
      fit: leadMatches.fit,
      reason: leadMatches.reason,
      mismatches: leadMatches.mismatches,
    })
    .from(leadMatches)
    .where(
      and(
        eq(leadMatches.profileSlug, profileSlug),
        gte(leadMatches.fit, threshold),
        sql`${leadMatches.signalId} not in ${delivered}`,
      ),
    )
    .orderBy(desc(leadMatches.fit))
    .limit(limit)

  return rows.map(row => ({
    leadId: row.leadId,
    signalId: row.signalId,
    fit: row.fit ?? 0,
    reason: row.reason ?? '',
    mismatches: row.mismatches ?? [],
  }))
}

/**
 * Lead ids messaged inside the cooldown, whatever the signal.
 *
 * **This is the bound that `job_deliveries`'s key provides for jobs.** The ledger
 * here deliberately admits a second delivery for a new signal, so without this a
 * company that raised, launched and posted a role in one week would arrive three
 * times in three days and read as a broken bot.
 */
export async function inCooldown(): Promise<Set<string>> {
  await migrate()
  const cutoff = Date.now() - leadPipeline.cooldownDays * 86_400_000
  const rows = await db()
    .selectDistinct({ leadId: leadDeliveries.leadId })
    .from(leadDeliveries)
    .where(gte(leadDeliveries.deliveredAt, cutoff))
  return new Set(rows.map(row => row.leadId))
}

/**
 * Claims a delivery **before** it is sent, returning whether this caller won it.
 *
 * The discipline [ADR-0033](../../docs/decisions/0033-a-delivery-is-claimed-before-it-is-sent.md)
 * established: stamping after a successful send leaves a window where two runs
 * both believe a lead is undelivered. `onConflictDoNothing` makes the claim the
 * decision — a row that was already there means someone else is sending it.
 */
export async function claimLeadDelivery(entry: {
  leadId: string
  signalId: string
  company: string
  url: string
  profileSlug: string
  signalKind: string
}): Promise<boolean> {
  await migrate()
  const result = await db()
    .insert(leadDeliveries)
    .values({ ...entry, deliveredAt: Date.now() })
    .onConflictDoNothing()
  return (result.rowsAffected ?? 0) > 0
}

/** Releases a claim whose send failed, so the next run may try again. */
export async function releaseLeadDelivery(leadId: string, signalId: string): Promise<void> {
  await migrate()
  await db()
    .delete(leadDeliveries)
    .where(and(eq(leadDeliveries.leadId, leadId), eq(leadDeliveries.signalId, signalId)))
}

/**
 * Drops leads with no signal for `retentionDays`, and their signals and matches.
 *
 * `lead_deliveries` is **never pruned** — it is the permanent record of what the
 * reader was actually shown, and it is small because it only grows when
 * something reached them. Same argument `job_deliveries` and `feedback` make.
 */
export async function pruneLeads(): Promise<number> {
  await migrate()
  const cutoff = Date.now() - leadPipeline.retentionDays * 86_400_000
  const stale = await db()
    .select({ id: leads.id })
    .from(leads)
    .where(lt(leads.lastSignalAt, cutoff))
  const ids = stale.map(row => row.id)
  if (ids.length === 0) return 0

  await db().delete(leadMatches).where(inArray(leadMatches.leadId, ids))
  await db().delete(leadSignals).where(inArray(leadSignals.leadId, ids))
  const result = await db().delete(leads).where(inArray(leads.id, ids))
  return result.rowsAffected ?? 0
}

export async function leadCounts(): Promise<{
  leads: number
  signals: number
  delivered: number
  profiles: number
}> {
  await migrate()
  const count = sql<number>`count(*)`
  const [leadRow] = await db().select({ n: count }).from(leads)
  const [signalRow] = await db().select({ n: count }).from(leadSignals)
  const [deliveredRow] = await db().select({ n: count }).from(leadDeliveries)
  const [profileRow] = await db()
    .select({ n: count })
    .from(clientProfiles)
    .where(isNull(clientProfiles.archivedAt))
  return {
    leads: leadRow?.n ?? 0,
    signals: signalRow?.n ?? 0,
    delivered: deliveredRow?.n ?? 0,
    profiles: profileRow?.n ?? 0,
  }
}
