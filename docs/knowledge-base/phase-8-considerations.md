# Phase 8 — Operational Hardening Roadmap

Phase 8 is broken into **six independently shippable sub-phases**, each scoped tightly enough to run through the standard 5-step PROMPT_DISCOVERY_SERVICE flow. Sub-phases are largely independent — you can pause between any two.

The recommended ordering reflects risk reduction first (visibility before security, security before complexity, defenses before tools, quality knobs last).

---

## Sub-phase summary

| Sub-phase | Theme | Recommended order |
|---|---|---|
| **8a** | Sentry error tracking | First |
| **8b** | Slack alerts on page-worthy events | Second |
| **8c** | Internal-API authentication | Third |
| **8d** | Idempotency, integrity, & resilience hardening | Fourth |
| **8e** | Operational endpoints (list, bulk delete, admin) | Fifth |
| **8f** | Quality & cost levers | Last (defer until production data) |

---

## 8a — Sentry error tracking

**Goal:** Catch unhandled exceptions and structured error events automatically. Operators and developers should never need to be reading logs to discover problems.

**Items:**
- Add `@sentry/nestjs` integration. Initialize on boot.
- Wrap the SDK in a project-controlled `SentryService` so call sites use a stable interface (testable, swappable later).
- Manual `captureException` calls in known hot-spot catch blocks: VoyageService, Qdrant provider smoke check, ingestion service DDB failures, enrichment service per-chunk failures, processor job failures.
- Tag every captured event with `category` (e.g., `voyage`, `qdrant`, `enrichment`, `ingestion-job`) and `account_id` where available.
- Suppress `BadRequestException` and other validation-class errors — those are user errors, not bugs.
- Strip PII via `beforeSend`: never let chat messages, document text, or contact info into Sentry.
- Local dev: `SENTRY_DSN` unset → SDK becomes a no-op so dev errors don't pollute the org's Sentry.

**Why first:** Cheapest visibility win. Once landed, every other sub-phase is observable when it ships, so regressions get caught fast.

---

## 8b — Slack alerts on page-worthy events

**Goal:** Real-time team notifications for events that need a human to act NOW (not just "filed in Sentry for next-day review").

**Items:**
- Small `SlackAlertService` that posts to a configured webhook.
- Tight whitelist of page-worthy events:
  - All-chunks-fail enrichment for a document (likely Anthropic outage)
  - Voyage outage detected (multiple consecutive failures)
  - Qdrant outage detected (multiple consecutive failures)
  - Stuck-job detector firing (document stuck in `processing` for > N minutes — enabled in 8d)
  - Job-failed-after-retries beyond a threshold rate
- Suppression / rate-limiting so a sustained outage doesn't spam the channel.
- Channel ID configurable per-environment; staging Slack vs. prod Slack should be separate.

**Why second:** Builds on 8a's event categorization. Sentry catches everything; Slack escalates the subset that's page-worthy.

---

## 8c — Internal-API authentication

**Goal:** Lock down the KB endpoints so only the upstream control-panel API can call them. Today they're open.

**Items:**
- Choose between shared-secret header (simplest) or mTLS (more secure, more setup).
- Recommendation: shared-secret header (`X-Internal-API-Key`) for v1; mTLS as a future upgrade.
- Apply auth to: `POST`, `GET`, `DELETE` on `/knowledge-base/documents` (and the future `/knowledge-base/accounts/:id` from 8e).
- Implement as a NestJS `Guard` so applying it to endpoints is a one-line decorator.
- Env var: `KB_INTERNAL_API_KEY`. Required at boot.
- Rotation strategy documented (env-var swap + deploy = key rotation; no in-app key management needed for v1).

**Why third:** Security is non-negotiable before customer #2. Doing it before 8d (idempotency) and 8e (more endpoints) means new endpoints inherit the guard.

---

## 8d — Idempotency, integrity, & resilience hardening

**Goal:** Defend against the failure modes flagged across earlier phases. None of these are blockers today; all become real at production scale.

