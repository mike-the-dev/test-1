# Knowledge Base — Data Flows

Visual reference for every request flow in the Knowledge Base feature.

**Current state**: Phases 1–5 + Phase 6 (benchmark) + Phase 7a (update + delete + naming alignment) + Phase 7b (Claude enrichment at ingestion) + Phase 7c (Redis + BullMQ async queue).

---

## Flow 1 — Document Ingestion (create path, async)

**Triggered by:** the upstream control-panel API when a client uploads a NEW PDF (no existing `external_id` for this account).

**Endpoint:** `POST /knowledge-base/documents`
**Returns:** `202 Accepted` within ~100ms; upstream polls Flow 5 for completion.

```
Upstream control-panel API extracts text from PDF
        │
        │  POST /knowledge-base/documents
        │  { account_id, external_id, title, text, source_type, mime_type? }
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ ai-chat-session-api (NestJS) — HTTP request phase               │
│                                                                 │
│  1. Validation pipe (zod)                                       │
│        ↓                                                        │
│  2. Strip "A#" prefix from account_id                           │
│        ↓                                                        │
│  3. Look up DDB by (account_id, external_id)                    │
│        → Not found, proceed as create                           │
│        ↓                                                        │
│  4. Generate document_id (ulid)                                 │
│        ↓                                                        │
│  5. PutItem DDB record with status: "pending" ────► DynamoDB    │
│        ↓                                                        │
│  6. queue.add("ingest", payload) ─────────────────► Redis       │
│        ↓                                                        │
│  7. Return { document_id, status: "pending", _createdAt_ }      │
└─────────────────────────────────────────────────────────────────┘
                                                  202 Accepted

--- Background worker (BullMQ picks up the job within seconds) ---

┌─────────────────────────────────────────────────────────────────┐
│ KnowledgeBaseIngestionProcessor (BullMQ worker)                 │
│                                                                 │
│  1. UpdateItem DDB: status → "processing" ────────► DynamoDB    │
│        ↓                                                        │
│  2. Chunker (pure local) — text → array of chunks               │
│        ↓                                                        │
│  3. Claude enrichment (one call per chunk, 5-way cap)           │
│       Per-chunk: SUMMARY + QUESTIONS + KEY TERMS ───────► Anthropic API
│       ←──── enrichment text (or null on failure)                │
│       Combined text = chunk_text + "\n\n" + enrichment          │
│       On failure: embed chunk_text only (graceful degradation)  │
│        ↓                                                        │
│  4. Voyage.embedTexts(combined texts) ────────► Voyage API      │
│        ←──── vectors[] (1024 dims each)                         │
│        ↓                                                        │
│  5. Ensure Qdrant collection exists ──────────► Qdrant          │
│        ↓                                                        │
│  6. Ensure account_id payload index ──────────► Qdrant          │
│        ↓                                                        │
│  7. Upsert points (one per chunk)  ────────────► Qdrant         │
│       payload includes chunk_text + enrichment (if present)     │
│        ↓                                                        │
│  8. PutItem DDB record with status: "ready",                    │
│     chunk_count, _lastUpdated_ ──────────────► DynamoDB         │
└─────────────────────────────────────────────────────────────────┘

On transient failure (Voyage/Qdrant/DDB outage): BullMQ retries
up to 3 times with exponential backoff (1s, 2s, 4s).
On final failure: UpdateItem DDB status → "failed" + error_summary.
```

**Cost (per ingestion, one-time):**
- Claude enrichment: ~$0.005 per chunk (~700 input + ~200 output tokens at Sonnet pricing)
  - 15-chunk document: ~$0.07
  - 25-chunk document: ~$0.13
  - 150-chunk document: ~$0.75
- Voyage embeddings: ~$0.04 per 300-page document (input text is now slightly longer but cost change is negligible)
- Qdrant + DynamoDB writes: negligible

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

## Flow 3 — Document Update (re-ingest, same external_id, async)

**Triggered by:** the upstream control-panel API when a client edits an existing PDF in their CMS.

**Endpoint:** `POST /knowledge-base/documents` (same as create — the service detects this is an update by looking up `(account_id, external_id)` in DynamoDB).
**Returns:** `202 Accepted`; upstream polls Flow 5 for completion.

