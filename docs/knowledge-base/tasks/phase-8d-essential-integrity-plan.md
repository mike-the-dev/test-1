# Phase 8d-essential — Integrity Hardening: Implementation Plan

---

## Overview

This phase closes two correctness gaps in the KB pipeline before v1. The first is a startup probe that embeds a fixed string via Voyage, asserts the returned vector length equals 1024, and terminates the process (with Sentry notification) on any mismatch or Voyage outage — ensuring the app never serves traffic with a corrupted embedding pipeline. The second is a switch from `crypto.randomUUID()` to `uuidv5`-derived deterministic point IDs, keyed on `(accountId, documentId, chunkIndex)`, so that re-ingesting or retrying a document upserts cleanly rather than producing orphan vectors. Both work items involve no schema migration: pre-existing random-UUID Qdrant points are left in place and will migrate naturally as documents are updated.

---

## Contract Verification Findings

### Voyage AI — `voyage-3-large` response shape
- **Vector length:** 1024 dimensions (default output dimension for `voyage-3-large`). Other valid values are 2048, 512, and 256 when `output_dim` is explicitly passed; the project never passes `output_dim`, so 1024 is always returned.
- **Response shape used by `VoyageService.embedTexts`:** `response.data[].embedding` — each item is a `number[]`. The service already sorts by `.index` before extracting. A dim-guard probe that calls `embedText("voyage-dimension-probe")` returns a single `number[]` whose `.length` is 1024 when the correct model is deployed.
- **Errors:** `VoyageAIError` with a `statusCode` field for API errors; a generic `Error` for network failures. Both are already handled in `VoyageService.embedTexts` and wrapped into safe error messages before re-throwing.
- **Source:** https://docs.voyageai.com/reference/embeddings-api

