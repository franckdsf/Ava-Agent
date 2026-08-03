import { Mastra } from '@mastra/core'
import { seedBeats } from '../db/beats.js'
import { seedJobSources } from '../db/jobs.js'
import { newy, newyId } from './agents/newy.js'
import { joob, joobId } from './agents/joob.js'
import { curatorAgents } from './agents/curator.js'
import { memoryReviewer, memoryReviewerId } from './agents/memory.js'
import { jobAgents } from './agents/job-scorer.js'
import { jobTargeterAgents } from './agents/job-targeter.js'
import { scoutAgents } from './agents/scout.js'
import { summarizer, summarizerId } from './agents/summarizer.js'
import { translator, translatorId } from './agents/translator.js'
import { catchUpOnBoot } from './boot-catchup.js'
import { registerChatCommands } from './channels.js'
import { registerJoobCommands } from './joob-channels.js'
import { storage } from './storage.js'
import { curateAll } from './workflows/curate-all.js'
import { findJobs } from './workflows/find-jobs.js'
import { discoverFeedsWorkflow } from './workflows/discover-feeds.js'
import { pruneArticles } from './workflows/prune-articles.js'
import { reviewFeedsWorkflow } from './workflows/review-feeds.js'
import { reviewMemoriesWorkflow } from './workflows/review-memories.js'

export const mastra = new Mastra({
  // Newy is registered alongside the curators, not instead of them: the curators
  // are internal pipeline steps with no channel, Newy is the only one with an
  // inbound surface. The memory reviewer is a third kind again: no channel and
  // no place in the news pipeline, woken once a week by its own workflow. The
  // translator and the summarizer are a fourth kind: no channel either, woken by
  // a slash command the adapter routes around Newy entirely. All of them are
  // registered here rather than constructed at their call site so they resolve
  // through `mastra.getAgent` like every other model call, and so their runs
  // show up in Studio.
  //
  // There are exactly two curator agents now, not two per beat. Building them
  // from a config array was what tied the agent set to boot time, and a beat the
  // reader creates at 3pm has to be rankable at 3pm
  // ([ADR-0019](../../docs/decisions/0019-beats-as-reader-owned-data.md)).
  agents: {
    ...curatorAgents,
    ...scoutAgents,
    ...jobTargeterAgents,
    ...jobAgents,
    [newyId]: newy,
    [joobId]: joob,
    [memoryReviewerId]: memoryReviewer,
    [translatorId]: translator,
    [summarizerId]: summarizer,
  },
  // `discoverFeeds` is the only one with no schedule: it runs because a reader
  // typed `/follow`, never on a clock. It is also the only workflow a
  // conversation may start, and it may write configuration only — see the
  // amended [invariant 8](../../AGENTS.md#invariants).
  workflows: {
    curateAll,
    findJobs,
    discoverFeeds: discoverFeedsWorkflow,
    pruneArticles,
    reviewFeeds: reviewFeedsWorkflow,
    reviewMemories: reviewMemoriesWorkflow,
  },
  storage,
})

// Writes the starter beats if the table is empty, so a fresh clone or a wiped
// development database comes up with something to read rather than a bot that
// cannot explain itself. A no-op on every boot after the first — the table is
// the authority once it has anything in it, and re-applying the seed would
// resurrect an archived beat and overwrite an edited rubric.
//
// Fire-and-forget with the same disposition as the channel registration below:
// the pipeline must still come up if this fails, and every repository call
// awaits its own `migrate()` anyway.
void seedBeats()
  .then(created => {
    if (created > 0) mastra.getLogger()?.info(`Seeded ${created} starter beats`)
  })
  .catch(error => {
    mastra.getLogger()?.error('Failed to seed starter beats', error)
  })

// Same disposition, for Joob's boards. Also a no-op after the first boot: the
// table is the authority once it holds anything, so editing
// `src/config/seed-job-sources.ts` does not reach a source that already exists.
void seedJobSources()
  .then(created => {
    if (created > 0) mastra.getLogger()?.info(`Seeded ${created} job sources`)
  })
  .catch(error => {
    mastra.getLogger()?.error('Failed to seed job sources', error)
  })

// Slash commands can only be registered on the live Chat SDK instance, which
// exists only once `AgentChannels.initialize()` has resolved. Registering the
// agent above already started that, so this awaits it rather than racing it.
// Fire-and-forget with the same disposition Mastra itself uses: a channel that
// fails to come up must not take the scheduled pipeline down with it.
void registerChatCommands(mastra, newy.getChannels()).catch(error => {
  mastra.getLogger()?.error('Failed to register Telegram commands', error)
})

// Joob's, against its own token. `getChannels()` is null while
// `JOOB_TELEGRAM_BOT_TOKEN` is unset and the registrar returns immediately, so
// this costs nothing until the bot is provisioned. Independent of Newy's on
// purpose: one bot failing to come up must not take the other's surface with it.
void registerJoobCommands(mastra, joob.getChannels()).catch(error => {
  mastra.getLogger()?.error("Failed to register Joob's Telegram commands", error)
})

// Fires whichever pipeline is past its own staleness bar — a week for news,
// three days for jobs — unless its next scheduled fire is minutes away. The two
// numbers differ because the cadences do: three digests a day against a run
// every two. Schedules survive a restart, which means
// nothing else in the process ever reads the gap a downtime leaves: the machine
// comes back knowing only when the next digest is due
// ([ADR-0025](../../docs/decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md)).
//
// Fire-and-forget for the same reason as everything above it, and it waits
// internally for the orchestration worker — this module is evaluated before the
// server starts one, and a `workflow.start` published into a pubsub nobody has
// subscribed to yet is dropped without a word.
void catchUpOnBoot(mastra).catch(error => {
  mastra.getLogger()?.error('Boot catch-up failed', error)
})
