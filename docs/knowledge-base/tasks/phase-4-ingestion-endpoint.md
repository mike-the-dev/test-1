TASK OVERVIEW
Task name: Phase 4 — Ingestion endpoint + pipeline

Objective:
Expose an HTTP endpoint that accepts extracted text from the upstream control-panel API, runs it through the ingestion pipeline (chunk → embed → write), and persists both the per-document metadata in DynamoDB and the vectors+chunk-text in Qdrant. When this phase is done, a client can POST a document and see its vectors appear in Qdrant and its metadata appear in DynamoDB, ready for retrieval in Phase 5. No enrichment, no async queue, no retrieval tool yet — those are later phases.

Relevant context:
- NestJS + TypeScript API at `/Users/mike/Development/ai-chat-session-api`. Primary datastore is DynamoDB. Vector store is Qdrant (Phase 1). Embedding service is Voyage (Phase 2). Chunker is `src/utils/chunker/chunker.ts` (Phase 3) exporting `chunkText`, `KnowledgeBaseChunk`, `KnowledgeBaseChunkOptions`, and the default size/overlap constants.
- Established patterns to mirror:
  - Controller: `src/controllers/web-chat.controller.ts` — thin HTTP layer, zod-based validation via pipes, delegates to a service.
  - Controller validation: `src/pipes/` holds pipes; `src/validation/web-chat.schema.ts` shows the zod-schema convention.
  - Service: `src/services/chat-session.service.ts` — business logic, orchestration across external clients.
  - DynamoDB access: `src/tools/list-services.tool.ts` shows the query pattern; `DynamoDBDocumentClient` injected via `DYNAMO_DB_CLIENT` provider.
  - Log-line format: bracketed `[key=value]` throughout (see `list-services.tool.ts`, `tool-registry.service.ts`).
- Per-account scoping is a hard invariant. Every Qdrant write and every DynamoDB write carries `account_ulid`. Retrieval in Phase 5 will filter by `account_ulid` on every query.
- Phase 4 is synchronous: the HTTP request stays open while the pipeline runs and returns the final document state. Async via Redis/Bull lands in Phase 7 when we add Claude enrichment (which is what pushes processing time past HTTP-timeout territory).
- No auth on this endpoint in Phase 4. Matches the existing project convention (web-chat also trusts the `accountUlid` in the request body). Internal-caller-to-internal-caller auth is a Phase 8 hardening concern.

