# Cross-channel identity & session continuation — fresh-agent handoff

**Date:** 2026-04-29
**Reason for handoff:** Design spec complete; original orchestrator approaching context limits. Clean break point before any implementation work begins.

---

## Read these in order, in full

1. **`docs/cross-channel-identity/design.md`** — the spec brainstormed and approved with the user. This is the single source of truth for what we're building. Read every section.
2. **`docs/knowledge-base/HANDOFF.md`** — the standing orchestration contract: 5-step sub-agent workflow, no orchestrator code edits, conventional commits, no `Co-Authored-By` trailer.
3. **`docs/journal.md`** — recent project history. Check the entries dated 2026-04-29 and earlier in April for full context on what has shipped.

---

## Where we are

Spec for cross-channel identity & session continuation is complete and approved. **No implementation work has started yet.** Next move is to decompose the spec into phase briefs (sketch is in the design doc's "Implementation decomposition" section — proposed 4 phases) and then ship each phase through the standard sub-agent workflow.

Phase 1 (data model + verification primitives) is the natural starting point.

---

## Standing rules — load these into your model immediately

These are user-set rules captured in auto-memory at `~/.claude/projects/-Users-mike-Development-ai-chat-session-api/memory/`. They will load automatically in a new Claude Code session at this project path. They are non-negotiable:

- **All code touches go through sub-agents.** The orchestrator does not write code, even for small reviewer should-fix items. Use `arch-planner → code-implementer → style-refactor → test-suite-runner → code-reviewer` per phase.
- **Pause for user verification before every commit and every push.** Sub-agents do NOT commit; orchestrator surfaces diff to user and asks before each commit + each push.
- **Push at sub-phase boundaries** — once a sub-section ships, commit + push in the same beat. Don't let local drift ahead.
- **No `Co-Authored-By:` trailer on commits.** User preference.
- **Do not read `.env`, `.env.local`, or any `.env.*` file.** `.env.example` only.
- **Keep `docs/journal.md` current at sub-phase boundaries** — append a dated entry per meaningful milestone using the format documented at the top of that file.
- **Conventional commits** — `feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs(scope):`, `chore(scope):`. See `git log --oneline` for examples.

---

## Phase 1 starting point

The design's "Implementation decomposition (sketch)" section proposes:

> **Phase 1 — Data model + verification primitives**
> - Add `customer_id` field to session METADATA + write paths
> - Add `latest_session_id` field to Customer record + write paths
> - Add `VERIFICATION_CODE` record type
> - Build `request_verification_code` and `verify_code` tools
> - Email template for verification code
> - Tests

This is the right scope for the first phase brief. Write it to `docs/knowledge-base/tasks/phase-cci-1-data-model-and-verification.md` (or your preferred naming — `cci` = cross-channel identity), following the PROMPT_DISCOVERY_SERVICE template structure used by every other recent phase brief in that folder. Then dispatch `arch-planner`.

Before writing the brief, I'd recommend re-reading the design's "Open implementation questions" section and discussing any of those with the user that affect Phase 1 scope (specifically: where does Customer creation move to, and the verification re-request rate-limit question).

---

## Important context that lives in code (won't survive a quick scan)

These are details from the design that point at specific existing code:

- **The Customer record + GSI already exist.** `src/tools/preview-cart.tool.ts:604–625` creates `C#<customerUlid>` with `GSI1 (ACCOUNT, EMAIL)`. Don't redesign — extend.
- **The reply-to encoded address pattern is `<sessionUlid>@<SENDGRID_REPLY_DOMAIN>`** where `SENDGRID_REPLY_DOMAIN` = `reply.<merchantDomain>` per merchant. Webhook discriminates on local-part: ULID-shaped → existing Case 1, literal `"assistant"` → new Case 2/3.
- **The naming convention is `_id` / `Id`, NOT `_ulid` / `Ulid`** for new fields. Existing TS variables (`sessionUlid`, etc.) are not refactored.
- **Phase 8d-essential's deterministic Qdrant point ID pattern** is unrelated to this work but worth knowing about as the reference example for "how this codebase ships hardening features." Read its brief + plan in `docs/knowledge-base/tasks/phase-8d-essential-integrity*.md` to see the level of detail expected in a phase brief.

---

## Suggested first message to the user when you start

> "I've read the cross-channel identity design spec, the HANDOFF, and the journal. I'm caught up. Want me to draft the Phase 1 task brief (data model + verification primitives) based on the design's decomposition sketch? I'll surface it for your review before dispatching arch-planner."

That's a clean opening. The user will likely say yes, you'll write the brief, surface it, then proceed through the standard 5-step workflow.
