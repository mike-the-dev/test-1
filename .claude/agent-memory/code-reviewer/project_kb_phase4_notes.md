---
name: Knowledge Base Phase 4 ingestion decisions
description: User-approved overrides and design decisions for Phase 4 ingestion endpoint reviewed in April 2026
type: project
---

Phase 4 ingestion endpoint ships POST /knowledge-base/documents; synchronous, no auth in Phase 4.

**Why:** Phase 5 (retrieval tool) depends on account_ulid payload index and the Qdrant collection being created by Phase 4.

**How to apply:** When reviewing Phase 5, confirm retrieval queries filter on account_ulid keyword index. The index is only created when the collection is first created (ensureCollection path) — if the collection already pre-exists without the index, the index will never be created. Flag this if Phase 5 retrieval fails silently with no filter.

Approved overrides:
- A#-prefixed accountUlid accepted by schema; controller strips prefix before passing raw ULID to service (mirrors WebChatController convention, NOT the original plan which expected a raw ULID).
- createPayloadIndex on account_ulid runs immediately after collection creation (plan originally deferred this to Phase 5).
- No startup dimension guard for vector size 1024 (deferred to Phase 8).
- Type names were renamed: IngestDocumentInput → KnowledgeBaseIngestDocumentInput, IngestDocumentResult → KnowledgeBaseIngestDocumentResult.