### Qdrant point ID semantics (js-client-rest v1.17.0)
- **Accepted ID formats:** unsigned integer OR UUID string (RFC 4122). Both are valid Qdrant point IDs. The existing codebase passes UUIDs from `crypto.randomUUID()`, so switching to `uuidv5`-generated UUIDs (also valid RFC 4122 format) requires no collection or index changes.
- **Upsert with duplicate ID:** Qdrant's `upsert` operation performs a full replacement when a point with the same ID already exists — the vector and full payload are overwritten atomically. This is the property that makes deterministic IDs give retry idempotency: upserting the same point ID twice produces one point, not two.
- **Source:** Qdrant documentation on points (https://qdrant.tech/documentation/concepts/points/)

### `uuid` npm package — `uuidv5` API
- **Package status:** `uuid` is NOT in `package.json` (confirmed). It must be added as a production dependency.
- **Import style:** `import { v5 as uuidv5 } from "uuid"` — named export with alias.
- **Signature:** `uuidv5(name: string, namespace: string): string` — both arguments are strings. The namespace must be a valid UUID string (e.g., `"a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c"`). Predefined namespaces `uuidv5.DNS` and `uuidv5.URL` exist but are not appropriate here.
- **Determinism:** Identical `(name, namespace)` inputs always produce identical output. Different inputs produce different outputs (SHA-1-based; collision probability negligible at KB scale).
- **Return type:** `string` — a valid lowercase UUID string, directly usable as a Qdrant point ID.
- **Source:** https://github.com/uuidjs/uuid/blob/main/README.md and https://www.npmjs.com/package/uuid

---

## Affected Files and Modules

### Create
| File | Purpose |
|------|---------|
| `src/utils/knowledge-base/qdrant-point-id.ts` | Pure helper: `generatePointId(accountId, documentId, chunkIndex)` returning `uuidv5` UUID. Exports `KB_POINT_ID_NAMESPACE` constant. |
| `src/utils/knowledge-base/qdrant-point-id.spec.ts` | Unit tests: determinism, per-field sensitivity, namespace constant stability |
| `src/services/voyage-dim-guard.service.ts` | `VoyageDimGuardService` — injectable service with `checkDimension()` method: probes Voyage, asserts 1024-dim, logs + Sentry-captures + throws on failure |
| `src/services/voyage-dim-guard.service.spec.ts` | Unit tests: pass case, dim-mismatch case, Voyage outage cases (retry exhaustion), Sentry tagging |

### Modify
| File | Change |
|------|--------|
| `src/services/knowledge-base-ingestion.service.ts` | Replace `randomUUID()` import and call in `writeQdrantPoints` with `generatePointId(accountId, documentId, chunkIndex)` |
| `src/services/knowledge-base-ingestion.service.spec.ts` | Remove `jest.mock("crypto", ...)` for `randomUUID`; update point-ID assertions to use deterministic values; add retry idempotency test |
| `src/main.ts` | After `NestFactory.create`, before `app.listen`: retrieve `VoyageDimGuardService` from the app context and call `checkDimension()` |
| `src/app.module.ts` | Add `VoyageDimGuardService` to providers array |
| `docs/knowledge-base/data-flows.md` | Append a note to Flow 1 and Flow 3 documenting `KB_POINT_ID_NAMESPACE` immutability and the no-migration policy |
| `package.json` | Add `uuid` as a production dependency (latest stable: `^11.0.0`) |

### Review Only (no change)
| File | Reason |
|------|--------|
| `src/services/voyage.service.ts` | Dim guard calls `embedText` on this; no change required |
| `src/providers/qdrant.provider.ts` | `KB_VECTOR_SIZE` (1024) lives in `knowledge-base-ingestion.service.ts`, not here; no change |
| `src/instrument.ts` | Sentry `category` tag convention confirmed; no change needed |
| `src/services/sentry.service.ts` | `captureException` with `tags` is the correct call pattern; no change |
| `src/utils/knowledge-base/constants.ts` | Source file for `KB_COLLECTION_NAME`; reviewed only |
| `src/processors/knowledge-base-ingestion.processor.ts` | Worker delegates to `ingestionService.ingestDocument()`; no Qdrant point ID logic here; no change |

---

## Dependencies and Architectural Considerations

### New npm dependency: `uuid`
- Add `uuid` as a production dependency (`^11.0.0`). Also add `@types/uuid` as a dev dependency — the `uuid` package ships bundled TypeScript types in recent versions but adding `@types/uuid` is safe for compatibility.
- Run `npm install uuid` before implementing. The brief instructs the implementer to do this, not the arch-planner.

### Dim guard service: why a new `VoyageDimGuardService` rather than a method on `VoyageService`
Two options were evaluated:

**Option A — Method on `VoyageService` called via `OnModuleInit`.**
`OnModuleInit.onModuleInit()` fires during `NestFactory.create()` — before the app accepts traffic, but also before `main.ts` has a chance to run its own startup logic. This placement is semantically correct but has a timing problem: if the `OnModuleInit` hook throws, `NestFactory.create()` rejects, and `main.ts` cannot run any cleanup or alternative logging before the process exits. The `Logger` available at that point has no context prefix unless the service supplies one.

More importantly, wiring the dim guard into `VoyageService.onModuleInit` would make the dim guard fire during *every test that instantiates `VoyageService`* — including the existing `voyage.service.spec.ts`. That test mocks the Voyage client but doesn't set up a probe response, so adding an `onModuleInit` hook would cause cascading test failures across the suite.

**Option B (chosen) — Separate `VoyageDimGuardService` called explicitly from `main.ts`.**
`main.ts` calls `app.get(VoyageDimGuardService)` after `NestFactory.create` resolves (DI is fully initialized) and before `app.listen`. The guard service is a thin injectable that depends only on `VoyageService` and `SentryService`. This approach:
- Runs after DI is initialized — all services are available.
- Runs before `app.listen` — the app never accepts traffic on a bad embedding pipeline.
- Is independently testable without affecting `VoyageService`'s own spec.
- Keeps `VoyageService` unchanged (no new lifecycle methods, no new responsibilities).
- Matches the pattern already used in `main.ts` for `OriginAllowlistService` — `app.get(...)` calls are the idiomatic way to access services in `main.ts`.

**Decision: Option B.**

### Source-of-truth file for `EXPECTED_VOYAGE_DIMENSION`
The constant `KB_VECTOR_SIZE = 1024` currently lives in `src/services/knowledge-base-ingestion.service.ts` (line 30), where it is used to set the Qdrant collection's vector size on creation. This is the logical source of truth: whoever changes the Qdrant collection dimension must also update this constant, and now the dim guard will read from the same constant so both stay in sync.

The plan does NOT move `KB_VECTOR_SIZE` — it renames it to `EXPECTED_VOYAGE_DIMENSION` so the name reflects its dual role (collection config AND dim-guard expectation). The constant stays in `knowledge-base-ingestion.service.ts`. The `VoyageDimGuardService` imports this named export.

**Important:** `knowledge-base-ingestion.service.ts` must export `EXPECTED_VOYAGE_DIMENSION` so `VoyageDimGuardService` can import it. Currently `KB_VECTOR_SIZE` is not exported. The rename + export is part of step 1 in the implementation sequence.

### `KB_POINT_ID_NAMESPACE` — the namespace UUID
The namespace UUID is generated once and committed permanently. **The value chosen for this plan is:**

```
a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c
```

This value is arbitrary (required by UUIDv5 to be a valid UUID) and was generated for this plan using Node's `crypto.randomUUID()`. It MUST be treated as immutable once committed. Changing it would invalidate every deterministic point ID ever generated — existing points would become unreachable by the update flow's delete-by-document_id operation if IDs no longer match.

The constant must carry a "DO NOT CHANGE" comment in the source code and in `data-flows.md`.

### Startup latency impact
The dim guard adds one Voyage embed call at startup (~300–500ms when Voyage is healthy). With the 2-retry backoff (1s + 2s), worst-case startup extension before bailing is ~3.5s. This is acceptable — the app was already doing Qdrant connectivity checks at startup via `QdrantProvider`.

### Existing random-UUID points co-existing with deterministic points
Both are valid Qdrant point IDs. Retrieval (Flow 2) uses vector-similarity search with `account_id` filter — the ID field is not inspected during retrieval. The hybrid state (random IDs for never-updated docs, deterministic IDs for everything after this phase) is safe and self-healing via the existing update flow.

### Existing spec for `knowledge-base-ingestion.service.spec.ts` — mock update impact
The current spec mocks `crypto.randomUUID` at the module level to produce stable UUIDs for assertion. After this change, `randomUUID` is no longer called for Qdrant point IDs, so:
1. The `jest.mock("crypto", ...)` block is removed entirely (or narrowed to not include `randomUUID` if any other code in the import chain still uses it — confirmed: no other usage in `knowledge-base-ingestion.service.ts`).
2. Point ID assertions in the spec switch from checking the mocked UUID strings to checking the deterministic UUIDv5 values (or asserting that IDs match a UUIDv5 call with the correct inputs).
3. The `randomUUID` mock variable and its `beforeEach` re-setup are removed.

---

## Step-by-Step Implementation Sequence

```
1. [package.json] Add `uuid` and `@types/uuid` as dependencies
   - Why first: every subsequent file that imports `uuid` requires it to be installed
   - Done when: `uuid` appears in `dependencies`, `@types/uuid` appears in `devDependencies`;
     `npm install` runs successfully

2. [src/services/knowledge-base-ingestion.service.ts] Rename KB_VECTOR_SIZE to EXPECTED_VOYAGE_DIMENSION and export it
   - Why here: the dim-guard service (step 3) imports this constant. Renaming before creating
     the guard service avoids a naming inconsistency in the codebase.
   - Change: `const KB_VECTOR_SIZE = 1024` → `export const EXPECTED_VOYAGE_DIMENSION = 1024`
   - Update every usage of KB_VECTOR_SIZE within the file to EXPECTED_VOYAGE_DIMENSION (only
     appears in the `createCollection` call inside `ensureCollection`)
   - Remove the import of `randomUUID` from `crypto` (no longer used after step 5)
   - Done when: TypeScript compiles; the constant is exported; `ensureCollection` still passes
     `EXPECTED_VOYAGE_DIMENSION` as the `size` field to `createCollection`

3. [src/utils/knowledge-base/qdrant-point-id.ts] Create the deterministic point ID helper
   - Why here: the call-site swap in step 5 depends on this utility. Create it before modifying
     the ingestion service.
   - Content:
     ```
     import { v5 as uuidv5 } from "uuid";

     /**
      * Namespace UUID for KB Qdrant point IDs.
      *
      * DO NOT CHANGE — changing this value invalidates every deterministic point ID
      * ever generated. Existing Qdrant points would become orphaned because the update
      * flow's delete-by-document_id would no longer match their IDs. This is a
      * version-1 schema commitment, equivalent to a DynamoDB PK format.
      *
      * Generated once via crypto.randomUUID() on 2026-04-27.
      */
     export const KB_POINT_ID_NAMESPACE = "a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c";

     /**
      * Generates a deterministic Qdrant point ID from the (accountId, documentId, chunkIndex)
      * tuple. Same inputs always produce the same UUID; different inputs produce different UUIDs.
      * Per-account isolation is guaranteed: accountId is part of the input tuple, so two accounts
      * cannot produce colliding point IDs even for the same documentId and chunkIndex.
      */
     export function generatePointId(
       accountId: string,
       documentId: string,
       chunkIndex: number,
     ): string {
       return uuidv5(`${accountId}:${documentId}:${chunkIndex}`, KB_POINT_ID_NAMESPACE);
     }
     ```
   - Done when: TypeScript compiles; pure function returns a valid UUID string

4. [src/utils/knowledge-base/qdrant-point-id.spec.ts] Write deterministic point ID tests
   - Why here: spec immediately follows its source file (project convention); confirms the helper
     before any call site depends on it
   - Test cases (~6 tests):
     a. Same `(accountId, documentId, chunkIndex)` → same UUID (call twice, assert equal)
     b. Different `accountId` → different UUID
     c. Different `documentId` → different UUID
     d. Different `chunkIndex` → different UUID
     e. Returns a string matching UUID format regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`) — version 5 UUID
     f. `KB_POINT_ID_NAMESPACE` equals the hardcoded value "a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c" (regression guard against accidental change)
   - Done when: all 6 tests pass

