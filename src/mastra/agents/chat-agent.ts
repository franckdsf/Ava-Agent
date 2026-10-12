import { createTelegramAdapter } from '@chat-adapter/telegram'
import { Agent, type AgentConfig } from '@mastra/core/agent'
import type { AgentChannels, ChannelHandler } from '@mastra/core/channels'
import { Memory } from '@mastra/memory'
import { env, telegramChannelEnv } from '../../config/env.js'
import { routeToChatTab, type ChatSurface } from '../chat-surface.js'

/**
 * Every conversational agent, built once from its bot.
 *
 * Newy and Joob were constructed by two copies of the same block — 65% of each file after
 * normalising names ([03 F3](../../../docs/audit/03-FLAWS.md#-f3--a-bot-is-four-copied-files)).
 * What is genuinely an agent's own is its prompt, its tools and, for Newy, what she does to an
 * inbound message before routing it. Everything else is the same for every agent that talks, and
 * lives here so a fix reaches all of them.
 */

export interface ChatAgentSpec {
  /** The display name — `Newy`. The id is the bot's. */
  name: string
  tools: AgentConfig['tools']
  /**
   * Rebuilt on every turn, because part of it is what is currently known about the reader
   * ([ADR-0014](../../../docs/decisions/0014-two-tier-memory-for-ava.md)). Return the static half
   * as its own system message: it stays byte-identical between turns and remains a cacheable
   * prompt prefix, while only the volatile block changes.
   */
  instructions: AgentConfig['instructions']
  /** Applied to the inbound handler after routing is built — Newy's swipe-to-reply note. */
  inbound?: (handler: ChannelHandler) => ChannelHandler
}

/**
 * The agent behind one bot: its polling adapter, its memory, and routing to its chat tab.
 *
 * **It polls its own token, in `mode: 'polling'`.** Two adapters on one token would share a
 * `getUpdates` offset and eat each other's updates; one agent per bot is
 * [invariant 7](../../../AGENTS.md#invariants). `'auto'` falls back to *webhook* when it cannot
 * verify `getWebhookInfo`, which silently breaks invariant 1. Every conversational agent's adapter
 * is built here, so the rule is held in one place.
 *
 * **No channel at all when the bot's token is unset**, rather than an adapter that throws on
 * construction. That is the normal state for a bot until it is provisioned in BotFather, and it
 * must not take the other bot or a pipeline down.
 */
export function createChatAgent<Slug extends string>(surface: ChatSurface<Slug>, spec: ChatAgentSpec): Agent {
  const channel = telegramChannelEnv(surface.bot)

  // The router needs this agent's channels, which exist only once the agent does. Reading
  // `agent.getChannels()` from inside its own config makes its type circular, so the getter reads
  // a variable assigned right after construction — long before any message can arrive.
  let channels: AgentChannels | null = null
  const routed = routeToChatTab(surface, () => channels)
  const toChatTab = spec.inbound ? spec.inbound(routed) : routed

  const agent = new Agent({
    id: surface.bot.id,
    name: spec.name,
    // The shared conversational knob, as ADR-0022 specified: it names the model a reader talks
    // to, whichever agent is doing the talking. An agent earns its own variable the day it needs
    // a different model for a reason of its own.
    model: env.AVA_MODEL_ORCHESTRATOR,
    tools: spec.tools,
    // Conversation history per Telegram thread. The adapter encodes the topic into its thread id,
    // so memory is partitioned by tab — and since the router moves every inbound message onto the
    // chat tab's thread, that is the one conversation, whichever tab the reader typed in.
    memory: new Memory({
      options: {
        lastMessages: 30,
      },
    }),
    ...(channel
      ? {
        channels: {
          adapters: {
            telegram: {
              adapter: createTelegramAdapter({
                botToken: channel.botToken,
                allowedUserIds: channel.allowedUserIds,
                mode: 'polling',
              }),
              /**
               * Stream the reply instead of posting it once at the end.
               *
               * `streaming` defaults to false for every adapter except Slack, and the
               * orchestrator model takes ~25s over three round trips on a question that hits a
               * tool — so the reader watched an empty chat for most of that. Worse, the typing
               * indicator doesn't cover it: the adapter sends `sendChatAction` once, Telegram
               * expires it after ~5s, and Mastra only re-sends when the status *string* changes,
               * which it doesn't while the model is thinking.
               *
               * The adapter streams through Telegram's draft API (`sendRichMessageDraft`,
               * throttled to one call per 250ms) and posts a single real message at the end, so
               * this costs drafts, not a message edit per chunk. It is a no-op for a supergroup —
               * `stream()` returns null unless `isDM`, i.e. a positive chat id.
               */
              streaming: true,
              /**
               * Tool calls stay out of the chat. `'cards'` is the default and was kept
               * deliberately while the conversational surface was being calibrated — seeing
               * `searchNews` return `{"articles": []}` in the chat is how the search bug was
               * spotted at all — but that was a debugging affordance shown to a reader, and it
               * stopped earning its noise once the tools settled.
               *
               * It hides the display, not the call: the model still searches and reads, and its
               * answer is unchanged. Turn it back to `'cards'` for a session when a reply looks
               * like it answered from the wrong tool.
               */
              toolDisplay: 'hidden',
            },
          },
          // Every inbound path answers in the chat tab, never where it was typed. All three are
          // wired because which one fires depends on the chat type: a private chat is a DM, a
          // supergroup needs a mention or a subscription.
          handlers: {
            onDirectMessage: toChatTab,
            onMention: toChatTab,
            onSubscribedMessage: toChatTab,
          },
        },
      }
      : {}),
    instructions: spec.instructions,
    /**
     * On the agent, not on `instructions` — a `providerOptions` block written there is dropped
     * before the request is built, so it reaches nothing.
     *
     * `sort: 'price'` sends each request to the cheapest endpoint first, and `allow_fallbacks`
     * moves on to the next one when it fails. Reasoning is high because this is the surface a
     * person is talking to and a wrong answer costs more than a slow one — measured at 41
     * reasoning tokens against 32 with the field absent on `minimax-m3`, so it was close to free
     * there; not yet re-measured on `deepseek-v4.1-flash`. It does not fix the truncated-reply
     * gotcha; nothing in this block does.
     */
    defaultOptions: {
      providerOptions: {
        openrouter: {
          reasoning: { effort: 'high' },
          provider: {
            sort: 'price',
            allow_fallbacks: true,
            require_parameters: false,
          },
        },
      },
    },
  })

  channels = agent.getChannels()
  return agent
}
