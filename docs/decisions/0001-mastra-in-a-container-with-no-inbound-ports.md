# ADR-0001: Mastra in a container with no inbound ports

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

The goal was a personal Telegram agent that orchestrates sub-agents, with a hard
requirement to "deploy anywhere" — a laptop, a Raspberry Pi, a VPS, Fly, without
rewriting anything.

The usual shape for a chat bot is a webhook, which forces a public HTTPS URL, a
TLS certificate, a tunnel during local development, and a redeploy-time webhook
re-registration. That is the single biggest constraint on where a bot can run.

## Decision

Run Mastra as one long-lived Node process in Docker, and design every external
interaction as **outbound only**:

- Telegram is reached by long polling, not webhooks (see [ADR-0002](0002-telegram-via-chat-sdk-adapter-in-polling-mode.md)).
- Models are called out through the OpenRouter gateway.
- Scheduling is in-process (see [ADR-0004](0004-native-mastra-schedules-over-a-job-queue.md)).

Nothing needs to reach the container from the network. Port 4111 is exposed in
`docker-compose.yml` bound to loopback only, for the local API — not for ingress.

## Consequences

**Good:** the deployment target becomes irrelevant. No DNS, no TLS, no tunnel in
dev, no webhook registration to keep in sync. It runs behind NAT.

**Costs:**
- Requires a long-lived process, which rules out scale-to-zero serverless
  platforms (Vercel, Lambda, Cloudflare Workers). Mastra's built-in scheduler is
  a `setInterval` tick loop and would never get a second tick there.
- Only one replica may run. Two would double-send digests and double-poll
  Telegram. This is fine for a personal agent and must not be forgotten if it
  ever scales.

**Revisit if:** the agent needs to serve other people, at which point a webhook
plus a shared pub/sub (Redis Streams) and horizontal replicas becomes the right
shape — and this ADR gets superseded.
