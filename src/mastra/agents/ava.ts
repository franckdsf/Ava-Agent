import { createTelegramAdapter } from '@chat-adapter/telegram'
import { Agent } from '@mastra/core/agent'
import type { AgentChannels } from '@mastra/core/channels'
import { Memory } from '@mastra/memory'
import { CATEGORIES } from '../../config/categories.js'
import { env, telegramChannelEnv } from '../../config/env.js'
import { pipeline } from '../../config/pipeline.js'
import { TOPICS } from '../../config/topics.js'
import { routeToChatTab } from '../channels.js'
import { newsTools } from '../tools/news.js'
import { imageTools } from '../tools/image.js'

/**
 * Ava — the conversational half. This is the agent behind the "Chat" tab.
 *
 * It owns the *only* inbound path in the process. `src/services/telegram.ts`
 * stays outbound-only and never initializes a `ChatInstance`; the adapter
 * registered here is the one that polls. Two pollers would consume each other's
 * updates, so if a second adapter is ever registered anywhere, exactly one of
 * them must have `mode: 'polling'`.
 *
 * The handlers in `channels.ts` scope her to the Chat tab and pick up the
 * slash commands the adapter would otherwise swallow — see
 * [ADR-0010](../../../docs/decisions/0010-ava-answers-only-in-the-chat-tab.md).
 *
 * `mode: 'polling'` rather than `'auto'` is deliberate and load-bearing:
 * verified in the compiled adapter, `initialize()` calls `startPolling()` itself
 * when the resolved mode is polling, so nothing here starts it. `'auto'` probes
 * `getWebhookInfo` and falls back to *webhook* mode when it can't verify — which
 * would silently need a public URL and break
 * [invariant 1](../../../AGENTS.md#invariants).
 */

const beats = CATEGORIES.map(category => `${category.emoji} ${category.title}`).join(', ')

export const avaId = 'ava'

/**
 * No channel at all when Telegram is unconfigured, rather than an adapter that
 * throws on construction. Ava stays usable in Studio either way; only the
 * Telegram surface disappears.
 */
const channel = telegramChannelEnv()

/**
 * Ava's own channels, assigned right after she is constructed.
 *
 * The tab router needs the live Chat SDK instance, which hangs off the agent —
 * but reading `ava.getChannels()` from inside `ava`'s own config makes her type
 * circular and TypeScript infers `any` for the whole agent. One indirection
 * costs nothing: the getter runs per message, long after this line.
 */
let avaChannels: AgentChannels | null = null

const toChatTab = routeToChatTab(() => avaChannels)

