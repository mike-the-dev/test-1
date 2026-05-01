---
name: CCI Phase 2 identity-cleanup review findings
description: Phase 2 IDENTITY pattern removal (IdentityService → SessionService rename, guestUlid → sessionId wire rename, lookup-or-mint in controller). Reviewed 2026-04-30.
type: project
---

Phase 2 is clean and approved with minor issues. No MUST-FIX blockers.

**Why:** IDENTITY translation table was removed; web-chat now stores sessionId directly. Option B chosen (full rename of all wire fields to `sessionId`).

**How to apply:** Future reviews of web-chat or session-creation flows should assume: (a) `SessionService.createSession(source, accountUlid?)` is the single creation path; (b) no IDENTITY# PK prefix anywhere; (c) lookup-or-mint logic lives in `WebChatController.createSession`, not a service method.

SHOULD-FIX identified:
- `ChatSessionCreateSessionResult` type (with `wasCreated: boolean`) is declared in `src/types/ChatSession.ts` but never imported or used anywhere — dead type.
- `concepts.md` line 66 still says "The binding is set the first time the identity is created" — leftover IDENTITY-era wording; should read "the first time the session is created".
- `data-model.md` METADATA field table lists `agentName` but the actual DynamoDB field name is `agent_name` (snake_case) — minor doc inconsistency, pre-existing but still present.

Test delta: −14 from 601 baseline. Controller spec went from testing lookupOrCreateSession paths (18 deleted per plan) to a complete rewrite covering all 5 endpoints and all 4 lookup-or-mint policy cases. Net loss of ~14 is explained by consolidated pipe tests (previously separate pipe-only tests, now folded into endpoint-scoped describe blocks), not missing coverage. All required coverage areas are present.
