---
name: Test Setup
description: How tests are run and what to expect in this NestJS project
type: project
---

Test command: `npm test -- --forceExit` (plain `npm test` works too; `--forceExit` suppresses the open handles warning).

**Why:** NestJS bootstraps async infrastructure (e.g., ConfigModule, providers) that can keep Jest open; `--forceExit` avoids the hang.

**How to apply:** Always pass `--forceExit` when running the full suite to get a clean exit. If the open-handles warning appears without it, note it but don't treat it as a failure.

As of 2026-04-28 (post-BullMQ DI fix: KnowledgeBaseConfigModule extracted, AppModule BullModule.forRootAsync refactored): 31 suites, 482 tests total, 482 passed, 0 failed. Build clean (nest build, no errors, no output). ERROR-level log output in test runs is expected — tests for VoyageDimGuardService (mismatch + unreachable scenarios), SaveUserFactTool, ToolRegistryService, OriginAllowlistService, KnowledgeBaseIngestionService, KnowledgeBaseController, LookupKnowledgeBaseTool, and others intentionally exercise error paths. These are not test failures.

Prior baselines:
- M1: 11 suites, 114 tests passing.
- M2 (post-create-guest-cart): 12 suites, 139 tests (138 passed, 1 failed — create-guest-cart ULID index bug).
- KB Phase 4 Step 2: 288 tests passing (21 suites).
- KB Phase 4 Step 3 (style-refactor): 288 tests passing (21 suites), 0 failures, build clean.
- Phase 8a Steps 1-3 (Sentry integration + style-refactor): 409 tests passing (25 suites), 0 failures, build clean.
- Phase 8c (InternalApiKeyGuard + style-refactor, commit 8bf3fb01 + uncommitted style edits): 459 tests passing (29 suites), 0 failures, build clean. Time: ~1.85 s.
- Phase 8c SHOULD-FIX close-out (uncommitted edits: internal-api-key.guard.ts ternary + comment restore, instrument.ts PII_KEYS addition, sentry.service.spec.ts breadcrumb scrub test): 460 tests passing (29 suites), 0 failures, build clean. Time: ~1.887 s.
- Phase 8d-essential (uncommitted: VoyageDimGuardService boot-check, voyage-dim-guard.service.spec.ts x13, qdrant-point-id.spec.ts x6, 3 new deterministic-ID tests in knowledge-base-ingestion.service.spec.ts): 482 tests passing (31 suites), 0 failures, build clean. Time: ~1.923 s.
- Phase 8b-followup + style-refactor (uncommitted: Slack alert cart-detail enrichment — 16 new tests across slack-alert.service.spec.ts, preview-cart.tool.spec.ts, generate-checkout-link.tool.spec.ts): 498 tests passing (31 suites), 0 failures, build clean. Time: ~2.456 s.
- Phase CCI-1 + Option-A normalization + style-refactor (types renamed: VerificationRequestCodeResult / VerificationVerifyCodeResult; cast removal + else-elimination in verification tools; _input→input rename): 523 tests passing (34 suites), 0 failures, build clean. Time: ~2.408 s.
- Phase CCI-2a + style-refactor (trio-completion gate in collect_contact_info, lookupOrCreateCustomer lifted into CustomerService with isError discriminant, new types GuestCartLookupOrCreateResult / CollectContactInfoTrioCompletedResult / CollectContactInfoSavedResult, CUSTOMER_PK_PREFIX constant, preview_cart hard-requires metadata.customer_id, generate-checkout-link strip-prefix): 545 tests passing (35 suites), 0 failures, build clean. Time: ~2.512 s.
- Phase CCI-2b + style-refactor (ChatSessionContinuationProfile named interface extracted to src/types/ChatSession.ts; else-elimination in chat-session.service.ts loader block; non-null ! replaced with ?? "" on customerId; redundant dynamicSystemContext type annotation removed; as Record<string, string> casts removed from verify-code.tool.spec.ts tests 9/10/11 with optional-chaining ?.SK): 578 tests passing (36 suites), 0 failures, build clean. Time: ~2.401 s.
- Phase CCI-3 + style-refactor (enum LocalPartClassification → EmailReplyLocalPartClassification; isConditionalCheckFailed helper changed to error instanceof Error; LEAD_CAPTURE_AGENT_NAME constant added in identity.service.ts; 22 new email-reply tests): 601 tests passing (36 suites), 0 failures, build clean. Time: ~3.36 s.
- Phase 1 Discord removal + style-pass (discord.service.ts, discord-config.service.ts, types/Discord.ts deleted; app.module.ts, config/configuration.ts, config/env.schema.ts, identity.service.spec.ts edited; discord.js removed from package.json; whitespace style fixes in identity.service.spec.ts): 601 tests passing (36 suites), 0 failures, build clean. Time: ~2.631 s.
