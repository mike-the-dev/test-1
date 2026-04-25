# Knowledge Base — Data Flows

Visual reference for every request flow in the Knowledge Base feature.

**Current state**: Phases 1–5 + Phase 6 (benchmark) + Phase 7a (update + delete + naming alignment).

**Forward changes will be added here**: Phase 7b (Claude enrichment at ingestion) modifies Flow 1 and Flow 3. Phase 7c (Redis + Bull async queue) refactors Flow 1 and Flow 3 to async with status tracking.

---

## Flow 1 — Document Ingestion (create path)

**Triggered by:** the upstream control-panel API when a client uploads a NEW PDF (no existing `external_id` for this account).

**Endpoint:** `POST /knowledge-base/documents`

```
Upstream control-panel API extracts text from PDF
        │
        │  POST /knowledge-base/documents
        │  { account_id, external_id, title, text, source_type, mime_type? }
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ ai-chat-session-api (NestJS)                                    │
│                                                                 │
│  1. Validation pipe (zod)                                       │
│        ↓                                                        │
│  2. Strip "A#" prefix from account_id                           │
│        ↓                                                        │
│  3. Generate document_id (ulid)                                 │
│        ↓                                                        │
│  4. Look up DDB by (account_id, external_id)                    │
│        → Not found, proceed as create                           │
│        ↓                                                        │
│  5. Chunker (pure local) — text → array of chunks               │
│        ↓                                                        │
│  6. Voyage.embedTexts(chunk texts) ───────► Voyage API          │
│        ←──── vectors[] (1024 dims each)                         │
│        ↓                                                        │
│  7. Ensure Qdrant collection exists ──────► Qdrant              │
│        ↓                                                        │
│  8. Ensure account_id payload index ──────► Qdrant              │
│        ↓                                                        │
│  9. Upsert points (one per chunk)  ───────► Qdrant              │
│        ↓                                                        │
│ 10. PutItem (DDB record) ─────────────────► DynamoDB            │
│        ↓                                                        │
│ 11. Return { document_id, chunk_count, status,                  │
│              _createdAt_, _lastUpdated_ }                       │
└─────────────────────────────────────────────────────────────────┘
                                                  201 Created
```

**Cost (per ingestion, one-time):**
- Voyage embeddings: ~$0.04 per 300-page document
- Qdrant + DynamoDB writes: negligible
- Claude calls: zero (Phase 7b will add per-chunk enrichment calls here)

---

## Flow 2 — Customer Query (the read path)

**Triggered by:** a visitor sending a message in the embedded chat widget on a client's website.

**Endpoint:** `POST /chat/web/messages` (existing web-chat infrastructure, unchanged by KB phases)

```
Visitor sends message in widget
        │
        │  POST /chat/web/messages
        │  { sessionUlid, message: "What do I do if my dog gets hurt?" }
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ ai-chat-session-api (NestJS)                                    │
│                                                                 │
│  1. ChatSessionService.handleMessage()                          │
│        ↓                                                        │
│  2. Load session + history from DynamoDB                        │
│        ↓                                                        │
│  3. Send to Claude (Anthropic) with hybrid prompt + tools       │
│        ─────────────────────────────────► Anthropic API         │
│        ↓                                                        │
│  4. Claude decides to call lookup_knowledge_base                │
│        ↓                                                        │
│ ┌──────────────────────────────────────────────────┐            │
│ │ lookup_knowledge_base tool                       │            │
│ │                                                  │            │
│ │  a. Voyage.embedText(query) ─► Voyage API        │            │
│ │     ←──── query vector                           │            │
│ │                                                  │            │
│ │  b. Qdrant.search(                               │            │
│ │       collection: knowledge_base,                │            │
│ │       vector: query_vector,                      │            │
│ │       filter: account_id = X,  ← per-account     │            │
│ │       limit: 5                                   │            │
│ │     ) ─────► Qdrant                              │            │
│ │     ←──── top 5 ScoredPoints with payloads       │            │
│ │                                                  │            │
│ │  c. Map to { chunks, count } JSON                │            │
│ └──────────────────────────────────────────────────┘            │
│        ↓                                                        │
│  5. Tool result returned to Claude                              │
│        ↓                                                        │
│  6. Claude reads chunks, writes grounded answer                 │
│        ─────────────────────────────────► Anthropic API         │
│        ←──── final response text                                │
│        ↓                                                        │
│  7. Persist message + response to DynamoDB                      │
│        ↓                                                        │
│  8. Return { reply, tool_outputs? }                             │
└─────────────────────────────────────────────────────────────────┘
```

