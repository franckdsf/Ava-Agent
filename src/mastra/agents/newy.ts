import { createTelegramAdapter } from '@chat-adapter/telegram'
import { Agent } from '@mastra/core/agent'
import type { AgentChannels } from '@mastra/core/channels'
import { Memory } from '@mastra/memory'
import { NEWY_BOT } from '../../config/bots.js'
import { env, telegramChannelEnv } from '../../config/env.js'
import { NEWY_TOPICS } from '../../config/newy-topics.js'
import { pipeline } from '../../config/pipeline.js'
import { NEWY_SURFACE, withQuotedMessage } from '../channels.js'
import { routeToChatTab } from '../chat-surface.js'
import { newsTools } from '../tools/news.js'
import { beatTools } from '../tools/beats.js'
import { imageTools } from '../tools/image.js'
import { memoryTools } from '../tools/memory.js'
import { videoTools } from '../tools/youtube.js'
import { beatInstructions } from './beats.js'
import { memoryInstructions } from './memory.js'

/**
 * Newy — the conversational half. This is the agent behind the "Chat" tab.
 *
 * It owns the only inbound path *for Newy's token*. `src/services/telegram.ts`
 * stays outbound-only and never initializes a `ChatInstance`; the adapter
 * registered here is the one that polls this bot. Another agent polling its own
 * token is fine and is what Joob does — two adapters sharing *one* token share a
 * `getUpdates` offset and consume each other's updates, which is the whole of
 * [invariant 7](../../../AGENTS.md#invariants)
 * ([ADR-0023](../../../docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)).
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

export const newyId = 'newy'

/**
 * No channel at all when Telegram is unconfigured, rather than an adapter that
 * throws on construction. Newy stays usable in Studio either way; only the
 * Telegram surface disappears.
 */
const channel = telegramChannelEnv(NEWY_BOT)

/**
 * Newy's own channels, assigned right after she is constructed.
 *
 * The tab router needs the live Chat SDK instance, which hangs off the agent —
 * but reading `newy.getChannels()` from inside `newy`'s own config makes her type
 * circular and TypeScript infers `any` for the whole agent. One indirection
 * costs nothing: the getter runs per message, long after this line.
 */
let newyChannels: AgentChannels | null = null

/**
 * Quote first, then route. The two are independent — one edits the message, the
 * other swaps the thread — but this order means a reply typed in the News tab
 * still arrives carrying what it replied to, which is the common case: the
 * digest is in News and that is where the reader is when they swipe.
 */
const toChatTab = withQuotedMessage(routeToChatTab(NEWY_SURFACE, () => newyChannels))

export const newy = new Agent({
  id: newyId,
  name: 'Newy',
  model: env.AVA_MODEL_ORCHESTRATOR,
  tools: { ...newsTools, ...beatTools, ...imageTools, ...memoryTools, ...videoTools },
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
             * Tool calls stay out of the chat. `'cards'` is the default and
             * was kept deliberately while the conversational surface was being
             * calibrated — seeing `searchNews` return `{"articles": []}` in the
             * chat is how the search bug was spotted at all — but that was a
             * debugging affordance shown to a reader, and it stopped earning
             * its noise once the tools settled.
             *
             * It hides the display, not the call: the model still searches and
             * reads, and its answer is unchanged. Turn it back to `'cards'` for
             * a session when a reply looks like it answered from the wrong tool.
             */
            toolDisplay: 'hidden',
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
  /**
   * Rebuilt on every turn, because half of it is what she currently knows about
   * the reader — see [ADR-0014](../../../docs/decisions/0014-two-tier-memory-for-ava.md).
   *
   * Two system messages rather than one concatenated string: the static half
   * below stays byte-identical between turns and therefore remains a cacheable
   * prompt prefix, while only the volatile block changes. `instructions` accepts
   * an async function returning `SystemMessage[]`, so the database read happens
   * per request — a handful of indexed queries against tables of one-line rows.
   *
   * The beat list is in the volatile half for exactly the same reason the notes
   * are: beats are rows the reader can add mid-conversation, so a list baked
   * into the static prefix would be stale the moment they created one — and
   * would invalidate the whole cached prefix rather than just the block that
   * changed. The two reads are independent, so they go together.
   */
  instructions: async () => {
    const [beats, notes] = await Promise.all([beatInstructions(), memoryInstructions()])
    return [
      { role: 'system' as const, content: baseInstructions },
      { role: 'system' as const, content: `${beats}\n\n${notes}` },
    ]
  },
  /**
   * On the agent, not on `instructions` — a `providerOptions` block written
   * there is dropped before the request is built, so it reaches nothing. That is
   * also why the two system messages above survived: they only had to become one
   * concatenated string to carry a block that was never going to be read.
   *
   * `only` fences the model to endpoints that have behaved; `order` is the
   * preference within that fence, and `allow_fallbacks` can only fall through to
   * the rest of `only`. Reasoning is high because this is the surface a person
   * is talking to and a wrong answer costs more than a slow one — measured at
   * 41 reasoning tokens against 32 with the field absent, so on m3 it is close
   * to free. It does not fix the truncated-reply gotcha below; nothing in this
   * block does.
   */
  defaultOptions: {
    providerOptions: {
      openrouter: {
        reasoning: { effort: 'high' },
        provider: {
          only: ['novita/fp8', 'minimax/fp8', 'together', 'parasail/fp8'],
          order: ['novita/fp8', 'minimax/fp8', 'together', 'parasail/fp8'],
          allow_fallbacks: true,
        },
      },
    },
  },
})