```
Upstream sends updated text for an existing external_id
        │
        │  POST /knowledge-base/documents
        │  { account_id, external_id (existing), title, text, source_type }
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ ai-chat-session-api (NestJS) — HTTP request phase               │
│                                                                 │
│  1. Validation + prefix strip (same as create)                  │
│        ↓                                                        │
│  2. Look up DDB by (account_id, external_id)                    │
│        → FOUND existing record; reuse document_id, _createdAt_  │
│        ↓                                                        │
│  3. PutItem DDB record with status: "pending",                  │
│     preserving existing document_id and _createdAt_ ─► DynamoDB │
│        ↓                                                        │
│  4. queue.add("ingest", payload) ─────────────────► Redis       │
│        ↓                                                        │
│  5. Return { document_id, status: "pending", _createdAt_ }      │
└─────────────────────────────────────────────────────────────────┘
                                                  202 Accepted

--- Background worker (BullMQ picks up the job within seconds) ---

┌─────────────────────────────────────────────────────────────────┐
│ KnowledgeBaseIngestionProcessor (BullMQ worker)                 │
│                                                                 │
│  1. UpdateItem DDB: status → "processing" ────────► DynamoDB    │
│        ↓                                                        │
│  2. Chunker → new chunks                                        │
│        ↓                                                        │
│  3. Claude enrichment (one call per chunk, 5-way cap) ──► Anthropic API
│       Combined text = chunk_text + "\n\n" + enrichment          │
│       On failure: embed chunk_text only                         │
│        ↓                                                        │
│  4. Voyage.embedTexts → new vectors  ─────────► Voyage API      │
│        ↓                                                        │
│  5. Ensure collection + index (idempotent, no-op)               │
│        ↓                                                        │
│  6. Qdrant DELETE points where                                  │
│       account_id = X AND document_id = Y                        │
│       wait: true  ← critical for ordering                       │
│        ↓                                                        │
│  7. Qdrant UPSERT new points ──────────────────► Qdrant         │
│        ↓                                                        │
│  8. PutItem DDB record with status: "ready",                    │
│     chunk_count, _createdAt_ (preserved),                       │
│     _lastUpdated_ (now) ──────────────────────► DynamoDB        │
└─────────────────────────────────────────────────────────────────┘

On transient failure: BullMQ retries up to 3 times with exponential
backoff (1s, 2s, 4s). The pipeline is idempotent: a retry will
find the partially-bad state, delete remaining old chunks, and write
fresh. On final failure: UpdateItem DDB status → "failed" + error_summary.
```

**Why `wait: true` on the delete:** without it, the Qdrant delete is acknowledged but not yet applied. The subsequent upsert would race with the delete, leaving transient duplication. `wait: true` blocks until the delete is fully visible.

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

## Flow 5 — Document Status Check (new in Phase 7c)

**Triggered by:** the upstream control-panel API polling for ingestion completion after receiving a 202.

**Endpoint:** `GET /knowledge-base/documents?account_id=A%23<ulid>&external_id=<id>`

```
Upstream polls for document status
        │
        │  GET /knowledge-base/documents
        │  ?account_id=A%23<ulid>&external_id=<id>
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ ai-chat-session-api (NestJS)                                    │
│                                                                 │
│  1. Validation pipe (zod query params)                          │
│        → 400 on missing/invalid params                          │
│        ↓                                                        │
│  2. Strip "A#" prefix from account_id                           │
│        ↓                                                        │
│  3. Look up DDB by (account_id, external_id) ─────► DynamoDB    │
│        → Not found → 404                                        │
│        → Found → return full record                             │
│        ↓                                                        │
│  4. Return full document record                                 │
│     { document_id, account_id, external_id, title, source_type, │
│       mime_type?, chunk_count?, status, _createdAt_,            │
│       _lastUpdated_, error_summary? }                           │
└─────────────────────────────────────────────────────────────────┘
                                     200 OK / 404 Not Found / 400 Bad Request
```

**Status transitions the caller will observe:**
- `"pending"` → job is queued, worker hasn't started yet
- `"processing"` → worker is actively running the pipeline
- `"ready"` → pipeline completed successfully; `chunk_count` is present
- `"failed"` → pipeline failed after all retries; `error_summary` is present

---

## Per-account isolation (the invariant that makes this multi-tenant)

Every Qdrant operation — `search`, `upsert`, `delete` — carries `account_id` as part of its filter or payload. There is no code path in any flow above that reaches Qdrant without `account_id`. The Qdrant collection has a `keyword` payload index on `account_id` (created lazily on first ingestion) so these filtered operations remain fast as the collection grows.

This invariant is the single most important correctness property of the entire feature. Every code review since Phase 4 has explicitly verified it.
