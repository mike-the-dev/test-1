---
name: Phase 8d-essential KB integrity — codebase findings
description: Key facts discovered during Phase 8d arch-planning for Voyage dim guard and deterministic Qdrant point IDs
type: project
---

**The only randomUUID() call for Qdrant point IDs is in `writeQdrantPoints` in `src/services/knowledge-base-ingestion.service.ts` (line ~410).** The BullMQ processor (`src/processors/knowledge-base-ingestion.processor.ts`) delegates entirely to `ingestionService.ingestDocument()` — no Qdrant point construction logic there.

**`EXPECTED_VOYAGE_DIMENSION` (1024) lives in `knowledge-base-ingestion.service.ts`** as `KB_VECTOR_SIZE` before this phase. It is the source of truth for both the Qdrant collection vector size and the dim guard assertion. It must be renamed and exported for `VoyageDimGuardService` to import.

**`uuid` is NOT in `package.json`.** Must be added as a production dependency before any `uuidv5` usage.

**`VoyageDimGuardService` is a separate injectable service called from `main.ts`, not an `OnModuleInit` hook on `VoyageService`.** Rationale: `OnModuleInit` fires inside `NestFactory.create()` and would contaminate the `VoyageService` spec with unexpected boot-probe calls. The `main.ts` pattern (`app.get(VoyageDimGuardService); await dimGuard.checkDimension()`) keeps the service independently testable and `process.exit(1)` in `main.ts` (not the service).

**The existing `knowledge-base-ingestion.service.spec.ts` mocks `crypto.randomUUID` at module level** — this mock must be removed entirely when the call site is replaced with `generatePointId`. The spec already directly imports `generatePointId` for assertions in the new retry-idempotency tests.

**KB_POINT_ID_NAMESPACE committed value: `a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c`** — generated for this plan. Immutable once shipped; changing it invalidates all deterministic point IDs.

**Why:** Deterministic IDs make the update flow (delete-by-document_id → upsert) idempotent at every crash point. The dim guard prevents silent contamination when VOYAGE_MODEL changes produce a different vector dimension than the Qdrant collection was configured for.

**How to apply:** Any future feature touching Qdrant point construction must use `generatePointId` from `src/utils/knowledge-base/qdrant-point-id.ts`. Any future change to the Voyage model dimension must update `EXPECTED_VOYAGE_DIMENSION` in `knowledge-base-ingestion.service.ts` simultaneously — the dim guard will catch mismatches at boot if this is missed.
