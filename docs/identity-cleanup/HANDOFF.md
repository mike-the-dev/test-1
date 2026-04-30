# IDENTITY pattern cleanup — fresh-agent handoff

**Date:** 2026-04-30
**Reason for handoff:** Cross-channel identity feature is fully shipped (CCI-1 through CCI-3 are on master). This is a separate cleanup that surfaced during the post-CCI-3 retro discussion. Worth a fresh agent + brainstorming session before any code lands.

---

## Read these first

1. `docs/cross-channel-identity/design.md` — design spec for the cross-channel feature that was just shipped. Provides context for why this cleanup matters.
2. `docs/journal.md` — recent entries (2026-04-30 has CCI-1 through CCI-3 ship notes plus the design rationale that motivated this cleanup). The CCI-3 journal entry specifically calls out the deliberate IDENTITY-skip for email-inbound, which is the precedent for this work.
3. `docs/knowledge-base/HANDOFF.md` — standing 5-step orchestration contract. Same workflow (arch-planner → code-implementer → style-refactor → test-suite-runner → code-reviewer) applies here.

---

## Where we are

Cross-channel identity & session continuation is shipped. Web and email are both returning-visitor-aware. Email-inbound deliberately does NOT write IDENTITY records (Phase CCI-3 found the per-channel IDENTITY pattern caused a "second stale email loops back to first stale session" bug; skipping IDENTITY records fixed it cleanly via the Customer record + customer-by-email lookup as the unifying identity).

That deliberate skip exposed something bigger: the IDENTITY pattern's PK shape (`IDENTITY#<channel>#<channel-specific-id>`) is a relic. It bakes the channel into the storage key, which suggests sessions are partitioned by channel — but in the cross-channel world that's not the relational truth. The Customer record is the actual cross-channel unifier; per-channel handles like `guestUlid` are just the anonymous-visitor fallback BEFORE email is captured.

**Two related cleanups are queued, in order:**

### Step 1 — Remove Discord entirely

Discord was originally added as a cheap test harness for the backend. It's not part of the production product. Files to remove (verify before deleting): `src/services/discord.service.ts`, the Discord controller, related tests, related env vars, related commit history note. The journal already documents Discord as historical; this just makes the codebase reflect that.

After Discord is gone, only one channel still uses IDENTITY records: web. Email-inbound (CCI-3) skips them. Discord-removal is the unblocker for any IDENTITY simplification because it makes web the only thing left to think about.

### Step 2 — IDENTITY pattern decision (the actual question)

Once Discord is removed, web is the only remaining IDENTITY consumer. The question becomes: what's the right shape for that one remaining use case?

**Today's behavior (web):**
- Frontend widget stores a long-lived `guestUlid` in the browser (probably localStorage).
- On every request, frontend sends `guestUlid` to the backend.
- Backend builds `IDENTITY#web#<guestUlid>` → looks up the IDENTITY record → returns the mapped `sessionUlid`.
- Frontend uses `sessionUlid` for the rest of the conversation.

So IDENTITY is acting as an **indirection layer** between the stable browser handle and the current session ULID. Two separate concepts mapped through one table.

---

## The two honest tradeoffs to discuss with the user

### Option A — Keep IDENTITY but simplify the PK shape

**What changes:**
- PK goes from `IDENTITY#web#<guestUlid>` to `IDENTITY#<guestUlid>` (or rename to something like `GUEST#<guestUlid>` if the rename helps clarity — the user has flagged that the current name is misleading anyway).
- Drop the `source` parameter from `IdentityService.lookupOrCreateSession`.
- The `source` field on the IDENTITY record body either gets dropped or stays as a static "web" string for now.
- Migration concern: existing IDENTITY records on master have the old PK shape. Either migrate (re-write all records with new PKs), accept hybrid state during transition, or handle both formats during read.

**Tradeoff summary:**
- ✓ Frontend contract unchanged. Frontend keeps sending `guestUlid`; backend keeps mapping it to `sessionUlid`. Zero coordinated deployment risk.
- ✓ Cleans up the visual misrepresentation in the PK shape — the relational truth (sessions belong to customers, channels are how messages arrived) is no longer falsely implied to be channel-partitioned.
- ✓ Smaller scope. Lower risk. Lower test churn.
- ✗ The indirection layer (`guestUlid` → `sessionUlid` mapping) stays even though no one is actively USING the flexibility it provides (we don't rotate sessions, we don't have multiple sessions per browser).
- ✗ Still leaves "we have a layer that isn't pulling its weight" as latent technical debt.

