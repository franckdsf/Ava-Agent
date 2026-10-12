import type { Agent } from '@mastra/core/agent'
import { joob } from './agents/joob.js'
import { newy } from './agents/newy.js'
import { JOOB_SURFACE } from './commands/joob.js'
import { NEWY_SURFACE } from './commands/newy.js'
import type { BotSurface } from './registrar.js'

/**
 * Every bot a reader talks to — its agent and its slash-command surface, one line each.
 *
 * `index.ts` registers each agent with Mastra and each surface with its own Chat SDK instance from
 * this list, so a third bot is a line here plus its files: a definition in `src/bots/`, an agent in
 * `agents/`, its commands in `commands/`.
 */
export const CHAT_BOTS: readonly { agent: Agent; surface: BotSurface }[] = [
  { agent: newy, surface: NEWY_SURFACE as BotSurface },
  { agent: joob, surface: JOOB_SURFACE as BotSurface },
]
