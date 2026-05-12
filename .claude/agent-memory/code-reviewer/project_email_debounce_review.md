---
name: Email debounce cross-channel review
description: Review findings for the email-debounce + cross-channel coherence phase; key architectural decisions and two should-fix issues
type: project
---

Chokepoint discipline: confirmed clean. `ReplyOrchestratorService.generateAndSendReply` is the only LLM+outbound path. All 4 email cases, SMS, and web all route through it.

Cancel-in-finally: confirmed. No-op path cancels in a try/catch before early return. Happy path and LLM-error path both hit the `finally` block.

**Should-fix 1**: Orchestrator email send omits `replyDomain` and `fromName`. At flush time, `emailService.send` receives no `replyDomain`, logs `[event=email_send_no_reply_domain]`, and builds `from: { email: "", name: "" }`. This will likely cause SendGrid to reject or silently substitute the account-level sender. Fix: store `reply_domain` and `from_name` from the account record into session METADATA at inbound-email time, then read them in the orchestrator's `sendOutbound` for the email channel.

**Should-fix 2**: `INTERNAL_FLUSH_SECRET` is `optional()` in `env.schema.ts` and falls back to `""` in configuration. Plan required `getOrThrow` (fail-fast at boot). In practice the guard's `!incoming` check still blocks requests with empty headers, but if the secret is unset, the real EventBridge scheduler can never authenticate. No security hole, but an operational footgun — the feature silently doesn't work without clear boot-time feedback.

Minor: `SCHEDULER_SERVICE` injection token is defined in `scheduler.service.ts` but the interface `ISchedulerService` is in `src/types/Scheduler.ts`; several consumers import the interface from the service file rather than the types file. Convention gap only.

Minor: `ChatSession.ts` line 65 comment still says "Stamped by ChatSessionService.handleMessage" — stale after the method was deleted.

All invariants passed. Tests comprehensive and well-structured. Ready to ship with should-fixes addressed.

**Why:** These findings are non-obvious from reading the code in isolation — the `replyDomain` gap only appears when tracing the full send path from orchestrator through email.service.ts.

**How to apply:** Surface both should-fixes in future orchestrator or email-channel work.