**Cost (per customer message that hits KB):**
- Voyage query embedding: ~$0.000003 (one short input)
- Qdrant search: included
- Claude reading top-5 chunks: ~$0.005 in additional input tokens
- Total: roughly **$0.005–$0.01 per query**, regardless of how big the client's KB is

This is the "flat per-query cost" property — adding more documents to a client's KB does NOT increase the cost of any single conversation.

---

## Flow 3 — Document Update (re-ingest, same external_id)

**Triggered by:** the upstream control-panel API when a client edits an existing PDF in their CMS.

**Endpoint:** `POST /knowledge-base/documents` (same as create — the service detects this is an update by looking up `(account_id, external_id)` in DynamoDB).

```
Upstream sends updated text for an existing external_id
        │
        │  POST /knowledge-base/documents
        │  { account_id, external_id (existing), title, text, source_type }
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ ai-chat-session-api (NestJS)                                    │
│                                                                 │
│  1. Validation + prefix strip (same as create)                  │
│        ↓                                                        │
│  2. Look up DDB by (account_id, external_id)                    │
│        → FOUND existing record                                  │
│        ↓                                                        │
│  3. Reuse existing document_id; preserve _createdAt_;           │
│     set _lastUpdated_ to now                                    │
│        ↓                                                        │
│  4. Chunker → new chunks                                        │
│        ↓                                                        │
│  5. Voyage.embedTexts → new vectors                             │
│        ↓                                                        │
│  6. Ensure collection + index (idempotent, no-op)               │
│        ↓                                                        │
│  7. Qdrant DELETE points where                                  │
│       account_id = X AND document_id = Y                        │
│       wait: true  ← critical for ordering                       │
│        ↓                                                        │
│  8. Qdrant UPSERT new points                                    │
│        ↓                                                        │
│  9. DDB PutItem (replaces existing record at same PK+SK)        │
│        ↓                                                        │
│ 10. Return { document_id, chunk_count, status,                  │
│              _createdAt_ (preserved),                           │
│              _lastUpdated_ (now) }                              │
└─────────────────────────────────────────────────────────────────┘
                                                  201 Created
```

**Why `wait: true` on the delete:** without it, the Qdrant delete is acknowledged but not yet applied. The subsequent upsert would race with the delete, leaving transient duplication. `wait: true` blocks until the delete is fully visible.

**Failure mode:** If any step fails, return 500. Upstream retries. The pipeline is idempotent — re-running it from step 1 will find the partially-bad state, delete remaining old chunks, and write fresh.

---

## Flow 4 — Document Delete

**Triggered by:** the upstream API when a client retires a document.

**Endpoint:** `DELETE /knowledge-base/documents`

```
Upstream sends delete request
        │
        │  DELETE /knowledge-base/documents
        │  { account_id, external_id }
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ ai-chat-session-api (NestJS)                                    │
│                                                                 │
│  1. Validation pipe                                             │
│        ↓                                                        │
│  2. Strip "A#" prefix                                           │
│        ↓                                                        │
│  3. Look up DDB by (account_id, external_id)                    │
│        ↓                                                        │
│  4a. NOT FOUND → return 204 (idempotent no-op)                  │
│  4b. FOUND → proceed                                            │
│        ↓                                                        │
│  5. Qdrant DELETE points where                                  │
│       account_id = X AND document_id = Y                        │
│       wait: true                                                │
│        ↓                                                        │
│  6. DDB DeleteCommand (remove record)                           │
│        ↓                                                        │
│  7. Return 204 No Content                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Idempotency:** A second DELETE call for the same `(account_id, external_id)` returns 204 immediately on the not-found branch. Safe for upstream retry on network failures.

---

## Per-account isolation (the invariant that makes this multi-tenant)

Every Qdrant operation — `search`, `upsert`, `delete` — carries `account_id` as part of its filter or payload. There is no code path in any flow above that reaches Qdrant without `account_id`. The Qdrant collection has a `keyword` payload index on `account_id` (created lazily on first ingestion) so these filtered operations remain fast as the collection grows.

This invariant is the single most important correctness property of the entire feature. Every code review since Phase 4 has explicitly verified it.
