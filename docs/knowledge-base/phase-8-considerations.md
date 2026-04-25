# Phase 8 — Operational Hardening Considerations

Running scratchpad of items deferred to Phase 8 from earlier phases. Not a brief — this is the input that the Phase 8 brief will be written from when we get there.

The unifying theme: everything that was acceptable for an MVP / pilot but needs a real answer before serving 200+ ecommerce stores in production.

---

## Deferred items, grouped by origin phase

### From Phase 4 (ingestion endpoint)

- **Voyage model/dimension runtime guard.** Vector size is hardcoded to 1024 (matching `voyage-3-large`). If the `VOYAGE_MODEL` env var ever changes to a model with different output dims, ingestion silently breaks at the Qdrant upsert step. Add a startup assertion that calls Voyage with a probe, asserts the returned vector length, and refuses to boot if it doesn't match the collection's configured dimension.
- **Internal-API auth on `POST /knowledge-base/documents` and `DELETE /knowledge-base/documents`.** Currently these endpoints accept the upstream control-panel API's calls with no authentication beyond the `account_id` in the body. For production, lock these down with either a shared secret header or mTLS so unauthorized callers can't ingest or delete on behalf of arbitrary accounts.
- **Deterministic point IDs for chunk-level idempotency.** Currently each chunk gets a fresh `randomUUID`. If a partial failure during an update leaves some new chunks written and some not, retry creates additional new points instead of overwriting. Switch to deterministic IDs derived from `(account_id, document_id, chunk_index)` so re-ingest cleanly upserts.

### From Phase 5 (retrieval tool)

- **Score threshold filter.** Tool currently returns top-K unconditionally. Add an optional minimum-cosine-similarity threshold so unrelated chunks don't get returned for queries that genuinely have no relevant content (so the agent can confidently say "I don't have that").
- **Reranker (Approach 3).** Voyage `rerank-2` model re-scores the top-N retrieved chunks against the query for higher precision. Worth measuring after Phase 7b lands — if enrichment lifts top-K relevance to where reranking is unnecessary, skip; if it doesn't, add.

### From Phase 6 (benchmark + observability)

- **Per-account retrieval quality dashboard.** Today there's no way to see "what is the average top-K cosine similarity for Account X over the last week?" Build a small ops view (or push to existing analytics) so operators can detect quality regressions per client.

### From Phase 7a (document lifecycle)

- **GSI on `(account_id, external_id)`.** Lookup currently uses a partition Query + FilterExpression. Fine at small per-account doc counts; becomes a bottleneck at hundreds of docs per account. Add a GSI for direct lookup when needed.
- **Compensation logic for partial-failure during update.** If an update's "delete old chunks → write new chunks → write DDB" sequence fails partway, today we accept temporary inconsistency and rely on upstream retry. Build a more deliberate compensation pattern (or a marker that indicates "this document is in flux, retry me") for production.
- **Bulk delete for an entire account.** When a client cancels their subscription, we need to wipe all of their KB content. Today there's no endpoint for this. Add `DELETE /knowledge-base/accounts/:account_id` with appropriate auth.
- **List / admin endpoints.** No `GET` endpoint exists for "what documents does this account have?" Useful for a CMS view, debugging, and verifying ingest state. Add `GET /knowledge-base/documents?account_id=...` (paginated).

### From Phase 7b (Claude enrichment)

- **Sentry/Slack alerting on enrichment failures.** Today: a `WARN` log fires when chunks fail enrichment. Operators only see this if they're reading logs. Production needs active alerts: per-chunk warning at high failure rate, page-worthy alert when an entire document's chunks all fail (likely Anthropic outage).
- **Retry-with-backoff on Anthropic rate limits.** Today: a 429 response from Anthropic falls back to "embed without enrichment for that chunk." For a high-traffic ingestion period this can degrade quality silently. Add exponential backoff with a jitter for 429s.
- **Per-account ingestion concurrency cap.** Today: the 5-way concurrency limit is global within a single ingestion. One client uploading a 300-chunk doc can monopolize Anthropic's rate budget for all other concurrent ingestions. Add a per-account limit so heavy uploaders don't starve other accounts.
- **Per-account / per-plan ingestion limits.** Discussed with user on 2026-04-25: starter plans cap at e.g. 50 docs, pro plans at 500, enterprise unlimited. Implementation likely lives at the account record level. Need a small enum + check at ingestion time.
- **Document-level enrichment status field.** Today: DDB record has `status: "ready"` regardless of whether Anthropic was up during ingestion. Add an `enrichment_status: "complete" | "partial" | "failed"` field so operators can identify documents that need re-enrichment after an outage.
- **Cost-lever switch to Claude Haiku.** Documented in Phase 7b's enrichment service constants but not implemented. Switching cuts enrichment cost by ~6×; trade-off is some quality drop. Worth measuring on real client data and offering as a per-plan setting.

### From Phase 7c (async queue, when designed)

- (Items to be added once Phase 7c brief is drafted.)

---

## Cross-cutting Phase 8 themes

When we write the Phase 8 brief, these are the natural groupings to organize the work around:

1. **Observability** — Sentry integration, Slack alerts, per-account quality dashboards, enrichment-status tracking.
2. **Rate-limit defenses** — Retries with backoff, per-account budgets, Anthropic outage detection.
3. **Idempotency hardening** — Deterministic point IDs, compensation logic for partial failures, deduplication of orphaned vectors.
4. **Operational endpoints** — List, bulk delete, admin debug views, manual re-enrichment trigger.
5. **Tenancy hardening** — Internal-API auth on KB endpoints, per-account quotas, per-plan limits.
6. **Cost controls** — Haiku option for enrichment, per-plan tiering, budget alerts when an account exceeds expected ingestion volume.

---

## Living document

This file is appended to (not edited in place) as new items get deferred from later phases. Each item should preserve enough context to re-establish "why this matters" when Phase 8 is finally written.