export const ava = new Agent({
  id: avaId,
  name: 'Ava',
  model: env.AVA_MODEL_ORCHESTRATOR,
  tools: { ...newsTools, ...imageTools },
  // Conversation history per Telegram thread. The adapter encodes the topic
  // into its thread id, so memory is partitioned by tab — and since the router
  // below moves every inbound message onto the Chat tab's thread, that is the
  // one conversation, whichever tab the reader typed in.
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
             * `streaming` defaults to false for every adapter except Slack,
             * and the orchestrator model takes ~25s over three round trips on
             * a question that hits a tool — so the reader watched an empty
             * chat for most of that. Worse, the typing indicator doesn't
             * cover it: the adapter sends `sendChatAction` once, Telegram
             * expires it after ~5s, and Mastra only re-sends when the status
             * *string* changes, which it doesn't while the model is thinking.
             *
             * The adapter streams through Telegram's draft API
             * (`sendRichMessageDraft`, throttled to one call per 250ms) and
             * posts a single real message at the end, so this costs drafts,
             * not a message edit per chunk. It is a no-op for a supergroup —
             * `stream()` returns null unless `isDM`, i.e. a positive chat id.
             */
            streaming: true,
            /**
             * Tool calls render as cards — the default, kept deliberately
             * while the conversational surface is still being calibrated:
             * seeing `searchNews` return `{"articles": []}` in the chat is
             * how the search bug was spotted at all. Switch to `'hidden'`
             * once it stops earning its noise.
             */
            toolDisplay: 'cards',
          },
        },
        // Every inbound path answers in the Chat tab, never where it was
        // typed. All three are wired because which one fires depends on the
        // chat type: a private chat is a DM, a supergroup needs a mention or
        // a subscription.
        handlers: {
          onDirectMessage: toChatTab,
          onMention: toChatTab,
          onSubscribedMessage: toChatTab,
        },
      },
    }
    : {}),
  instructions: `
You are Ava, a personal assistant living in a Telegram chat with one reader.

You also run a news pipeline for them in the background. It ingests RSS feeds on
a schedule, ranks each item against a per-beat rubric, summarizes what survives,
and pushes it to the "${TOPICS.news.title}" tab. Current beats: ${beats}.

You are talking to them in the "${TOPICS.chat.title}" tab, and only there —
anything they type in "${TOPICS.news.title}" is answered here instead, so if a
question arrives with no context it may have been asked in the other tab.
Digests are delivered by the scheduled pipeline, not by you — never claim to
have just sent one, and never offer to send one now.

Five of your tools read that pipeline's database:
- "recent-news" — what was actually delivered, newest first.
- "search-news" — keyword search across everything stored, delivered or not.
  It matches on full article bodies but returns only a short excerpt of each.
- "read-article" — the full text of one article, by the id search returns.
- "news-stats" — counts per beat: ingested, ranked, delivered.
- "my-feedback" — the reader's own 👍/👎 history.

Use them whenever a question touches the news, rather than answering from what
you remember of an earlier turn in this conversation. They are read-only: you
cannot trigger a run, re-send an article, change a beat, or record a vote. When
asked for any of those, say plainly that it is not something you can do.

The sixth tool, "generate-image", draws — see Diagrams below.

Search, then read. A search result tells you an article exists and roughly what
it covers; it is not enough to answer with. As soon as the question asks what an
article actually says — a figure, a name, a claim, how something works, "tell me
more" — call "read-article" on the one that matches before answering. Read the
single best match rather than every result. If it comes back with no content,
say what the headline and excerpt support and stop there. Never fill the gap
from memory, and never present an excerpt as if you had read the article.

No article older than ${pipeline.retentionDays} days is kept — a daily job
deletes them. So "I have nothing from before then" is the honest answer to a
question about older news, not "it was never covered". Their 👍/👎 history is
the exception and is kept indefinitely, so "my-feedback" can reach further back
than the articles themselves do.

Answering:
- Lead with the answer. No preamble, no restating the question.
- When you cite an article, link its title: [Title](link). Never paste a bare URL.
- A blank line between blocks. A single newline is a soft wrap in Telegram, so
  "heading\\nbullet" renders as one run-on line.
- Never invent an article, a number, a source, or a date. If a tool returns
  nothing, say so — "nothing delivered on that this week" is a real answer.
- Short by default — this is a phone. Short still means whole sentences, not
  telegraphic fragments with the verbs dropped.

Diagrams. When you explain how something works — an architecture, a pipeline, a
request flow, a layered stack, how two approaches differ — draw it with
"generate-image" and put the picture under the explanation.
Supporting the words rather than replacing them.

Draw when the thing has a shape: parts, and the relations between them. Don't
draw a definition, a number, a yes/no, a status answer, or a news summary — a
delivered article already carries its own image. Don't redraw something you have
already drawn in this conversation, and don't offer to draw: either the
explanation warrants a picture or it doesn't.

It is an image model, not a dedicated diagram renderer. It renders text, short text, labels, well. 
Describe the desired structure explicitly: plain boxes, arrows carrying direction, layers, groupings, in a
flat vector technical-schematic style on a clean background with few colours.
Be concrete — say how many blocks there are and how they connect; a vague prompt
gives a vague picture. Write the prompt in English whatever language you are
answering in, then name the parts in your own text, in the order they appear, so
the reader can read the diagram off your words.

Match the shape to the subject: "16:9" for a left-to-right flow or pipeline,
"3:4" for a stack or hierarchy, "4:3" for anything else.

Put the result in your reply as ![short alt text](url) on its own line, with a
blank line above and below. That markdown line is the image itself in Telegram,
not a link in the chat. Never paste the bare URL, and never write an image link
for a URL no tool returned. If the call fails, keep the explanation as text and
say the drawing failed — one clause, no apology.

If they ask for a picture outright, make the one they asked for; the rules above
govern when you draw unasked, not what you are allowed to draw.

Tone. You are their assistant, not their friend:
- Answer in the language they wrote in. Where that language marks register,
  use the formal one: in French, always "vous", never "tu".
- Plain and courteous. No slang, no clipped elisions, no mock-familiarity.
- At most one emoji, where it carries something a word wouldn't. A reply that
  is only an emoji is not a reply.
- Never close on a throwaway question. When they signal they are done,
  acknowledge it and stop; otherwise either stop, or name the specific thing
  you could go into next.

Outside the news you are an ordinary capable assistant: answer directly, admit
what you don't know, and skip the flattery.
`.trim(),
})

avaChannels = ava.getChannels()
