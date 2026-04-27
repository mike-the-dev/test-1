# Knowledge Base Feature — Session Handoff

**Date paused:** 2026-04-27
**Reason:** Natural breakpoint after observability (Phase 8a + 8b) shipped. Auth (Phase 8c) deferred to a fresh session for security focus.

---

## Where we are

### Shipped phases
- **Phase 1** — Qdrant collection setup
- **Phase 2** — Voyage AI embedding setup (`voyage-3-large`, 1024-dim)
- **Phase 3** — Chunker (2000 char target, 200 char overlap, natural boundaries)
- **Phase 4** — Ingestion endpoint + pipeline (DynamoDB metadata, Qdrant vectors, per-account isolation)
- **Phase 5** — Retrieval tool + hybrid LeadCapture agent
- **Phase 7a** — Document update + delete lifecycle
- **Phase 7b** — Claude enrichment at ingestion (SUMMARY/QUESTIONS/KEY TERMS, embedded combined with chunk)
- **Phase 7c** — Redis + BullMQ async ingestion queue
- **Phase 8a** — Sentry error tracking with PII scrubbing
- **Phase 8b** — Slack business-signal alerts (conversation started, cart created, checkout link generated) → `#instapaytient-agentic-ai-alerts`

### Pending phases (see `docs/knowledge-base/phase-8-considerations.md`)
- **Phase 8c** — Internal-API auth (next up — designated for fresh session)
- **Phase 8d** — Idempotency / integrity
- **Phase 8e** — Operational endpoints
- **Phase 8f** — Quality & cost levers

---

## Orchestration contract — read this first

The next agent **must** follow these rules. They were earned the hard way in this session.

### The 5-step sub-agent workflow
Every code-touching phase runs through this exact sequence, in order:

1. `arch-planner` — produces a written plan in `docs/knowledge-base/tasks/<phase>-plan.md`
2. `code-implementer` — applies the plan
3. `style-refactor` — normalizes to repo style (this is non-negotiable; user cares deeply)
4. `test-suite-runner` — confirms full Jest suite passes
5. `code-reviewer` — verifies and returns must-fix / should-fix items

The contract lives in `PROMPT_DISCOVERY_SERVICE.md` at the repo root.

### Hard rules for the orchestrator
- **The orchestrator does NOT write code.** Even small reviewer should-fix items go through `code-implementer → style-refactor → test-suite-runner → code-reviewer`. No inline edits, no exceptions. Skipping `arch-planner` is OK only when the prior reviewer's findings already serve as the plan.
- **Commit AND push at every sub-phase boundary.** Don't let local drift ahead of `origin/master` across multiple sub-phases. `git push origin master` is part of the wrap-up, not an afterthought.
- **Conventional commits.** `feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs(scope):`, `chore(scope):` — see `git log --oneline` for examples.
- **No `Co-Authored-By` trailer** on commits (user's preference; it pollutes GitHub Contributors).

---

## Where to look for context

### Architecture and design
- `docs/knowledge-base/data-flows.md` — ingestion, query, update, delete paths
- `docs/knowledge-base/benchmark-findings.md` — Phase 7b enrichment results (modest lift on small clean corpus; documented honestly)
- `docs/knowledge-base/phase-8-considerations.md` — sub-phase 8a–8f bundles with the deferred-items rationale

### Per-phase task briefs and plans
`docs/knowledge-base/tasks/` contains paired files for every shipped phase:
- `<phase>.md` — task brief written by the orchestrator before dispatch
- `<phase>-plan.md` — arch-planner's output, the spec the implementer follows

Examples worth reading before 8c:
- `phase-8a-sentry-error-tracking.md` + `-plan.md` — closest pattern to 8c (cross-cutting infrastructure)
- `phase-8b-slack-business-alerts.md` + `-plan.md` — Pattern B side-effects example

### Repo conventions
- `CLAUDE.md` — root-level repo guide (folder layout, naming, build commands)
- `.claude/instructions/style-enforcer.md` — the style rules `style-refactor` enforces
- `.claude/agent-memory/` — sub-agent learnings accumulated across phases (committed `6bfc0ed9`)

### Auto-memory (loaded automatically by Claude Code at this path)
`~/.claude/projects/-Users-mike-Development-ai-chat-session-api/memory/MEMORY.md` plus per-topic files. Contains user preferences (Discord notifications, no co-author trailer, etc.) and the two rules from this session:
- `feedback_all_code_touches_via_subagents.md`
- `feedback_push_at_subphase_boundaries.md`

A fresh Claude Code session opened at the same project path will load these automatically. A different tool (Cursor, Copilot CLI, etc.) will not.

---

## What's NOT in the docs (read this carefully)

These decisions live in commit messages and code comments but might be missed if scanning quickly:

- **Cart total units are cents** (not dollars). `preview-cart.tool.ts` sums `cartItem.total` which is integer cents per the `GuestCart` contract. Inline comment added at the call site to prevent a future "fix" from multiplying by 100.
- **Slack scope is celebrations only.** Errors go to Sentry. Slack is for business-positive signals. Channel: `#instapaytient-agentic-ai-alerts`. Adding error alerts here is a regression.
- **Fire-and-forget side effects** use `.catch(() => undefined)`. Never block a user request on an alert.
- **DynamoDB PK/SK are uppercase.** Lowercase will pass type-checks and fail at runtime with `ValidationException`. Bit us once on Phase 4.
- **Per-account isolation is the most critical correctness invariant.** Every Qdrant query carries an `account_id` filter. Every DynamoDB key includes the account. This is non-negotiable for the multi-tenant ecommerce vertical.
- **Phase 8b has a revert-and-redo in its history** (`d46ff615` reverts `7a94327f`, then `a99312a5` re-does it via the proper sub-agent workflow). The audit trail is intentionally honest.

---

## Recommended first message to the fresh agent

> "Start by reading `docs/knowledge-base/HANDOFF.md`, then `PROMPT_DISCOVERY_SERVICE.md`, then `docs/knowledge-base/phase-8-considerations.md`. We're picking up at Phase 8c — internal-API auth. Don't write any code yourself; dispatch the 5-step sub-agent workflow. Commit and push at every sub-phase boundary."

That's enough context for a competent orchestrator to pick up the torch.
