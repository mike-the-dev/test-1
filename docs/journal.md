# Project journal

Narrative log of meaningful milestones on `ai-chat-session-api`. Newest entries on top.

This file is the **story** of the project — what we set out to do, what we decided, what's next. It is intentionally different from the reference docs under [`docs/reference/`](./README.md), which describe the system as it exists right now. Reference docs answer *"what is this?"*; the journal answers *"how did we get here and where are we going?"*.

---

## How to add an entry

At the end of a working session — or after shipping a meaningful milestone — append a dated section at the **top** of the entries below. Keep it tight.

**Format:**

```
## YYYY-MM-DD — short title

**Goal:** one sentence on what we set out to do.

**What changed:**
- 3–6 bullets of the meaningful outcomes (not every file touched).

**Decisions worth remembering:**
- 0–3 bullets of non-obvious calls and *why* we made them.

**Next:**
- 0–3 bullets of what a future session would pick up.
```

**Rules of thumb:**

- One entry per meaningful milestone, not per session. Building the email reply loop deserves an entry. Renaming a variable does not.
- Favor *why* over *what*. The diff shows what changed. The journal should capture the reasoning that doesn't survive in the code.
- Keep each entry under ~30 lines. If it's longer than that, it's trying to be a spec — put it in `docs/reference/` instead.
- When this file crosses ~500 lines, cut the oldest third into `docs/journal-archive-<year>.md` and link it from the bottom of this file.

---

## 2026-04-13 — Reference documentation suite

**Goal:** Create project-level reference docs describing what the system is and does today, distinct from the existing how-to guides.

**What changed:**
- Added `docs/README.md` as a hub splitting docs into Reference (what the system is) and Agent/engineering (how to work on it).
- Added `docs/reference/architecture.md` — layered diagram, request lifecycle, key design decisions, file map.
- Added `docs/reference/concepts.md` — glossary of session, identity, channel, agent, tool, tool-use loop, content block.
- Added `docs/reference/data-model.md` — DynamoDB single-table layout, all PK/SK patterns, access patterns.
- Added `docs/reference/agents-and-tools.md` — catalog of the `lead_capture` agent and all three tools as they ship today.
- Added `docs/reference/channels/discord.md` and `docs/reference/channels/email.md` — channel adapter reference including DNS/SendGrid setup for the inbound reply loop.
- Added `docs/reference/operations.md` — env var table, local run, logging, security notes.

**Decisions worth remembering:**
- Picked a multi-file structure over a single `ARCHITECTURE.md`. Rationale: the project already has multiple channels and agents and is growing. Granular files age better and let future Twilio SMS/voice additions slot in cleanly as `channels/sms.md` / `channels/voice.md` without restructuring.
- Reference docs live under `docs/reference/`, how-to guides stay under `docs/agent/engineering/`. Clean split between "what the system is" vs. "how to work on it".
- This journal was chosen over a `YYYY-MM-DD/` folder structure. Reasoning: dated folders rot fast, a new agent only reads the most recent one or two entries anyway, and a single rolling file avoids filesystem sprawl while staying portable across tools (readable by humans, reviewable in PRs, not tied to any specific AI harness's memory system).

**Next:**
- No concrete follow-ups. The reference docs are now the authoritative snapshot of the system; update them as code evolves.
- When Twilio SMS or voice is built, add `docs/reference/channels/sms.md` / `voice.md` and update `concepts.md` (source list) and `operations.md` (env vars).

---

## (earlier, undated) — Foundation → v1 channel-agnostic platform

**Goal:** Build an agentic AI chat backend with persistent memory, tool execution, and multi-channel support where adding a new channel or agent never requires touching the core services.

**What changed:**
- Built the core tool-use loop in `ChatSessionService` — loads history from DynamoDB, calls Anthropic, executes tool calls, persists results, bounded at 10 iterations as a safety valve.
- Introduced structured content blocks (`text`, `tool_use`, `tool_result`) stored as JSON in DynamoDB, matching the Anthropic SDK shape so no translation layer is needed.
- Built `IdentityService` with `(source, externalId, agentName) → sessionUlid` lookup/create semantics and conditional writes for race-safety.
- Built `AgentRegistryService` and `ToolRegistryService` with decorator-based auto-discovery (`@ChatAgentProvider()`, `@ChatToolProvider()`) via NestJS `DiscoveryService`. Adding an agent or tool is one `providers: [...]` entry in `AppModule`.
- Defined the `ChatAgent` interface (`name`, `description`, `systemPrompt`, `allowedToolNames`) — agents are pure config, zero orchestration code.
- Shipped the `lead_capture` agent with a locked 5-field collection workflow, verification step, correction flow, and HTML confirmation email template. System prompt was refined through live testing (tone, emoji usage, boundary handling, jailbreak resistance).
- Shipped three tools: `collect_contact_info` (incremental DynamoDB upserts), `send_email` (SendGrid), `save_user_fact` (long-term key/value memory, not yet wired back into prompt context).
- Wired Discord as a channel adapter (`DiscordService`) including a raw-gateway workaround for a `discord.js` v14.26.2 DM bug.
- Built the email reply loop: outbound encodes `<sessionUlid>@<replyDomain>` in the From address; inbound via SendGrid Inbound Parse webhook routes back to the same session via `EmailReplyService` with sender validation, message-ID dedupe, and threaded replies.
- Added `SENDGRID_REPLY_DOMAIN` env var with domain validation, enabling per-client reply domains without core changes.
- Wrote the how-to guide `docs/agent/engineering/creating-agents-and-tools.md` covering the 3-step process for new engineers adding agents or tools.

**Decisions worth remembering:**
- Tool allowlists are enforced in **two** places: (a) tools not in the allowlist are filtered out of the list sent to Anthropic so the model never sees them, and (b) a defense-in-depth check inside the tool-use loop re-validates before dispatch. A jailbroken prompt cannot route around either layer.
- Agents hold zero orchestration code. The core `ChatSessionService` is generic and loads the agent from session metadata at request time. This is what makes adding agents a zero-core-change operation.
- Session ULID encoded in the outbound email sender's local part is the routing key for inbound replies — no database lookup required to figure out which session a reply belongs to. This is also what enables per-client reply domains cleanly.
- Single-table DynamoDB with session-ULID-prefixed PKs means reading full session state is one `Query`, not a fan-out. No GSIs yet; add them when a non-session access pattern actually appears.
- `start:local` (not `start:dev`) is the canonical local-run command. Documented in `CLAUDE.md`.

**Next:**
- Twilio SMS adapter as a new channel.
- Twilio Voice adapter (real-time transcription → chat core → TTS reply).
- Surface `USER_FACT#<key>` records back into the agent's prompt context at conversation start.
- Observability: metrics for tool loop iterations, Anthropic latency, inbound email outcomes.

---
