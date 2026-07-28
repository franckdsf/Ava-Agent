import { Mastra } from '@mastra/core'
import { ava, avaId } from './agents/ava.js'
import { curatorAgents } from './agents/curator.js'
import { memoryReviewer, memoryReviewerId } from './agents/memory.js'
import { translator, translatorId } from './agents/translator.js'
import { registerChatCommands } from './channels.js'
import { storage } from './storage.js'
import { curateCategory } from './workflows/curate-category.js'
import { pruneItems } from './workflows/prune-items.js'
import { reviewMemoriesWorkflow } from './workflows/review-memories.js'

export const mastra = new Mastra({
  // Ava is registered alongside the curators, not instead of them: the curators
  // are internal pipeline steps with no channel, Ava is the only one with an
  // inbound surface. The memory reviewer is a third kind again: no channel and
  // no place in the news pipeline, woken once a week by its own workflow. The
  // translator is a fourth: no channel either, woken by a slash command the
  // adapter routes around Ava entirely. Both are registered here rather than
  // constructed at their call site so they resolve through `mastra.getAgent`
  // like every other model call, and so their runs show up in Studio.
  agents: {
    ...curatorAgents,
    [avaId]: ava,
    [memoryReviewerId]: memoryReviewer,
    [translatorId]: translator,
  },
  workflows: { curateCategory, pruneItems, reviewMemories: reviewMemoriesWorkflow },
  storage,
})

// Slash commands can only be registered on the live Chat SDK instance, which
// exists only once `AgentChannels.initialize()` has resolved. Registering the
// agent above already started that, so this awaits it rather than racing it.
// Fire-and-forget with the same disposition Mastra itself uses: a channel that
// fails to come up must not take the scheduled pipeline down with it.
void registerChatCommands(mastra, ava.getChannels()).catch(error => {
  mastra.getLogger()?.error('Failed to register Telegram commands', error)
})