### Option B — Remove IDENTITY entirely

**What changes:**
- Frontend stores `sessionUlid` directly (not `guestUlid`). The browser hands the backend a sessionUlid on each request.
- Backend looks up the session directly via `CHAT_SESSION#<sessionUlid> / METADATA`. No indirection.
- New session creation moves into the web-chat controller (or a small helper service): if the frontend sends no sessionUlid OR a sessionUlid that doesn't exist, the controller creates a new session, returns the new ULID to the frontend, and the frontend stores it.
- The entire `IdentityService` shrinks substantially — the `lookupOrCreateSession` method may not be needed at all once Discord is removed and web doesn't use IDENTITY records. (`createSessionWithoutIdentity` from CCI-3 may become the only session-creation path needed.)
- Migration concern: existing browsers in the wild are storing `guestUlid`s. Coordinated deployment: backend must accept either `guestUlid` (and look up via the old IDENTITY table) OR `sessionUlid` (direct), at least during transition. Or accept "users in flight at deploy lose their session continuity."

**Tradeoff summary:**
- ✓ Cleaner long-term. Removes a layer that isn't pulling its weight.
- ✓ The mental model becomes "sessions are sessions; the browser stores the session id; that's it." No translation table.
- ✓ Aligns with the Customer-record-as-unifier model — if cross-channel continuity is needed, it's the Customer record's job, not a per-channel translation table.
- ✗ Requires a coordinated frontend deployment. Backend-only changes don't ship this; the frontend repo must change too.
- ✗ More work overall. Frontend changes, backend simplifications, possible migration logic during transition.
- ✗ Higher risk during rollout. Users in flight may lose sessions at deploy time.

---

## Recommendations the prior agent (me) suggested

The prior agent leaned toward **Option A** as the conservative path: 80% of the relational-clarity benefit for 20% of the risk and work. The indirection layer staying is mild technical debt, not active harm. Option B is cleaner long-term but the frontend coordination and rollout risk are real.

But the user explicitly asked for both options to be captured here so they can discuss it fresh with the next agent. So: **don't anchor on the prior recommendation. The question is genuinely open.**

The discussion should weigh: (a) is the frontend team ready for a coordinated change, (b) how much do users actively rely on guestUlid persistence vs. how often do they lose sessions anyway from clearing browser data, (c) is there any other future feature that would benefit from removing the indirection layer?

---

## Suggested first move for the fresh agent

After reading the references above, surface this handoff to the user. Confirm Discord removal is still the right Step 1 (it should be). Then walk through the Option A vs. B tradeoffs naturally — the user prefers tight, plain-language explanations and doesn't want jargon-heavy framing. Let the user steer.

If the user picks Option A: Discord removal is one phase, IDENTITY simplification is the next phase. Both small, both relatively contained. Two 5-step workflows.

If the user picks Option B: Discord removal is one phase, then a multi-piece refactor (backend simplification + coordinated frontend change + migration handling). The frontend repo lives elsewhere and needs separate coordination — flag that early.

---

## Standing rules — non-negotiable

- All code touches go through sub-agents. Orchestrator does not edit source files (journal entries are an exception — orchestrator-narrative).
- Pause for user verification before every commit and every push.
- Push at sub-phase boundaries.
- Conventional commits (`feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs(scope):`, `chore(scope):`).
- No `Co-Authored-By:` trailer.
- Do not read `.env`, `.env.local`, or any `.env.*` file. `.env.example` only.
- Keep `docs/journal.md` current at sub-phase boundaries.
- Naming convention: `_id` / `Id`, never `_ulid` / `Ulid` for new fields and new typed inputs. Existing TS variable names are not refactored.

---

## Important context that lives in code (won't survive a quick scan)

- `src/services/identity.service.ts` is the file most affected by both options. Read every line before planning.
- `src/services/identity.service.ts` has BOTH `lookupOrCreateSession` (writes IDENTITY records — used by Discord and web) AND `createSessionWithoutIdentity` (added in CCI-3 — used by email-inbound). The latter may become the primary path under either Option A or B.
- `src/controllers/web-chat.controller.ts:68` is web's call site to `lookupOrCreateSession`. This is where the frontend contract lives.
- `src/services/discord.service.ts` and the Discord controller are what Step 1 removes.
- The Customer record (`C#<customerUlid>`) with its `(ACCOUNT, EMAIL)` GSI1 is the cross-channel unifying identity. It's already wired up and works. This handoff is about cleaning up the now-redundant per-channel layer, not about adding new identity infrastructure.