**Items:**
- **Deterministic Qdrant point IDs** derived from `(account_id, document_id, chunk_index)` so re-ingest cleanly upserts instead of leaving orphans on partial failure.
- **Stuck-job detector** — scheduled job that finds DDB records with `status: "processing"` and `_lastUpdated_` older than N minutes (suggested: 10), re-queues them via BullMQ. Slack-alerts on detection (8b dependency).
- **Voyage dimension runtime guard** — startup probe that calls Voyage with a known input, asserts the returned vector length matches the Qdrant collection's configured dimension. Refuses to boot if mismatched.
- **Compensation logic for partial-failure during update** — currently we accept temporary inconsistency on a partial Qdrant write. Add a "document is in flux, retry me" marker the worker can detect on retry.
- **Orphan-vector cleanup** — scheduled scan that finds Qdrant points with `document_id` values that have no DDB record, deletes them. Catches the artifacts from prior partial failures before deterministic IDs landed.
- **Anthropic retry-with-backoff** on rate limits during enrichment. Currently a 429 falls through to "embed without enrichment." Better: backoff-and-retry once before falling through.
- **GSI on `(account_id, external_id)`** for direct lookup at high doc-count per account. Add when an account hits ~100 docs and lookup latency becomes measurable.

**Why fourth:** These defend against bugs we've explicitly identified. Doing them before 8e means the operational endpoints are built on a more-correct foundation.

---

## 8e — Operational endpoints (admin tooling)

**Goal:** Tools an operator (or a future CMS view) needs to support customers.

**Items:**
- `GET /knowledge-base/documents?account_id=...` — paginated list of an account's documents (status, chunk count, timestamps). Currently no way to see "what's in there."
- `DELETE /knowledge-base/accounts/:account_id` — bulk wipe when a client cancels their subscription. Tied to 8c's auth.
- Manual re-enrichment trigger endpoint — lets an operator request "re-run enrichment for documents that failed during the last Anthropic outage" without requiring the upstream API to re-POST.
- BullMQ dashboard / dead-letter queue inspection (decide between embedding `bull-board` or just a small custom diagnostics endpoint).

**Why fifth:** Needed when there are real customers to support. Built on top of 8c's auth.

---

## 8f — Quality & cost levers

**Goal:** Knobs to tune retrieval quality and cost based on real production data. **Defer until you have that data** — premature tuning here would be optimizing against the dog-walking benchmark.

**Items:**
- **Score threshold filter** on retrieval so genuinely irrelevant chunks don't get returned (lets the agent confidently say "I don't have that").
- **Reranker (Approach 3)** — Voyage `rerank-2` re-scores top-N retrieved chunks for higher precision. Worth measuring after 7b's enrichment lift to see if it's still needed.
- **Per-account ingestion concurrency cap** — today the 5-way enrichment concurrency is global; one heavy client can starve others' rate budget. Add a per-account ceiling.
- **Per-account / per-plan ingestion limits** — starter / pro / enterprise tiers with document count caps. Lives at the account record level. Discussed with user 2026-04-25.
- **Cost-lever switch to Claude Haiku** for enrichment. Documented in code as a future option; not yet implemented. ~6× cost reduction with some quality tradeoff.
- **Document-level enrichment status field** — `enrichment_status: "complete" | "partial" | "failed"` on the DDB record so operators can identify which documents need re-enrichment after an outage.
- **Per-account retrieval quality dashboard** — small ops view showing average top-K cosine similarity per account over time, so quality regressions per client are detectable.
- **Multi-worker scaling** — today: 1 worker per process. Scaling out is a deployment-config concern + minor code adjustments to ensure thread-safety.
- **De-dup by `(account_id, external_id)` job-key** — prevents two concurrent updates for the same document from racing.

**Why last:** Most of these are tuning knobs whose right value depends on real production traffic. Implementing them speculatively against the dog-walking benchmark would be premature optimization.

---

## Items expected to land later as new sub-phases emerge

This is a living document. As Phase 7c-and-beyond surfaces additional considerations during operation, append them here under the appropriate sub-phase. If new themes emerge that don't fit any existing sub-phase, propose a new sub-phase letter.

---

## Origin trace (for historical context)

Each item above was originally surfaced and deferred during a specific phase. The mapping (preserved for traceability):

- **Phase 4** → 8c (internal-API auth), 8d (Voyage dimension guard, deterministic point IDs)
- **Phase 5** → 8f (score threshold, reranker)
- **Phase 6** → 8f (per-account quality dashboard)
- **Phase 7a** → 8d (compensation logic, GSI), 8e (bulk delete, list endpoints)
- **Phase 7b** → 8a/8b (Sentry+Slack on enrichment failures), 8d (Anthropic retry-with-backoff, document enrichment_status), 8f (per-account concurrency cap, per-plan limits, Haiku lever)
- **Phase 7c** → 8b (Slack alerts via stuck-job detector), 8d (stuck-job detector, dead-letter inspection), 8e (manual retry endpoint), 8f (multi-worker, de-dup by external_id)