Key contracts (locked by the user before this brief — do not relitigate in the plan):
- **HTTP endpoint:** `POST /knowledge-base/documents`
- **Request body** (JSON, validated with zod):
  - `accountUlid: string` (required, ULID format, matches existing convention)
  - `externalId: string` (required — upstream's identifier for the source document, used for caller-side idempotency/audit)
  - `title: string` (required, human-readable)
  - `text: string` (required, the plain extracted text — this API never receives binary content)
  - `sourceType: "pdf" | "csv" | "docx" | "txt" | "html"` (required enum; extend if needed)
  - `mimeType?: string` (optional)
- **Success response (201 Created):**
  - `documentUlid: string`
  - `chunkCount: number`
  - `status: "ready"`
  - `createdAt: string` (ISO-8601)
- **Error responses:**
  - 400 — validation failed (via existing zod pipe pattern)
  - 500 — pipeline failed (Voyage down, Qdrant down, unknown error). Response body is a safe generic message; detail goes to logs, NOT to the response. No API keys or internal error shapes ever reach the response body.
- **DynamoDB record shape** (single-table, same partition as the account's other data):
  - `pk: A#<accountUlid>`
  - `sk: KB#DOC#<documentUlid>`
  - `entity: "KB_DOCUMENT"`
  - `document_ulid, account_ulid, external_id, title, source_type, mime_type, chunk_count, status, created_at`
  - `status` is always `"ready"` on successful Phase 4 ingestion. The field exists so Phase 7's async flow can add `"pending"` and `"failed"` without a schema change.
- **Qdrant collection:** a single global collection named `knowledge_base`. Per-account isolation is enforced by the `account_ulid` value in every point's payload and a required filter on every retrieval query. The collection is created lazily on first ingestion if it doesn't exist.
- **Qdrant point payload** per chunk:
  - `account_ulid, document_ulid, document_title, external_id, chunk_index, chunk_text, start_offset, end_offset, source_type, created_at`
- **Qdrant point ID:** generate a fresh UUID per chunk at write time. No deterministic ID in Phase 4 — re-ingesting the same document will create duplicate points, which is acceptable for Phase 4 MVP. Idempotency via deterministic IDs or delete-before-write is a Phase 8 concern.
- **Vector dimension:** determined by the Voyage model. Expected 1024 for `voyage-3-large`. The plan MUST verify this against live docs.

Out of scope for Phase 4 (do not add these):
- Async queue (Redis, Bull) — Phase 7.
- Claude enrichment per chunk — Phase 7.
- The retrieval / lookup tool used by agents — Phase 5.
- Delete / update endpoints — future.
- Idempotency via deterministic point IDs or delete-before-write — Phase 8.
- Retry logic on transient failures — Phase 8.
- Sentry / Slack alerting — Phase 8.
- Pagination or listing endpoints — future.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. **Verify Voyage `voyage-3-large` output dimension** against live docs (context7 or WebFetch — `https://docs.voyageai.com/docs/embeddings`). The collection will be created with this dimension. Do not rely on training data.

2. **Verify the Qdrant JS client's API for**: `getCollections`, `createCollection` (with `vectors: { size, distance: "Cosine" }`), and `upsert` (point shape and payload field). Use live docs at `https://qdrant.tech/documentation/frameworks/nodejs/` and the package's npm page. Note the exact TypeScript shapes.

3. **Affected files / modules** (new unless noted):
   - `src/validation/knowledge-base.schema.ts` — zod schemas for the request body.
   - `src/pipes/knowledgeBaseValidation.pipe.ts` — pipe wrapping the zod schema, mirroring whichever pipe `web-chat.controller.ts` already uses.
   - `src/types/KnowledgeBase.ts` — extend with new interfaces: request/response DTO shapes, DynamoDB record shape, Qdrant point-payload shape.
   - `src/controllers/knowledge-base.controller.ts` — thin controller, one `@Post("documents")` handler.
   - `src/services/knowledge-base-ingestion.service.ts` — the pipeline orchestrator. Methods: `ingestDocument(input): Promise<IngestDocumentResult>` and internal helpers for (a) ensuring the Qdrant collection exists, (b) writing Qdrant points, (c) writing the DynamoDB metadata record.
   - `src/controllers/knowledge-base.controller.spec.ts` — controller unit test with service mocked.
   - `src/services/knowledge-base-ingestion.service.spec.ts` — service unit test with Qdrant, Voyage, chunker, and DynamoDB mocked.
   - Modify `src/app.module.ts` — register controller and service.

4. **Design the ingestion service's internal control flow**:
   - Parse/validate upstream input (already done by the pipe before the service runs).
   - Generate `documentUlid` via whatever ULID utility the repo already uses (check the existing pattern — `IdentityService` or a util — and reuse it).
   - Chunk the text via `chunkText(input.text)` (default size/overlap).
   - If chunk count is 0 (empty/whitespace-only text), return a validation-like error rather than writing an empty document. Surface as a 400 to the caller.
   - Embed all chunks in one call to `VoyageService.embedTexts(chunks.map(c => c.text))` (respects the service's internal batch-splitting).
   - Ensure the `knowledge_base` collection exists in Qdrant (call `getCollections`; if absent, call `createCollection`). Only do this on the ingestion path, NOT at app startup.
   - Build the array of Qdrant points — one per chunk, with payload as specified. Upsert via `client.upsert`.
   - Write the DynamoDB metadata record (PutItem).
   - Return `{ documentUlid, chunkCount, status: "ready", createdAt }`.
   - On any downstream failure: log with the bracketed key=value format (no raw error objects, no leaked secrets), throw an error surfaced as a 500 to the caller. Do NOT attempt to roll back partial writes — that's Phase 8.

5. **Error handling design**:
   - Voyage auth/network/rate-limit failures bubble up with the categorized safe messages already implemented in `VoyageService`.
   - Qdrant failures: catch, log with key=value format, throw a generic "Knowledge base storage is temporarily unavailable" error for the 500 response.
   - DynamoDB failures: same pattern as Qdrant.
   - Chunker/edge cases (0 chunks): 400 response with clear message.
   - **Never include Voyage or Qdrant error bodies in the HTTP response.**

6. **Testing strategy**:
   - Service spec: mock `chunkText` (or import and use real), mock `VoyageService`, mock `QdrantClient` via the provider injection, mock DynamoDB. Cover: happy path (3 chunks in, 3 points out, 1 DDB record), empty-text rejection, Voyage failure propagation, Qdrant failure propagation, DDB failure propagation, collection-exists vs collection-missing branches.
   - Controller spec: mock the service, assert the controller calls it with the validated input and returns 201 with the expected body shape. Cover 400 (invalid body) and 500 (service throws) paths.

7. **Plan must enumerate** the exact point-ID generation approach, the collection-existence check pattern (avoid a race on startup by only checking on ingestion), and the ULID generation reuse (don't introduce a new ULID library if one is already in use).

Requirements for the plan:
- identify affected files/modules
- outline step-by-step implementation order
- note dependencies and architectural considerations
- list risks or edge cases (empty text, very large text, upstream retries, collection race)
- define testing strategy

Pause after producing the plan so the orchestrator can review and get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Implement in the order the plan prescribes. Suggested natural order: types/DTOs → validation schema → pipe → service → controller → register in app.module → specs.
- Mirror existing NestJS conventions exactly:
  - Controllers: thin, use the existing pipe pattern for validation, delegate to the service.
  - Services: business logic, inject dependencies via constructor, use `Logger` with the class name.
  - All types in `src/types/KnowledgeBase.ts`. Never inline types in service/controller/pipe.
  - Zod schemas in `src/validation/knowledge-base.schema.ts`.
- Log every major step of the pipeline with the bracketed key=value format (e.g., `Ingesting document [accountUlid=... externalId=... textLength=...]`, `Ingestion complete [documentUlid=... chunkCount=... durationMs=...]`). No secrets, no raw error objects.
- Run `npm run build` and `npm test` before returning — both must be clean.
- Do NOT wire any retrieval tool. Do NOT modify any existing agent. Do NOT add Claude enrichment, async queues, or retry logic.
- Do NOT add auth middleware on the new endpoint. The project's existing convention is to accept `accountUlid` in the body without auth — match it.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- Keep the ingestion service readable. The pipeline is a sequence of named steps; resist compressing them into one big expression. Each step (chunk, embed, ensure collection, write points, write metadata) should be self-evident.
- Named constants for any repeated string values (`KB_COLLECTION_NAME`, `KB_DOCUMENT_ENTITY`).
- Bracketed `[key=value]` log format everywhere.
- No `any`, no magic strings in logic bodies, no dead code, no placeholder comments.
- Mirror the shape of existing controllers and services structurally (imports order, constructor DI, method ordering).

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` — must be clean.
- Run `npm test` — must be all green. Starting baseline was 255 passing. Report the new total, which should be 255 + (tests added by this phase).

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Per-account invariant:** every Qdrant point payload has `account_ulid`; every DynamoDB record has `A#<accountUlid>` as PK. Any code path that writes a point or record without carrying `account_ulid` forward is a hard bug.
- **Error hygiene:** no Voyage/Qdrant/DDB error details, error bodies, or API keys appear in HTTP response bodies. Catch blocks log with bracketed key=value format and throw sanitized errors.
- **Controller-service thinness:** controller has no business logic, no DynamoDB calls, no Qdrant calls. All orchestration lives in the service.
- **Pipeline correctness:**
  - Chunker is called on the input text.
  - Chunks are embedded in the same order chunker returned them (Voyage service already sorts, but the service shouldn't re-order after that).
  - Each Qdrant point's `chunk_index` matches the chunker-assigned index.
  - `chunkCount` in the response matches the actual number of points written.
  - Collection creation is idempotent (create-if-missing, never overwrite).
- **No out-of-scope work:** no retry logic, no Redis, no enrichment, no auth, no retrieval tool.
- **Type placement:** every new interface in `src/types/KnowledgeBase.ts`. No inline types.
- **Test coverage:** every branch in the error handling has a test.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
