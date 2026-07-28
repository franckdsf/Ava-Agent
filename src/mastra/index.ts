import { Mastra } from '@mastra/core'
import { ava, avaId } from './agents/ava.js'
import { curatorAgents } from './agents/curator.js'
import { registerChatCommands } from './channels.js'
import { storage } from './storage.js'
import { curateCategory } from './workflows/curate-category.js'
import { pruneItems } from './workflows/prune-items.js'

export const mastra = new Mastra({
  // Ava is registered alongside the curators, not instead of them: the curators
  // are internal pipeline steps with no channel, Ava is the only one with an
  // inbound surface.
  agents: { ...curatorAgents, [avaId]: ava },
  workflows: { curateCategory, pruneItems },
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
