# ai-chat-session-api — Documentation

A channel-agnostic agentic chat backend. One conversation can start on Discord, continue over email, and (soon) carry on over SMS or voice — with persistent memory, tool execution, and purpose-scoped AI agents.

This directory is the hub. It is split into three halves:

- **Reference docs** — what the system is and how it works today.
- **Project journal** — the narrative of how we got here and what's next.
- **Agent / engineering docs** — how to work on the codebase (standards, workflows, how-to guides).

---

## Reference docs

Describe the system as it exists now. Start here to understand the architecture.

| Doc | Purpose |
|---|---|
| [Architecture](./reference/architecture.md) | System overview, request lifecycle, and the tool-use loop |
| [Concepts](./reference/concepts.md) | Glossary of the core terms: session, identity, agent, tool, channel |
| [Data model](./reference/data-model.md) | DynamoDB single-table layout and record shapes |
| [Agents & tools catalog](./reference/agents-and-tools.md) | Agents and tools that currently ship in the repo |
| [Channels: Discord](./reference/channels/discord.md) | How Discord messages enter the system |
| [Channels: Email](./reference/channels/email.md) | Outbound email and the inbound reply loop |
| [Operations](./reference/operations.md) | Environment variables, local run, and deployment notes |

---

## Project journal

[`journal.md`](./journal.md) is an append-only narrative log of meaningful milestones. It captures *why* we made decisions, not just *what* changed — reading the top few entries is the fastest way for a new engineer (or a fresh AI agent) to catch up on the current direction of the project.

At the end of a working session or after shipping a milestone, add a dated entry at the top following the format described inside the file.

---

## Agent / engineering docs

How to work on and extend the codebase.

- [Creating agents and tools (how-to)](./agent/engineering/creating-agents-and-tools.md) — the 3-step guide for adding a new agent or tool
- [NestJS standards](./agent/engineering/standards-nestjs.md)
- [Global engineering standards](./agent/engineering/global-standards.md)
- [Feature folder architecture](./agent/architecture/feature-folder-architecture.md)
- [Feature brief template](./agent/feature-brief-template.md) · [Feature spec template](./agent/feature-spec-template.md)
- [Commit messages](./agent/commit-messages.md) · [PR description template](./agent/pr-description-template.md)
- [Sentry workflow](./agent/sentry-workflow.md) · [Asana workflow](./agent/asana-workflow.md)

---

## Reading order for new engineers (and fresh agents)

1. [Journal](./journal.md) — read the top 1–2 entries to understand the current state and direction.
2. [Architecture](./reference/architecture.md) — get the big picture.
3. [Concepts](./reference/concepts.md) — learn the vocabulary.
4. [Data model](./reference/data-model.md) — understand how state is stored.
5. [Agents & tools catalog](./reference/agents-and-tools.md) — see what exists today.
6. [Creating agents and tools](./agent/engineering/creating-agents-and-tools.md) — learn how to add your own.