5. [src/services/knowledge-base-ingestion.service.ts] Replace `randomUUID()` with `generatePointId()` in `writeQdrantPoints`
   - Why here: after the helper exists (step 3) and after the rename (step 2)
   - Remove: `import { randomUUID } from "crypto";` (line 4)
   - Add: `import { generatePointId } from "../utils/knowledge-base/qdrant-point-id";`
   - In `writeQdrantPoints`, change:
     ```
     id: randomUUID(),
     ```
     to:
     ```
     id: generatePointId(input.accountId, documentId, chunk.index),
     ```
   - The `chunk.index` field is already available as `chunk: KnowledgeBaseChunk` has an `index`
     property (confirmed in the existing spec's STUB_CHUNKS fixtures)
   - Done when: TypeScript compiles; `writeQdrantPoints` no longer references `randomUUID`

6. [src/services/knowledge-base-ingestion.service.spec.ts] Update spec to reflect deterministic IDs
   - Why here: after the service is updated; the spec's `randomUUID` mock is now dead code
   - Changes:
     a. Remove the `jest.mock("crypto", ...)` block entirely
     b. Remove the `const { randomUUID } = jest.requireMock<...>("crypto")` line
     c. Remove the `randomUUID.mockReturnValueOnce(...)` calls in `beforeEach`
     d. In the "upserts 3 points" test: replace assertions on `p0.id / p1.id / p2.id` from mocked
        UUID strings to `generatePointId(ACCOUNT_ID, DOCUMENT_ID, 0)` etc. — or remove the ID
        assertion entirely if no test currently asserts on the ID value (review the spec: existing
        tests in the "upserts 3 points" describe block don't assert `.id` — they assert `.payload.*`.
        So removal of the `randomUUID` mock is clean with no test assertion changes needed for
        existing tests.)
     e. Add new test: "upserts points whose IDs are deterministic (same input → same ID on retry)"
        — simulate calling `ingestDocument` twice with the same input; capture both `upsertArgs`
        arrays; assert that each point's `.id` at the same index is identical across both calls.
        This is the retry idempotency test.
     f. Add new test: "upserts points with accountId in the ID derivation" — call ingestDocument
        with two different `accountId` values; assert that the resulting point IDs differ for the
        same chunkIndex. (This validates per-account isolation of point IDs.)
   - Done when: all existing tests still pass; new tests pass; no `randomUUID` mock in file

7. [src/services/voyage-dim-guard.service.ts] Create VoyageDimGuardService
   - Why here: ingestion service is now stable; guard only depends on VoyageService and
     SentryService (both already registered in AppModule)
   - Key design:
     - Imports `EXPECTED_VOYAGE_DIMENSION` from `knowledge-base-ingestion.service.ts`
     - Probe input constant: `const VOYAGE_DIM_PROBE_INPUT = "voyage-dimension-probe"`
     - Retry: 2 retries with linear backoff. Implementation uses a simple loop (not a 3rd-party
       retry lib): attempt 1 → on failure sleep 1000ms → attempt 2 → on failure sleep 2000ms →
       attempt 3 → on final failure, log + capture + throw (main.ts calls process.exit(1) on throw)
     - On dim mismatch (wrong vector length): `Logger.error` with
       `[event=boot_failed reason=voyage_dim_mismatch expected=1024 actual=<n>]`, capture to Sentry
       with `tags: { category: "voyage-dim-guard" }` and level "fatal", then throw an Error
       (do NOT call process.exit here — main.ts handles exit so the guard remains testable)
     - On Voyage outage (embedText throws) after retries exhausted: `Logger.error` with
       `[event=boot_failed reason=voyage_unreachable]`, capture to Sentry same tags, throw
     - On success: `Logger.log` with `[event=boot_ok dim=1024]`, return void
     - Method signature: `async checkDimension(): Promise<void>`
   - Done when: TypeScript compiles; the service is @Injectable() with constructor injection
     of VoyageService and SentryService

8. [src/services/voyage-dim-guard.service.spec.ts] Write dim guard unit tests
   - Why here: immediately after the service; all tests mock VoyageService.embedText
   - Setup: `Test.createTestingModule` with mocked VoyageService and SentryService
   - Test cases (~8 tests):
     a. Pass case: `embedText` returns `Array(1024).fill(0.1)` → `checkDimension` resolves void,
        no Sentry capture
     b. Dim mismatch case: `embedText` returns `Array(768).fill(0.1)` → `checkDimension` rejects,
        Sentry captured with `tags.category = "voyage-dim-guard"`, Logger.error called with
        `event=boot_failed reason=voyage_dim_mismatch expected=1024 actual=768`
     c. Transient failure then success: `embedText` rejects once then resolves → resolves void
        (first retry succeeds)
     d. Two failures then success: `embedText` rejects twice then resolves → resolves void
        (second retry succeeds)
     e. All 3 attempts fail: `embedText` rejects 3 times → `checkDimension` rejects, Sentry
        captured with `tags.category = "voyage-dim-guard"`, Logger.error called with
        `event=boot_failed reason=voyage_unreachable`
     f. Retry delays are respected: spy on global `setTimeout`; assert it's called with 1000ms
        after attempt 1, 2000ms after attempt 2 (or use fake timers)
     g. Logger.error is NOT called on success
     h. Sentry is NOT called on success
   - Done when: all 8 tests pass

9. [src/app.module.ts] Add VoyageDimGuardService to providers
   - Why here: must be in DI container before main.ts calls app.get(VoyageDimGuardService)
   - Add import at top of file:
     `import { VoyageDimGuardService } from "./services/voyage-dim-guard.service";`
   - Add `VoyageDimGuardService` to the providers array (after `VoyageService`)
   - Done when: AppModule compiles; `app.get(VoyageDimGuardService)` in main.ts resolves

10. [src/main.ts] Wire dim guard into bootstrap() — after NestFactory.create, before app.listen
    - Why here: only after AppModule is updated (step 9); this is the final wiring step
    - Add import: `import { VoyageDimGuardService } from "./services/voyage-dim-guard.service";`
    - In `bootstrap()`, immediately after `const app = await NestFactory.create(...)`:
      ```typescript
      const dimGuard = app.get(VoyageDimGuardService);
      try {
        await dimGuard.checkDimension();
      } catch {
        process.exit(1);
      }
      ```
    - `process.exit(1)` lives in `main.ts`, not in the service — keeps the service fully testable
      (tests can catch the thrown error without triggering process exit)
    - Done when: TypeScript compiles; local startup with valid VOYAGE_API_KEY runs the probe
      and continues normally

11. [docs/knowledge-base/data-flows.md] Add KB_POINT_ID_NAMESPACE immutability note
    - Why here: last step — documentation after all code is stable
    - Append to the bottom of Flow 1 and Flow 3 descriptions a note explaining:
      "Point IDs are deterministic UUIDs derived from (accountId, documentId, chunkIndex) via
      UUIDv5 with namespace KB_POINT_ID_NAMESPACE (src/utils/knowledge-base/qdrant-point-id.ts).
      DO NOT change this namespace — doing so would orphan all existing deterministic points."
    - Done when: data-flows.md updated; no code changes
```

---

## Testing Strategy

### `src/utils/knowledge-base/qdrant-point-id.spec.ts` (new)
Pure function tests — no NestJS testing module required. Import `generatePointId` and `KB_POINT_ID_NAMESPACE` directly.

| # | Test | Assertion |
|---|------|-----------|
| 1 | Same tuple → same ID | Two calls with identical `(accountId, documentId, 0)` return `===` strings |
| 2 | Different `accountId` → different ID | `generatePointId("acct-A", "doc-1", 0) !== generatePointId("acct-B", "doc-1", 0)` |
| 3 | Different `documentId` → different ID | `generatePointId("acct-A", "doc-1", 0) !== generatePointId("acct-A", "doc-2", 0)` |
| 4 | Different `chunkIndex` → different ID | `generatePointId("acct-A", "doc-1", 0) !== generatePointId("acct-A", "doc-1", 1)` |
| 5 | Returns v5 UUID | Result matches `/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` |
| 6 | Namespace constant is stable | `expect(KB_POINT_ID_NAMESPACE).toBe("a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c")` |

### `src/services/voyage-dim-guard.service.spec.ts` (new)
Use `Test.createTestingModule` with mocked `VoyageService` (`embedText: jest.fn()`) and mocked `SentryService` (`captureException: jest.fn()`). Use Jest fake timers (`jest.useFakeTimers()`) to avoid real sleep delays.

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 1 | Pass: correct dim | `embedText` resolves `Array(1024).fill(0.1)` | `checkDimension()` resolves; Sentry NOT called |
| 2 | Fail: dim mismatch | `embedText` resolves `Array(768).fill(0.1)` | Rejects; Sentry called with `tags.category="voyage-dim-guard"`; Logger.error contains `reason=voyage_dim_mismatch expected=1024 actual=768` |
| 3 | Transient fail then success | `embedText` rejects once, then resolves correct dim | Resolves void |
| 4 | Two fails then success | `embedText` rejects twice, then resolves correct dim | Resolves void |
| 5 | All 3 fail (outage) | `embedText` always rejects | Rejects; Sentry called; Logger.error contains `reason=voyage_unreachable` |
| 6 | Retry delay: 1s after first fail | Fake timers; embedText rejects once then resolves | `setTimeout` called with `1000` |
| 7 | Retry delay: 2s after second fail | Fake timers; embedText rejects twice then resolves | `setTimeout` called with `2000` |
| 8 | Success: no Logger.error | `embedText` resolves correct dim | Logger.error spy NOT called |

### `src/services/knowledge-base-ingestion.service.spec.ts` (modify existing)
Remove `randomUUID` mock. Add two new tests:

**Retry idempotency test:**
```
"produces identical point IDs on retry (same input → same Qdrant state)"
  - Call ingestDocument(STUB_INPUT) twice
  - Capture upsertArgs from both calls
  - Assert: upsertArgs[0].points[i].id === upsertArgs[1].points[i].id for each i
```

**Per-account point ID isolation test:**
```
"produces different point IDs for different accountIds at the same chunkIndex"
  - Call ingestDocument with STUB_INPUT (accountId A)
  - Call ingestDocument with { ...STUB_INPUT, accountId: "different-account-id" }
  - Assert: point[0].id from call 1 !== point[0].id from call 2
```

---

## Risks and Edge Cases

**High — Boot-time Voyage outage blocks deployment.**
If Voyage AI is down when a deployment starts, every instance will fail its startup probe and refuse to start. This is intentional behavior — silent corruption of the embedding pipeline is worse than a failed deployment — but it means a Voyage outage at deployment time causes a service restart failure. Mitigation: the 2-retry + Sentry notification gives 3.5s for a transient blip to recover. Operators must monitor the Sentry `voyage-dim-guard` event as a deployment health signal. Document this in runbooks.

**High — Namespace UUID accidentally regenerated.**
A future contributor who sees `KB_POINT_ID_NAMESPACE` might misread the comment and think it needs to be freshly generated per-deployment. This would invalidate all existing deterministic IDs. Mitigation: the "DO NOT CHANGE" comment in `qdrant-point-id.ts` is a correctness comment (not a style comment), the spec test asserts the constant equals its committed value, and `data-flows.md` is updated with the same warning.

**Medium — Hybrid random-UUID / deterministic-UUID state in Qdrant.**
Pre-existing points have random UUIDs. New and updated points get deterministic UUIDs. Retrieval is unaffected (search is by vector similarity + filter, not by ID). The only scenario where this matters is an update to a document that was ingested before this phase: the update flow deletes by `(account_id, document_id)` filter and re-upserts with deterministic IDs — this correctly removes all old random-UUID points for that document and replaces them with deterministic-UUID points. The transition is transparent.

**Medium — `process.exit(1)` in `main.ts` test coverage.**
The `process.exit(1)` call in `main.ts` is not covered by the dim guard's own spec (which tests the service's `checkDimension()` method directly). There is no existing test for `main.ts` bootstrap logic in this codebase. Do not add a `main.ts` test — the spec coverage via `voyage-dim-guard.service.spec.ts` plus integration-level verification (manual boot with a wrong dimension) is sufficient for v1.

**Low — `uuid` package type declarations.**
The `uuid` package's recent versions ship bundled TypeScript declarations. If `@types/uuid` produces conflicts (unlikely), remove it — the bundled types are sufficient.

**Low — `sleep` implementation in VoyageDimGuardService.**
Use a simple `new Promise(resolve => setTimeout(resolve, ms))` local helper, not a 3rd-party sleep utility. Keep it private and inline within the service. This avoids adding another npm dependency.

**Low — Startup latency visibility.**
The probe adds ~300–500ms to startup time on a healthy Voyage connection. This is invisible to users (the app isn't accepting traffic yet) but may affect health-check timeout settings in deployment orchestrators. Document expected startup time in the service's log output: `[event=boot_ok dim=1024]` should include a `probeMs=<elapsed>` field so operators can see how long the probe took.

---

## Out-of-Scope Confirmations

The following items from `docs/knowledge-base/phase-8-considerations.md` section 8d are NOT included:
- Stuck-job detector (defer to production volume)
- Compensation / in-flux marker (explicitly removed from scope — deterministic IDs make the update flow naturally idempotent)
- Orphan-vector cleanup script (defer — new orphans stop accumulating after this phase)
- Anthropic retry-with-backoff on 429 (graceful degradation is the accepted behavior)
- GSI on `(account_id, external_id)` (defer until ~100 docs per account)
- Mass migration of existing random-UUID Qdrant points (explicitly out of scope)
- Any change to `/chat/web/*` controllers or the iframe auth model
- Per-account concurrency cap, per-plan limits, enrichment status field (Phase 8f)
- Read-consistency during update (needs per-point version field; not v1-blocking)
