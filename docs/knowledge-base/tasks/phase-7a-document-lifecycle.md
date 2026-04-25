TASK OVERVIEW
Task name: Phase 7a — Document update + delete lifecycle (with naming alignment)

Objective:
Make the Knowledge Base feature operationally sustainable over time. A document's text changes when the client updates the source PDF; a document gets retired when the client removes it from their CMS. Today, neither flow works correctly — re-POSTing creates duplicate chunks; there is no delete endpoint at all. This phase fixes both. It also takes the opportunity to align all stored fields and API DTOs with the project's actual naming conventions (snake_case in DDB / on the wire, no `_ulid` suffix on identifier fields, `_createdAt_` / `_lastUpdated_` for timestamps, project-standard `entity` enum).

When this phase is done:
- POSTing the same `external_id` twice produces a clean update (old chunks gone, new chunks in place, same `document_id`, `_lastUpdated_` advanced).
- DELETEing a document removes its chunks from Qdrant and its metadata from DynamoDB.
- All KB record fields, Qdrant payload fields, and API request/response fields use the project's naming conventions consistently.
- All existing tests still pass; new tests cover the update and delete paths.

Relevant context:
- This phase modifies the Phase 4 ingestion service and controller, plus Phase 5's retrieval-tool payload references. Phases 1–3 are unaffected (the chunker is pure; the Voyage and Qdrant clients are unchanged; the Qdrant collection schema is unchanged).
- The project's naming conventions, confirmed by the user from a real DynamoDB record:
  - Record fields are `snake_case` (e.g., `chunk_count`, `payment_id`, `connected_account_id`).
  - Identifier fields drop the `_ulid` suffix — they are `_id` (e.g., `payment_id`, `connected_account_id`).
  - Timestamp fields use surrounding underscores: `_createdAt_` and `_lastUpdated_`.
  - Every record has an `entity` field whose value is a string from the shared `Entity` enum.
- The user is adding a new entity to that enum: `KNOWLEDGE_BASE_DOCUMENT = "KNOWLEDGE_BASE_DOCUMENT"`. Phase 7a code must use this exact string (replacing the current `"KB_DOCUMENT"`).
- The user has already cleared the existing 3 KB documents from DynamoDB and the `knowledge_base` collection from Qdrant before this phase begins. Phase 7a does NOT include a migration for legacy data — there is none.
- Existing web-chat / chat-session code that uses `accountUlid` etc. is OUT OF SCOPE. Do not touch it. Phase 7a's TypeScript renames are KB-only.

Key contracts (locked by the user before this brief — do not relitigate):

**Naming conventions throughout Phase 7a:**

- DynamoDB record fields:
  - `PK`, `SK`, `entity` (uppercase keyword unchanged)
  - `document_id` (was `document_ulid`)
  - `account_id` (was `account_ulid`)
  - `external_id`, `title`, `source_type`, `mime_type`, `chunk_count`, `status`
  - `_createdAt_` (was `created_at`) — set on create, preserved on update
  - `_lastUpdated_` — set on every create AND every update
