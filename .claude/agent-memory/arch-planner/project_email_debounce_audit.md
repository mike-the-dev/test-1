---
name: Email debounce cross-channel — codebase audit
description: Key findings from the email-debounce + cross-channel coherence architecture planning pass
type: project
---

handleMessage has exactly 4 call sites that must be migrated: email-reply.service.ts (3 — handleCase1SessionUlid, handleCase2NewSession, handleCase3FreshAttach, handleCase3StaleNewSession), web-chat.controller.ts (1 — sendMessage), sms-reply.service.ts (3 — handleCase2NewSession, handleCase3FreshAttach, handleCase3StaleNewSession).

ChatSessionMessageRecord in src/types/ChatSession.ts has NO channel field. Must add optional channel?: "web" | "sms" | "email" to the interface and include it in the PutCommand item shape inside handleMessage (the write loop at line ~432).

InternalApiKeyGuard in src/guards/internal-api-key.guard.ts is the exact pattern to follow for InternalAuthGuard — timingSafeEqual, HEADER_NAME constant, InternalApiAuthConfigService injection, UnauthorizedException throw. New guard for flush endpoint follows this pattern with a new config service for INTERNAL_FLUSH_SECRET.

env.schema.ts uses z.string().min(1) for required keys (e.g. KB_INTERNAL_API_KEY: z.string().min(32)), z.preprocess for boolean flags, .default(false) for feature flags. New env vars follow same pattern.

configuration.ts groups vars by domain object (app, database, anthropic, etc.). New scheduler group needed: { enabled, windowSeconds, flushSecret, flushUrl, backend }.

AppModule providers list is flat — all services listed individually. New SchedulerService and ReplyOrchestratorService go in this flat list. New InternalEmailFlushController goes in controllers array.

@aws-sdk/client-scheduler is NOT in package.json dependencies. Must be added.

**Why:** architecture planning audit for email debounce + cross-channel coherence task.

**How to apply:** Use these facts when reviewing or implementing the email-debounce feature. handleMessage deletion touches 7 call sites total (4 email + 1 web + 2 sms per case function).