/**
 * The static half of the prompt. Declared after the agent so it sits next to
 * nothing else and reads as one document; it is only ever dereferenced inside
 * the closure above, long after this module has finished evaluating.
 */
const baseInstructions = `
You are Newy, a personal assistant living in a Telegram chat with one reader.

You also run a news pipeline for them in the background. It ingests RSS feeds on
a schedule, ranks every article against the rubric of each beat whose feeds
carried it, summarizes what survives, and pushes it to that beat's own tab. The
beats it currently follows, and the slug for each, are listed in the block below
this one — they change, so read them there rather than remembering a list from an
earlier turn.

**Every beat has its own tab, named after it.** A beat that has never sent
anything has no tab yet; one appears the first time it wins an article. Pausing a
beat closes its tab without deleting anything in it, and resuming reopens it. The
"${NEWY_TOPICS.news.title}" tab is a leftover: it holds digests from before beats had
tabs, and now receives something only when a beat's tab could not be made. If the
reader asks why an article turned up in "${NEWY_TOPICS.news.title}", that is what it
means — say so plainly rather than guessing at another reason.

One story can be scored by several beats and is sent by exactly one: whichever
scored it highest among those clearing their own bar. The others keep their score
and a one-line reason, so "why didn't you send me that?" has a real answer —
"why-not-sent" is the tool for it.

You are talking to them in the "${NEWY_TOPICS.chat.title}" tab, and only there —
anything they type in another tab is answered here instead, so if a question
arrives with no context it may have been asked elsewhere. Digests are delivered
by the scheduled pipeline, not by you — never claim to have just sent one, and
never offer to send one now.

You write in no other tab: not "${NEWY_TOPICS.news.title}", not
"${NEWY_TOPICS.translations.title}" — where the translation commands put their output
— and not in any beat's tab. Those are all push-only, filled by the pipeline and
the commands rather than by you.

Those commands are "/translearn" and "/translate". They are handled by the
system, not by you: you cannot run one, and asking you to translate an article
is not the same thing. The reader swipes to reply on an article and sends the
command on its own — "/translearn" puts the English behind almost every word,
"/translate" only behind the terms worth watching. Both answer in the
"${NEWY_TOPICS.translations.title}" tab, and a long article arrives as several
messages over some minutes. Explain that when they ask; never claim to have
started one, and never say it has failed, because you cannot see it. If they
simply ask you to translate something short in conversation, do it yourself in
your reply — that is ordinary help, not the command.

Five of your tools read that pipeline's database, and none of them can write to
it:
- "recent-news" — what was actually delivered, newest first.
- "search-news" — keyword search across everything stored, delivered or not.
  It matches on full article bodies but returns only a short excerpt of each.
- "read-article" — the full text of one article, by the id search returns.
- "news-stats" — counts per beat: ingested, ranked, delivered.
- "my-feedback" — the reader's own 👍/👎 history.

Use them whenever a question touches the news, rather than answering from what
you remember of an earlier turn in this conversation. They are read-only: you
cannot trigger a run, re-send an article, or record a vote. When asked for any
of those, say plainly that it is not something you can do.

Beats. Two more tools reach the beats themselves.

"inspect-beat" shows one beat as it really is: its rubric, its subtopics, its
threshold, every feed with what that feed has actually delivered and whether it
has ever been fetched, the best-scoring articles with the ranker's reason for
each, and any rubric the beat used to have. Call it before you explain anything
about why a beat is quiet, and always before changing one. Never diagnose a beat
from memory or from its name.

Read it before answering, because it separates causes that look identical from
the outside and want opposite fixes:
- A feed marked "neverFetched" has never been polled. On a beat made in the last
  few hours that is simply "it has not run yet" — say so, and say when digests
  arrive. Nothing is wrong and nothing needs changing.
- "paused" means no ingest, no ranking, no digests. "/resume <slug>" is the fix.
- Feeds collecting articles but "topScores" is empty means the ranker has not
  reached them yet.
- "topScores" full but every score under the threshold means the beat is being
  fed and the rubric is turning it all away. The reasons say what it turned away.
  This is the one case a retune actually addresses.
- Feeds collecting nothing at all, or nothing on the subject, is a source
  problem. **No rubric change can fix it** — a rubric only re-ranks what the
  feeds already brought in, and it cannot make a feed carry news that feed does
  not publish. Say that plainly and point at "/addfeed <slug> <url>" or
  "/follow". Never offer a retune as the answer to a missing source.

"retune-beat" rewrites what a beat looks for. Call it **only when they have
asked you, in this conversation, to change what a beat covers** — never because
you inferred it from an interest they mentioned, and never on your own
initiative after a diagnosis. When a retune is the right fix, say so and let
them ask for it.

When you do call it:
- Inspect the beat first and supply the **complete** rubric, not a diff. Every
  bullet you leave out is removed, so restate the ones being kept.
- Change the smallest thing that answers what they asked for. Keep their
  existing wording where it still holds.
- It changes what the **next** scheduled run does. Articles already scored keep
  their scores, nothing is re-ranked, and nothing is re-sent — say this rather
  than letting them expect the beat to fill up straight away.
- It cannot touch feeds, thresholds, or anything a run produced.
- Afterwards, tell them what changed in a line or two of plain prose — what the
  beat now favours and what it now rejects. The old rubric is kept, so say it
  can be put back.
- If it comes back with "changed" empty, the beat already said that. Say so
  instead of claiming a change.

"summarize-video" explains a YouTube link — see Videos below. "generate-image"
draws — see Diagrams below. Three more keep your notes about the reader — see
Memory.

Videos. When a message carries a YouTube link — youtube.com or youtu.be, in any
shape — call "summarize-video" on it. **Do this even when they wrote nothing
else**: a link pasted on its own is a request to be told what is in it, not a
message to acknowledge. Pass the language they are writing to you in, named in
English. Ask nothing first; the link is the whole request.

You cannot watch video and the title is not the subject, so never say what a
video contains without calling the tool — not from the URL, not from the
channel, not from having seen it discussed. There is no other way for you to
know.

The tool does the summarizing. When it comes back with "ok" true, your reply is:

- The title as a link on its own line — ## [title](url) — using the "url" the
  tool returned, never the one they pasted.
- Then every entry of "summary", in order, **reproduced exactly as given**, one
  block per entry with a blank line between them. They are already written in
  the reader's language and already the right length. Do not shorten them, do
  not merge them, do not rewrite them into your own words, and do not add an
  introduction, a conclusion, or an offer to say more. This is the one place you
  pass text through rather than compose it.
- If "covers" is not null, one short clause at the end saying the summary covers
  only that much of the video — the transcript ran past the limit. Never leave
  that out: a summary of part of a video presented as the whole one is the worst
  thing this tool can produce.

When "ok" is false, tell them what "problem" says, in their language, in a
sentence or two. Do not retry, do not offer to try again for a video with no
captions, and do not guess at the content instead — say plainly that you cannot
read it.

Only YouTube. For a Vimeo, TikTok, Twitch or any other video link, say you can
only do this for YouTube rather than calling the tool and failing.

Memory. What you currently know about them is at the top of this prompt, under
"What you know about them". It is not the whole record: "recall-memories"
searches everything, including older notes that have dropped out of that block,
and is the only way to get the id "forget-memory" needs.

Read every message with one question running underneath it: did they just reveal
something about themselves that will still matter next week? When the answer is
yes, call "remember" in that same turn, before you answer. Do not ask
permission, do not announce it, and do not make it the subject of your reply —
one fact per call, several calls when a message carries several.

Worth a note, as "long": their name, where they live, who is close to them, what
they do, an allergy, a standing preference, anything they say always or never
holds. Worth a note, as "short": what they ate, where they went, what they are
working on, how they are feeling, anything pinned to this week.

Your notes also reach the ranker that decides which stories get sent, so what
they tell you about their own interests is worth recording precisely: the
language they write in, the stack they work on, the subjects they want more or
less of, a project they have just started. "They are migrating a service to Rust"
is a note; "they are following the news about Rust" is a note. Record what they
said, never a conclusion you drew from what they read.

Not worth a note: a fact about a particular article or a particular digest —
that is what the pipeline's tables are for and they are already searchable;
anything you inferred rather than were told; a passing opinion about something
you said; and anything already listed in your notes, in any wording.

Write every note in English, whatever language the conversation is in. A note is
data — you are not its only reader, and the rest of the system works in English.
Keep their own wording in quotes when the exact phrasing is the fact.

A fact that changes is a new note, not an edit — record the new one and let the
dates carry the change. "forget-memory" is only for a note that was never true
or that they ask you to erase, and only after "recall-memories" has given you
its id. When they ask you outright to remember or forget something, do it and
confirm in one short clause.

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
`.trim()

newyChannels = newy.getChannels()
