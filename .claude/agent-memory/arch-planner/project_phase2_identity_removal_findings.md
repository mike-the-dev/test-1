---
name: Phase 2 IDENTITY removal — codebase findings
description: Key facts found while planning Phase 2 (remove IDENTITY pattern entirely, web frontend stores sessionId directly)
type: project
---

Service shape after Phase 2: IdentityService renamed to SessionService (session.service.ts). `lookupOrCreateSession` deleted. `createSessionWithoutIdentity` renamed to `createSession`. `updateOnboarding` preserved. File renamed to session.service.ts.

**Why:** IDENTITY pattern is a relic — the only surviving use was web, which will now store sessionId directly. Email-inbound already skipped IDENTITY records (CCI-3 design decision).

**How to apply:** When any future work touches session creation, the entry point is `SessionService.createSession(source, accountUlid)`. The old `IdentityService` and `lookupOrCreateSession` no longer exist after this phase lands.

Key facts:
- `createSessionWithoutIdentity` has exactly 2 call sites in email-reply.service.ts: lines 384 (handleCase2NewSession) and 495 (handleCase3StaleNewSession). Both must be updated to `createSession` after rename.
- `updateOnboarding` is called from web-chat.controller.ts only (line 103). Survives rename intact.
- `WebChatCreateSessionResponse.sessionUlid` → renamed to `sessionId` (matches new naming convention). Frontend contract changes accordingly.
- `WebChatCreateSessionRequest.guestUlid` → removed. New optional field: `sessionId`.
- `createSessionSchema` in web-chat.schema.ts: drop `guestUlid`, add optional `sessionId` (ULID regex or absent).
- Session-create flow: if `sessionId` present, GetItem METADATA; if found return it; if not found or absent, mint new session via `createSession`.
- `LookupOrCreateSessionResult` type deleted. New internal type needed for session-create response: `CreateSessionResult` with `sessionId`, `onboardingCompletedAt`, `kickoffCompletedAt`, `budgetCents`, `wasCreated`.
- `ChatSessionIdentityRecord` type deleted. IDENTITY_PK_PREFIX constant deleted.
- Race condition: none possible in new design. New sessions always mint fresh ULIDs. No shared-key contention.
- Pointer record (A#<accountUlid> / CHAT_SESSION#<sessionUlid>) write preserved in createSession.
- e2e test (test/app.e2e-spec.ts) only hits GET / — unaffected.
- DI rename: AppModule providers array entry changes from IdentityService to SessionService. Import statement updated.
- architecture.md diagram references "Identity layer / IdentityService" — needs rewrite.
- concepts.md has full "Identity" section + source name table — remove entirely.
- data-model.md: delete IDENTITY record section, fix sessionUlid→session_id nit (line 24), update "Written initially by IdentityService" prose.
- creating-agents-and-tools.md references "identity service" in step 1 of the flow — update to "session service / direct lookup".
- No email-reply controller file exists — email-reply is handled by sendgrid-webhook.controller.ts passing to email-reply.service.ts directly.