- Qdrant point payload fields (per chunk):
  - `account_id`, `document_id`, `document_title`, `external_id`
  - `chunk_index`, `chunk_text`, `start_offset`, `end_offset`, `source_type`
  - `_createdAt_` (was `created_at`)
  - (No `_lastUpdated_` on chunks — chunks are replaced wholesale on update, so they only ever carry their own creation time, which equals the document's most-recent update time.)
- API request body for `POST /knowledge-base/documents`:
  - `account_id` (string, required, format `A#<26-char-ulid>`)
  - `external_id` (string, required)
  - `title` (string, required)
  - `text` (string, required)
  - `source_type` (enum: `"pdf" | "csv" | "docx" | "txt" | "html"`, required)
  - `mime_type` (string, optional)
- API request body for `DELETE /knowledge-base/documents`:
  - `account_id` (string, required, format `A#<26-char-ulid>`)
  - `external_id` (string, required)
- API response for `POST /knowledge-base/documents` (both create and update):
  ```json
  {
    "document_id": "01K...",
    "chunk_count": 15,
    "status": "ready",
    "_createdAt_": "2026-04-25T...",
    "_lastUpdated_": "2026-04-25T..."
  }
  ```
- API response for `DELETE /knowledge-base/documents`: HTTP `204 No Content`, empty body.
- **Entity value:** `entity: "KNOWLEDGE_BASE_DOCUMENT"` everywhere it's written. Replaces the current `"KB_DOCUMENT"`.

**Internal TypeScript naming (KB-only files):**

- All variable names: `accountId`, `documentId` (camelCase, no `Ulid` suffix). The `Ulid` suffix was an old convention; all new KB-related variables drop it.
- All KB-related type fields follow the same rule: e.g., `KnowledgeBasePointPayload.account_id` (was `account_ulid`), and the in-memory `KnowledgeBaseIngestDocumentInput.accountId` (was `accountUlid`).
- KB types/methods/services NOT being renamed wholesale — only field names within them. Class names, file names, and method names stay the same.
- DO NOT touch any non-KB code (web-chat controller, chat-session service, identity service, etc.) — they continue using `accountUlid`. That broader cleanup is a future phase.

**Behavior contracts:**

- **Idempotent re-ingest by `(account_id, external_id)`:** When a POST arrives, the service first looks up DynamoDB for an existing record with the same `(account_id, external_id)`. If found, it deletes the old Qdrant chunks for that `document_id`, reuses the existing `document_id`, writes new chunks, and updates the DDB record (preserving `_createdAt_`, advancing `_lastUpdated_`, updating `chunk_count`). If not found, behavior is identical to today's create path.
- **Lookup mechanism:** Use a DynamoDB Query on `PK = A#<account_id>` AND `begins_with(SK, "KB#DOC#")` with a FilterExpression on `external_id`. No new GSI is required at this scale. Document this clearly in the plan; future phase can add a GSI when accounts host thousands of documents.
- **Partial-failure model on update:** Loud failure + retry-safe. The pipeline order is: (1) lookup existing → (2) delete old Qdrant chunks → (3) write new Qdrant chunks → (4) update DDB record. If any step fails, log loudly with bracketed `[key=value]` format (no raw error objects, no secrets), throw `InternalServerErrorException`, return 500. The upstream retries; the next attempt re-runs the whole pipeline (idempotently — the `(account_id, external_id)` lookup still finds the now-partially-bad record, and re-ingestion replaces it). No compensation logic.
- **Delete behavior:**
  - Lookup `document_id` from DynamoDB by `(account_id, external_id)`.
  - If found: delete all Qdrant points where `account_id = X AND document_id = Y`, then delete the DDB record.
  - If NOT found: return 204 anyway (idempotent — the end state is "this `external_id` doesn't exist for this account," which matches what the caller wanted).
  - On Qdrant or DDB failure: log loudly, throw 500, upstream retries.
- **Re-POST with identical content:** Always re-embed and replace. No content hashing, no skip-if-unchanged optimization. (Phase 8 may revisit if real cost data justifies it.)

Out of scope for Phase 7a:
- Soft delete or audit history — hard delete only.
- GET / list endpoints for KB documents — future "KB admin" phase.
- Renaming `accountUlid` etc. in non-KB files (web-chat, chat-session, identity service) — future broader cleanup pass.
- A new GSI for `external_id` lookups — future when scale demands it.
- Content-hash-based idempotency (skip re-embed if text unchanged) — Phase 8.
- Compensation logic for partial-failure rollback — Phase 8.
- Multi-document or bulk operations — future.
- Updating Phase 5's retrieval tool's PUBLIC API — only its internal references to renamed payload fields change, output JSON shape stays the same as Phase 5 shipped.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read the brief in full. Read the recent commits touching KB:
   - `2126b044 fix(kb): use uppercase PK/SK to match existing DynamoDB table schema`
   - `04e4bbb8 docs(kb): add benchmark findings`
   - The Phase 4 + Phase 5 implementation files in scope.

2. Study the existing codebase patterns the new code must mirror:
   - `src/services/knowledge-base-ingestion.service.ts` — current ingest path; needs the new lookup-then-update branch + new delete method.
   - `src/services/knowledge-base-ingestion.service.spec.ts` — pattern for ddbMock + Qdrant mock setup.
   - `src/controllers/knowledge-base.controller.ts` — current POST handler; needs a new DELETE handler.
   - `src/types/KnowledgeBase.ts` — every field rename + `_lastUpdated_` addition + delete-input/result types.
   - `src/validation/knowledge-base.schema.ts` — existing ingest schema needs field renames; add new delete schema.
   - `src/tools/lookup-knowledge-base.tool.ts` — its `KnowledgeBasePointPayload` references need updating to the renamed field names; tool-side behavior is unchanged.
   - `src/tools/lookup-knowledge-base.tool.spec.ts` — same.
   - The shared `Entity` enum lives in the user's separate enum source; in our code, the constant `KB_DOCUMENT_ENTITY = "KB_DOCUMENT"` becomes `KB_DOCUMENT_ENTITY = "KNOWLEDGE_BASE_DOCUMENT"`.

3. Verify the Qdrant JS SDK's `delete` method against live docs:
   - Expected: `client.delete(collectionName, { filter: { must: [...] } })` returns an UpdateResult-like object.
   - Source: `https://qdrant.tech/documentation/concepts/points/#delete-points` and the installed SDK's `.d.ts` files.
   - Confirm whether `wait: true` is needed for the delete to be visible to subsequent searches in the same flow.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — every file that will be modified, with one-line note per file.
   - **Comprehensive rename table** — every old name → new name pair, with file location. Include:
     - DDB record field renames
     - Qdrant payload field renames
     - API request body field renames
     - API response field renames
     - Internal TypeScript variable renames in KB-only files
     - The entity string change
   - **Lookup mechanism design** — exact DynamoDB Query parameters, including KeyConditionExpression and FilterExpression. Note the absence of a GSI and why it's acceptable at this scale.
   - **Update pipeline control flow** — numbered steps for the new ingest path:
     1. Validate input (existing pipe).
     2. Generate `documentId` candidate (only used if the lookup misses).
     3. Lookup existing record by `(account_id, external_id)`.
     4. If existing: capture existing `document_id`, capture existing `_createdAt_`. If not: keep generated candidate as new `document_id`, set `_createdAt_` to now.
     5. Chunk → embed → ensure collection + index (idempotent, unchanged from Phase 4).
     6. If existing: delete old Qdrant points where `account_id = X AND document_id = Y`.
     7. Upsert new Qdrant points.
     8. Write DDB record (PutCommand — replaces existing if present).
     9. Return result with both `_createdAt_` and `_lastUpdated_`.
   - **Delete pipeline control flow** — numbered steps for the new DELETE path.
   - **Type changes** — exact final shapes for `KnowledgeBaseDocumentRecord`, `KnowledgeBasePointPayload`, `KnowledgeBaseIngestDocumentInput`, `KnowledgeBaseIngestDocumentResult`, plus new `KnowledgeBaseDeleteDocumentInput` and `KnowledgeBaseDeleteDocumentResult` (probably `void` if 204).
   - **Zod schema changes** — final shape for the existing `lookupKnowledgeBaseInputSchema` (no change), updated `ingestDocumentInputSchema` field names, new `deleteDocumentInputSchema`.
   - **Step-by-step implementation order** — file-by-file, granular enough for code-implementer to execute.
   - **Risks and edge cases** — concurrent re-ingests of the same `external_id` (race), upstream sending the same `(account_id, external_id)` with different content, very large existing chunk-set deletion timing, the case where Qdrant has chunks but DynamoDB doesn't (orphaned vectors — what should the code do?).
   - **Testing strategy** — list every new test case AND every existing test that needs its assertions updated for the renames. Cover at minimum:
     - Renames don't break existing happy-path tests.
     - First POST with new `external_id` creates as before.
     - Second POST with same `external_id` reuses `document_id`, advances `_lastUpdated_`, preserves `_createdAt_`, replaces chunks.
     - Second POST with same `external_id` after Qdrant delete failure → 500.
     - DELETE existing document → chunks gone from Qdrant, record gone from DDB, 204.
     - DELETE non-existent `(account_id, external_id)` → 204 (no-op).
     - DELETE on Qdrant failure → 500.
     - DELETE on DDB failure → 500.
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-7a-document-lifecycle-plan.md`.

6. After writing the file, return a concise summary (under 400 words) including: (a) the path to the plan file, (b) 4–6 key decisions or clarifications you made, (c) any risks or unknowns I should flag to the user before approval — especially around the `(account_id, external_id)` lookup performance (full account-partition scan with filter), and the orphan-vector edge case if any earlier failure left Qdrant points that DynamoDB doesn't know about.

Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Implement the renames first (mechanical, easy to scope), then the new behaviors (update branch + delete endpoint).
- All renames must be applied consistently across types, services, controllers, validation schemas, and specs in a single pass. Do NOT leave any KB code referencing `documentUlid`, `accountUlid`, `document_ulid`, `account_ulid`, `created_at`, or `KB_DOCUMENT` after this phase.
- Do NOT touch non-KB code that uses `accountUlid` (web-chat controller, chat-session service, identity service, etc.).
- Run `npm run build` and `npm test` before returning. Both must be clean. Total tests should be 304 + new (estimate ~6–10 new across the two new behaviors).
- Commit on master. Suggested subject: `feat(kb): add idempotent re-ingest, delete endpoint, and naming alignment`. **Do NOT add `Co-Authored-By:` or credit Claude.**

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- Verify EVERY rename is consistent — search the codebase for any surviving `_ulid` suffix in KB-related files, any surviving `KB_DOCUMENT` literal, any surviving `created_at` literal in KB files. Flag any survivor as a bug for the reviewer; do not silently fix non-KB occurrences.
- Maintain the bracketed `[key=value]` log format throughout.
- Mirror the existing style of `list-services.tool.ts` for any new tool-like patterns.
- No `any`, no magic strings, no dead code, no placeholder comments.

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` first.
- Run `npm test`. Baseline before this phase: 304 tests passing. Phase 7a adds tests for:
  - Update happy path
  - Update with Qdrant delete failure
  - Update preserves `_createdAt_` and advances `_lastUpdated_`
  - Delete happy path
  - Delete idempotent (no-op when not found)
  - Delete with Qdrant failure
  - Delete with DDB failure
- Plus updated existing tests for the field renames.
- Report exact pass/fail counts.
- If any failure exists, classify as: rename-related (an assertion checking an old field name), update-behavior bug, delete-behavior bug, or unrelated regression.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Rename completeness**: grep for any surviving `_ulid` suffix in KB files, any surviving `KB_DOCUMENT` literal, any `created_at` in KB files, any `accountUlid` / `documentUlid` in KB-only files. Each survivor is a bug.
- **Naming boundary respected**: confirm non-KB code (`src/controllers/web-chat.controller.ts`, `src/services/chat-session.service.ts`, `src/services/identity.service.ts`, etc.) was NOT touched. Each touched non-KB file is a scope violation.
- **Idempotent update correctness**: re-ingest preserves `_createdAt_`, advances `_lastUpdated_`, reuses `document_id`, replaces all chunks. The lookup correctly scopes by both `account_id` AND `external_id` (both required — single field match would cross-contaminate accounts).
- **Per-account invariant**: every Qdrant `delete` and `search` call carries the `account_id` filter. Same hard rule as Phases 4 + 5.
- **Delete idempotency**: 204 on non-existent (account_id, external_id) without throwing.
- **Error hygiene**: no API keys, no raw error objects, no error bodies in logs or responses.
- **Pipeline ordering on update**: lookup → chunk → embed → ensure collection + index → delete old Qdrant chunks → upsert new Qdrant chunks → write DDB. If the order is rearranged in any way (e.g., write DDB before Qdrant write), call it out — that creates a window where the DDB record references chunks that don't exist yet.
- **Entity value**: `entity: "KNOWLEDGE_BASE_DOCUMENT"` is the only value written. No remaining `"KB_DOCUMENT"`.
- **Backward compatibility note**: confirm that the API response shape change (`document_ulid` → `document_id`, etc.) is the ONLY breaking surface. The Phase 4 endpoint contract has been deliberately changed; no other endpoint has changed.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
