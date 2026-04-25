# Phase 7a — Document Update + Delete Lifecycle: Implementation Plan

## Overview

Phase 7a makes the Knowledge Base feature operationally sustainable by adding two missing behaviours: idempotent re-ingest (a second POST with the same `(account_id, external_id)` cleanly replaces the document's chunks and updates its metadata rather than duplicating them) and a DELETE endpoint (removes all Qdrant chunks and the DynamoDB record for a given `(account_id, external_id)` pair). The phase simultaneously aligns every stored field, Qdrant payload field, and API surface in the KB subsystem with the project's canonical naming conventions — snake_case DDB fields, no `_ulid` suffix on identifiers, `_createdAt_` / `_lastUpdated_` timestamp fields, and `entity: "KNOWLEDGE_BASE_DOCUMENT"`. No data migration is required; the user has already cleared the existing three documents. Non-KB code (`web-chat`, `chat-session`, `identity`) is explicitly out of scope.

---

## Affected Files and Modules

### Modify

| File | Reason |
|------|--------|
| `src/types/KnowledgeBase.ts` | Field renames on all interfaces; add `_lastUpdated_` to `KnowledgeBaseDocumentRecord`; add `KnowledgeBaseDeleteDocumentInput` and `KnowledgeBaseDeleteDocumentResult`; rename fields on `KnowledgeBaseRetrievalChunk` (`document_ulid` → `document_id`) |
| `src/validation/knowledge-base.schema.ts` | Rename request body fields in `ingestDocumentSchema`; add `deleteDocumentSchema` and `DeleteDocumentBody` |
| `src/services/knowledge-base-ingestion.service.ts` | Rename all internal variables/fields; add `lookupExistingDocument()` private method; add delete-old-Qdrant-chunks step to `ingestDocument()`; add `deleteDocument()` public method; update module-level constants; import `QueryCommand` and `DeleteCommand` |
| `src/controllers/knowledge-base.controller.ts` | Rename mapped fields in `ingestDocument()`; add `deleteDocument()` handler with `@Delete("documents")`, `@HttpCode(204)`, new Zod pipe |
| `src/services/knowledge-base-ingestion.service.spec.ts` | Update all assertions for renamed fields; add mock setup for `QueryCommand` and `delete`; add new test cases for update and delete behaviours |
| `src/controllers/knowledge-base.controller.spec.ts` | Update stubs and assertions for renamed response fields; add test cases for the DELETE handler |
| `src/tools/lookup-knowledge-base.tool.ts` | Rename Qdrant filter key `account_ulid` → `account_id`; rename payload field references `account_ulid` → `account_id`, `document_ulid` → `document_id`; update log line field names |
| `src/tools/lookup-knowledge-base.tool.spec.ts` | Update `makeScoredPoint()` stub payload field names; update filter assertion |

### Review Only (not modified)

| File | Why reviewed |
|------|-------------|
| `src/utils/knowledge-base/constants.ts` | No change needed; `KB_COLLECTION_NAME` is not renamed |
| `src/pipes/knowledgeBaseValidation.pipe.ts` | No change; just re-exports `ZodValidationPipe` |
| `src/pipes/webChatValidation.pipe.ts` | Reference for pipe pattern |
| `src/services/chat-session.service.ts` | Reference for `QueryCommand` / `DeleteCommand` patterns and bracketed log format |
| `src/services/origin-allowlist.service.ts` | Reference for `QueryCommand` with `FilterExpression` pattern |

---

## Comprehensive Rename Table

### DynamoDB record fields (`KnowledgeBaseDocumentRecord`)

| Old name | New name | Notes |
|----------|----------|-------|
| `document_ulid` | `document_id` | |
| `account_ulid` | `account_id` | |
| `created_at` | `_createdAt_` | ISO-8601 string; set on create, preserved on update |
| *(absent)* | `_lastUpdated_` | ISO-8601 string; set on every create AND update |
| `entity: "KB_DOCUMENT"` | `entity: "KNOWLEDGE_BASE_DOCUMENT"` | literal type and runtime constant both change |

Fields that do NOT change: `PK`, `SK`, `external_id`, `title`, `source_type`, `mime_type`, `chunk_count`, `status`.

### Qdrant point payload fields (`KnowledgeBasePointPayload`)

| Old name | New name |
|----------|----------|
| `account_ulid` | `account_id` |
| `document_ulid` | `document_id` |
| `created_at` | `_createdAt_` |

Fields that do NOT change: `document_title`, `external_id`, `chunk_index`, `chunk_text`, `start_offset`, `end_offset`, `source_type`.

Note: `_lastUpdated_` is NOT added to the point payload. Chunks are replaced wholesale on update; they carry only their own creation time.

### API request body (`POST /knowledge-base/documents` — `IngestDocumentBody` / `ingestDocumentSchema`)

| Old field name | New field name | Notes |
|----------------|----------------|-------|
| `accountUlid` | `account_id` | The wire name changes to snake_case. The controller logic for stripping the `A#` prefix is unchanged. |
| `externalId` | `external_id` | |
| `sourceType` | `source_type` | |
| `mimeType` | `mime_type` | |

Fields that do NOT change: `title`, `text`.

### API response body (`POST /knowledge-base/documents` — `KnowledgeBaseIngestDocumentResult`)

| Old field name | New field name | Notes |
|----------------|----------------|-------|
| `documentUlid` | `document_id` | |
| `chunkCount` | `chunk_count` | |
| `createdAt` | `_createdAt_` | |
| *(absent)* | `_lastUpdated_` | Added; always present |

Field that does NOT change: `status`.

### Internal TypeScript variable names in KB-only files

| Old name | New name | Location |
|----------|----------|----------|
| `accountUlid` | `accountId` | `KnowledgeBaseIngestDocumentInput`, service params, controller local var |
| `documentUlid` | `documentId` | `KnowledgeBaseIngestDocumentResult` was `documentUlid`; local vars in service |
| `accountUlid` in log brackets | `accountId` | All `this.logger.*` calls in the service |
| `documentUlid` in log brackets | `documentId` | All `this.logger.*` calls in the service |
| `KB_ACCOUNT_ULID_INDEX_FIELD = "account_ulid"` | `KB_ACCOUNT_ID_INDEX_FIELD = "account_id"` | module-level constant in service |
| `KB_DOCUMENT_ENTITY = "KB_DOCUMENT"` | `KB_DOCUMENT_ENTITY = "KNOWLEDGE_BASE_DOCUMENT"` | module-level constant in service |

### `KnowledgeBaseRetrievalChunk` (Phase 5 type — internal field rename only, public tool output shape is unchanged)

| Old field name | New field name | Notes |
|----------------|----------------|-------|
| `document_ulid` | `document_id` | Internal mapping changes; the JSON the tool returns to the agent also changes from `document_ulid` to `document_id`. The brief says "only its internal references to renamed payload fields change, output JSON shape stays the same as Phase 5 shipped." However, the field being renamed IS part of the output JSON. The brief explicitly locks this rename; the task reviewer should be aware that any downstream consumer reading `document_ulid` from the tool output will break. This is flagged in the Risks section. |

### Entity string

| Old value | New value | Files |
|-----------|-----------|-------|
| `"KB_DOCUMENT"` | `"KNOWLEDGE_BASE_DOCUMENT"` | `KnowledgeBaseDocumentRecord.entity` literal type; `KB_DOCUMENT_ENTITY` constant in service; assertion in spec |

---

## Lookup Mechanism Design

The idempotent re-ingest and the delete flow both require resolving `(account_id, external_id)` → `document_id`. This is done via a DynamoDB `QueryCommand` — no new GSI.

**Exact query parameters:**

```
TableName:               <conversationsTable>
KeyConditionExpression:  "PK = :pk AND begins_with(SK, :skPrefix)"
FilterExpression:        "external_id = :externalId"
ExpressionAttributeValues:
  ":pk"         → "A#<accountId>"        (the raw 26-char ULID, not the prefix-stripped form — PK stores the full A# prefix)
  ":skPrefix"   → "KB#DOC#"
  ":externalId" → <externalId>
Limit:                   1               (there should be at most one record per (account_id, external_id))
```

**Why no GSI is required at this scale:**
- Every account's KB documents share the same `PK = A#<accountId>`. The Query scans only that account's partition, not the whole table.
- The `begins_with(SK, "KB#DOC#")` KeyConditionExpression restricts the scan to KB document SK entries, excluding chat messages and other record types from the same account partition.
- At typical initial scale (tens to low hundreds of documents per account), this filtered partition scan is fast (single-digit milliseconds). A GSI on `(account_id, external_id)` becomes worthwhile only when a single account hosts thousands of documents. The plan should note: add a GSI in a future phase if profiling shows scan latency at scale.

**Result handling:**
- If `Items` is empty or `Items[0]` is undefined → record does not exist (create path / idempotent 204 for delete).
- If `Items[0]` is present → extract `document_id` and `_createdAt_` (for update path) or `document_id` (for delete path).
- If the `QueryCommand` itself throws → log `[errorType=...]` and throw `InternalServerErrorException`.

---

## Update Pipeline Control Flow

The updated `ingestDocument()` method follows this 9-step sequence:

```
1. [Validation — done by pipe before controller calls service]
   Zod validates the renamed request body fields.
   Entry condition: method receives a KnowledgeBaseIngestDocumentInput.

2. [Generate documentId candidate]
   const documentId = ulid();
   This value is used only if the lookup (step 3) finds no existing record.

3. [Lookup existing record]
   private async lookupExistingDocument(
     accountId: string,
     externalId: string,
   ): Promise<{ documentId: string; createdAt: string } | null>
   
   Executes the QueryCommand described in the Lookup Mechanism section.
   Returns null if not found. Throws InternalServerErrorException on DDB error.
   Log on entry: [accountId=... externalId=...]

4. [Branch: existing vs. new]
   If lookup returned a record:
     - effectiveDocumentId = existing.documentId  (reuse existing ID)
     - createdAt = existing._createdAt_            (preserve original creation time)
     - isUpdate = true
   Else:
     - effectiveDocumentId = documentId            (use the candidate generated in step 2)
     - createdAt = new Date().toISOString()        (new creation time)
     - isUpdate = false

5. [Chunk → embed → ensure collection + index]
   Unchanged from Phase 4:
     const chunks = chunkText(input.text);
     // throw BadRequestException if chunks.length === 0
     const embeddings = await this.voyageService.embedTexts(chunks.map(c => c.text));
     await this.ensureCollection();
     await this.ensurePayloadIndex();  // index field: "account_id" (renamed from "account_ulid")

6. [If isUpdate: delete old Qdrant points]
   Only called when an existing record was found in step 3.
   private async deleteQdrantPoints(accountId: string, documentId: string): Promise<void>
   
   Calls:
     await this.qdrantClient.delete(KB_COLLECTION_NAME, {
       wait: true,
       filter: {
         must: [
           { key: "account_id", match: { value: accountId } },
           { key: "document_id", match: { value: documentId } },
         ],
       },
     });
   
   On error: log [errorType=... accountId=... documentId=...], throw InternalServerErrorException.
   
   wait: true is required. Without it, the delete is acknowledged (status: "acknowledged")
   but not yet applied in Qdrant storage. The upsert in step 7 would run before the delete
   is reflected, causing transient duplication of old+new chunks under the same document_id
   for any search that executes immediately after. Using wait: true ensures status: "completed"
   before proceeding. (Confirmed via SDK .d.ts: UpdateResult.status can be "acknowledged" |
   "completed" | "wait_timeout".)

7. [Upsert new Qdrant points]
   private async writeQdrantPoints(
     documentId: string,
     input: KnowledgeBaseIngestDocumentInput,
     chunks: KnowledgeBaseChunk[],
     embeddings: number[][],
     createdAt: string,
   ): Promise<void>
   
   Payload fields use the renamed names: account_id, document_id, _createdAt_.
   Unchanged: document_title, external_id, chunk_index, chunk_text, start_offset,
   end_offset, source_type.

8. [Write DynamoDB record]
   private async writeDynamoRecord(
     documentId: string,
     input: KnowledgeBaseIngestDocumentInput,
     chunkCount: number,
     createdAt: string,
     lastUpdated: string,
   ): Promise<void>
   
   Uses PutCommand (replaces any existing item at the same PK+SK, which is correct for
   the update path — no separate UpdateCommand needed). Written fields use the renamed
   names: document_id, account_id, _createdAt_, _lastUpdated_, entity: "KNOWLEDGE_BASE_DOCUMENT".
   
   Note: lastUpdated = new Date().toISOString() is captured at the top of ingestDocument(),
   same as the existing startedAt = Date.now() pattern. It must be captured BEFORE step 5
   so that chunks and the DDB record carry the same timestamp.

9. [Return result]
   return {
     document_id: effectiveDocumentId,
     chunk_count: chunks.length,
     status: "ready",
     _createdAt_: createdAt,
     _lastUpdated_: lastUpdated,
   };
```

**Full pipeline summary for create vs. update:**

```
CREATE:  step 2 (new id) → step 3 (miss) → step 4 (new) → step 5 → [skip step 6] → step 7 → step 8 → step 9
UPDATE:  step 2 (unused) → step 3 (hit)  → step 4 (reuse id) → step 5 → step 6 (delete old) → step 7 → step 8 → step 9
```

---

## Delete Pipeline Control Flow

New public method: `deleteDocument(input: KnowledgeBaseDeleteDocumentInput): Promise<void>`

```
1. Log entry: [accountId=... externalId=...]

2. Lookup existing record via lookupExistingDocument(accountId, externalId).
   If not found → log [accountId=... externalId=... action=noop], return void (204 idempotent).
   If DDB query throws → log [errorType=...], throw InternalServerErrorException.

3. Delete all Qdrant points where account_id = X AND document_id = Y.
   await this.qdrantClient.delete(KB_COLLECTION_NAME, {
     wait: true,
     filter: {
       must: [
         { key: "account_id", match: { value: accountId } },
         { key: "document_id", match: { value: existingDocumentId } },
       ],
     },
   });
   On error: log [errorType=... accountId=... documentId=...], throw InternalServerErrorException.

4. Delete the DynamoDB record.
   await this.dynamoDb.send(
     new DeleteCommand({
       TableName: this.databaseConfig.conversationsTable,
       Key: {
         PK: `${KB_PK_PREFIX}${accountId}`,
         SK: `${KB_SK_PREFIX}${existingDocumentId}`,
       },
     }),
   );
   On error: log [errorType=... accountId=... documentId=...], throw InternalServerErrorException.

5. Log completion: [accountId=... documentId=... action=deleted]
   Return void.
```

**Partial-failure behaviour on delete:**
- If step 3 (Qdrant) succeeds but step 4 (DDB) fails → log + throw 500. On retry, the DDB lookup in step 2 will still find the record (it wasn't deleted), so the whole delete is re-run. The Qdrant delete in step 3 is idempotent — deleting zero points is a no-op, and `wait: true` guarantees the previous delete completed before the call returns. Retry is safe.
- If step 3 (Qdrant) fails → DDB record is not touched. Full retry is safe.

---

## Type Changes

### `KnowledgeBaseDocumentRecord` (final shape)

```typescript
export interface KnowledgeBaseDocumentRecord {
  PK: string;                              // "A#<accountId>"
  SK: string;                              // "KB#DOC#<documentId>"
  entity: "KNOWLEDGE_BASE_DOCUMENT";
  document_id: string;                     // was document_ulid
  account_id: string;                      // was account_ulid
  external_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  mime_type?: string;
  chunk_count: number;
  status: "ready";
  _createdAt_: string;                     // was created_at; set on create, preserved on update
  _lastUpdated_: string;                   // new; set on every create and update
}
```

### `KnowledgeBasePointPayload` (final shape)

```typescript
export interface KnowledgeBasePointPayload {
  account_id: string;                      // was account_ulid
  document_id: string;                     // was document_ulid
  document_title: string;
  external_id: string;
  chunk_index: number;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
  source_type: KnowledgeBaseSourceType;
  _createdAt_: string;                     // was created_at
}
```

### `KnowledgeBaseIngestDocumentInput` (final shape)

```typescript
export interface KnowledgeBaseIngestDocumentInput {
  accountId: string;                       // was accountUlid; raw 26-char ULID (A# stripped)
  externalId: string;
  title: string;
  text: string;
  sourceType: KnowledgeBaseSourceType;
  mimeType?: string;
}
```

### `KnowledgeBaseIngestDocumentResult` (final shape)

```typescript
export interface KnowledgeBaseIngestDocumentResult {
  document_id: string;                     // was documentUlid
  chunk_count: number;                     // was chunkCount
  status: "ready";
  _createdAt_: string;                     // was createdAt
  _lastUpdated_: string;                   // new
}
```

### `KnowledgeBaseDeleteDocumentInput` (new)

```typescript
export interface KnowledgeBaseDeleteDocumentInput {
  accountId: string;   // raw 26-char ULID (A# stripped by controller)
  externalId: string;
}
```

### `KnowledgeBaseDeleteDocumentResult` (new)

```typescript
export type KnowledgeBaseDeleteDocumentResult = void;
```

The service method signature: `deleteDocument(input: KnowledgeBaseDeleteDocumentInput): Promise<void>`

### `KnowledgeBaseRetrievalChunk` (internal rename)

```typescript
export interface KnowledgeBaseRetrievalChunk {
  text: string;
  score: number;
  document_title: string;
  document_id: string;                     // was document_ulid
  chunk_index: number;
}
```

---

## Zod Schema Changes

### `src/validation/knowledge-base.schema.ts` (final shape)

```typescript
// Regex unchanged
const accountIdRegex = /^A#[0-9A-HJKMNP-TV-Z]{26}$/;

export const ingestDocumentSchema = z.object({
  account_id: z.string().regex(accountIdRegex, "account_id must be an A#-prefixed 26-character ULID"),
  external_id: z.string().min(1, "external_id must not be empty"),
  title: z.string().min(1, "title must not be empty"),
  text: z.string().min(1, "text must not be empty"),
  source_type: z.enum(["pdf", "csv", "docx", "txt", "html"], {
    message: "source_type must be one of: pdf, csv, docx, txt, html",
  }),
  mime_type: z.string().optional(),
});

export type IngestDocumentBody = z.infer<typeof ingestDocumentSchema>;

export const deleteDocumentSchema = z.object({
  account_id: z.string().regex(accountIdRegex, "account_id must be an A#-prefixed 26-character ULID"),
  external_id: z.string().min(1, "external_id must not be empty"),
});

export type DeleteDocumentBody = z.infer<typeof deleteDocumentSchema>;
```

Note on the `lookupKnowledgeBaseInputSchema` (in `src/validation/tool.schema.ts`): the brief states "no change" for this schema. Confirm it exists and has no KB-specific field renames before marking complete.

---

## Step-by-Step Implementation Order

The implementer must apply all changes in this sequence to avoid transient TypeScript compilation errors between steps.

### Step 1 — Update `src/types/KnowledgeBase.ts`

- Rename fields in `KnowledgeBaseDocumentRecord` per the rename table above.
- Change `entity` literal type from `"KB_DOCUMENT"` to `"KNOWLEDGE_BASE_DOCUMENT"`.
- Add `_lastUpdated_: string` to `KnowledgeBaseDocumentRecord`.
- Rename fields in `KnowledgeBasePointPayload` per the rename table.
- Rename `accountUlid` → `accountId` in `KnowledgeBaseIngestDocumentInput`.
- Rename fields in `KnowledgeBaseIngestDocumentResult` per the rename table; add `_lastUpdated_`.
- Rename `document_ulid` → `document_id` in `KnowledgeBaseRetrievalChunk`.
- Add `KnowledgeBaseDeleteDocumentInput` interface.
- Add `KnowledgeBaseDeleteDocumentResult = void` type alias.

Done when: `tsc --noEmit` reports no errors in `src/types/KnowledgeBase.ts` (other files will show errors until step 2 onward).

### Step 2 — Update `src/validation/knowledge-base.schema.ts`

- Rename all fields in `ingestDocumentSchema` per the rename table.
- Add `deleteDocumentSchema` and `DeleteDocumentBody`.
- Update the comment at top of file if it references old field names.

Done when: no TypeScript errors in this file.

### Step 3 — Update `src/services/knowledge-base-ingestion.service.ts`

This is the largest change. Sub-steps in order:

3a. Update imports: add `QueryCommand`, `DeleteCommand` from `"@aws-sdk/lib-dynamodb"`.

3b. Update module-level constants:
  - `KB_DOCUMENT_ENTITY = "KNOWLEDGE_BASE_DOCUMENT"`
  - `KB_ACCOUNT_ID_INDEX_FIELD = "account_id"` (rename from `KB_ACCOUNT_ULID_INDEX_FIELD`)

3c. Rename all local variables referencing `accountUlid` → `accountId`, `documentUlid` → `documentId` throughout the existing methods.

3d. Update `ensurePayloadIndex()` to use `KB_ACCOUNT_ID_INDEX_FIELD` (`"account_id"`).

3e. Update `writeQdrantPoints()` signature and payload object to use renamed fields.

3f. Update `writeDynamoRecord()` signature and item object to use renamed fields; add `_lastUpdated_` parameter and field.

3g. Add `lookupExistingDocument()` private method (implements the DynamoDB Query from the Lookup Mechanism section). Returns `{ documentId: string; createdAt: string } | null`.

3h. Add `deleteQdrantPoints()` private method (implements the Qdrant `delete` call from the Update Pipeline step 6).

3i. Rewrite `ingestDocument()` to implement the 9-step update pipeline. Capture `lastUpdated = new Date().toISOString()` at method entry. Thread `createdAt` and `lastUpdated` through `writeDynamoRecord()`.

3j. Add `deleteDocument()` public method (implements the Delete Pipeline).

3k. Update all `this.logger.*` log lines to use renamed bracket fields (`accountId=`, `documentId=`).

Done when: `tsc --noEmit` passes for this file in isolation (spec will still fail until step 5).

### Step 4 — Update `src/controllers/knowledge-base.controller.ts`

4a. Update imports: add `Delete, HttpCode` (HttpCode already imported; verify Delete is added from `@nestjs/common`). Add `deleteDocumentSchema`, `DeleteDocumentBody` from the schema file. Add `KnowledgeBaseDeleteDocumentInput` from types (if needed directly, though the service accepts it).

4b. Update `ingestDocument()`: rename the local variable `rawAccountUlid` → `rawAccountId`; rename all mapped input fields from camelCase to the new camelCase names (`account_id` → `accountId`, `external_id` → `externalId`, `source_type` → `sourceType`, `mime_type` → `mimeType`).

  Note: The body fields from Zod are now snake_case (`body.account_id`, `body.external_id`, `body.source_type`, `body.mime_type`). The `KnowledgeBaseIngestDocumentInput` internal fields are camelCase (`accountId`, `externalId`, `sourceType`, `mimeType`). The controller maps wire-format → internal format, same as today but with renamed keys.

4c. Add `deleteDocument()` handler:

```typescript
@Delete("documents")
@HttpCode(204)
async deleteDocument(
  @Body(new ZodValidationPipe(deleteDocumentSchema)) body: DeleteDocumentBody,
): Promise<void> {
  const rawAccountId = body.account_id.slice(2);
  return this.ingestionService.deleteDocument({ accountId: rawAccountId, externalId: body.external_id });
}
```

Done when: `tsc --noEmit` passes for this file.

### Step 5 — Update `src/services/knowledge-base-ingestion.service.spec.ts`

5a. Update `STUB_INPUT` to use renamed fields (`accountId` instead of `accountUlid`).

5b. Add `delete` mock to `mockQdrantClient` (set up in `beforeEach` as `mockQdrantClient.delete.mockResolvedValue({ status: "completed", operation_id: 2 })`).

5c. Import `QueryCommand`, `DeleteCommand` from `@aws-sdk/lib-dynamodb`. Add `ddbMock.on(QueryCommand).resolves({ Items: [] })` in the default `beforeEach` (empty result = create path by default).

5d. Update all assertions for renamed fields:
  - `result.documentUlid` → `result.document_id`
  - `result.chunkCount` → `result.chunk_count`
  - `result.createdAt` → `result._createdAt_`
  - Add `result._lastUpdated_` assertion where appropriate
  - `item.entity` → `"KNOWLEDGE_BASE_DOCUMENT"`
  - `item.account_ulid` → `item.account_id`
  - `item.document_ulid` → `item.document_id`
  - `item.created_at` → `item._createdAt_`
  - Add `item._lastUpdated_` assertion
  - `point.payload.account_ulid` → `point.payload.account_id`
  - `point.payload.document_ulid` → `point.payload.document_id`
  - `createPayloadIndex` field_name assertion: `"account_ulid"` → `"account_id"`

5e. Add test cases — **Update path:**

  - `"second POST with same external_id reuses document_id, advances _lastUpdated_, preserves _createdAt_, replaces chunks"`:
    - Set up `ddbMock.on(QueryCommand).resolves({ Items: [{ document_id: DOCUMENT_ID, _createdAt_: "2026-01-01T00:00:00.000Z" }] })`.
    - Set up `mockQdrantClient.delete.mockResolvedValue({ status: "completed", operation_id: 2 })`.
    - Call `service.ingestDocument(STUB_INPUT)`.
    - Assert `result.document_id === DOCUMENT_ID`.
    - Assert `result._createdAt_ === "2026-01-01T00:00:00.000Z"` (preserved).
    - Assert `result._lastUpdated_` is a more recent ISO string (or just that it is a string matching ISO pattern).
    - Assert `mockQdrantClient.delete` was called once with correct filter.
    - Assert `mockQdrantClient.upsert` was called once.
    - Assert `ddbMock.commandCalls(PutCommand)` has length 1.

  - `"second POST with same external_id — Qdrant delete failure → 500, DDB not written"`:
    - Set up QueryCommand to return existing record.
    - `mockQdrantClient.delete.mockRejectedValue(new Error("Qdrant delete error"))`.
    - Assert `rejects.toThrow(InternalServerErrorException)`.
    - Assert `ddbMock.commandCalls(PutCommand)` has length 0.

  - `"first POST with new external_id — skips Qdrant delete, creates new document_id"`:
    - Default `ddbMock.on(QueryCommand).resolves({ Items: [] })` (already covered by default setup).
    - Assert `mockQdrantClient.delete` was NOT called.

5f. Add test cases — **Delete path:**

  - `"deleteDocument — found: deletes Qdrant chunks and DDB record, returns void (204)"`:
    - `ddbMock.on(QueryCommand).resolves({ Items: [{ document_id: DOCUMENT_ID, _createdAt_: "..." }] })`.
    - `ddbMock.on(DeleteCommand).resolves({})`.
    - `mockQdrantClient.delete.mockResolvedValue({ status: "completed", operation_id: 3 })`.
    - Assert `service.deleteDocument(...)` resolves without throwing.
    - Assert `mockQdrantClient.delete` called once with correct `account_id` + `document_id` filter.
    - Assert `ddbMock.commandCalls(DeleteCommand)` has length 1 with correct PK/SK.

  - `"deleteDocument — not found: returns void without calling Qdrant delete or DDB delete (idempotent 204)"`:
    - `ddbMock.on(QueryCommand).resolves({ Items: [] })`.
    - Assert resolves without throwing.
    - Assert `mockQdrantClient.delete` NOT called.
    - Assert `ddbMock.commandCalls(DeleteCommand)` has length 0.

  - `"deleteDocument — Qdrant delete failure → 500, DDB record not deleted"`:
    - Set up QueryCommand to return existing record.
    - `mockQdrantClient.delete.mockRejectedValue(new Error("Qdrant error"))`.
    - Assert `rejects.toThrow(InternalServerErrorException)`.
    - Assert `ddbMock.commandCalls(DeleteCommand)` has length 0.

  - `"deleteDocument — DDB delete failure → 500"`:
    - Set up QueryCommand to return existing record.
    - `mockQdrantClient.delete.mockResolvedValue({ status: "completed" })`.
    - `ddbMock.on(DeleteCommand).rejects(new Error("DDB error"))`.
    - Assert `rejects.toThrow(InternalServerErrorException)`.

  - `"deleteDocument — DDB lookup failure → 500"`:
    - `ddbMock.on(QueryCommand).rejects(new Error("DDB timeout"))`.
    - Assert `rejects.toThrow(InternalServerErrorException)`.
    - Assert `mockQdrantClient.delete` NOT called.

Done when: all spec assertions reference correct renamed fields and new test cases are in place.

### Step 6 — Update `src/controllers/knowledge-base.controller.spec.ts`

6a. Update `STUB_RESULT` to use renamed fields: `document_id`, `chunk_count`, `_createdAt_`, `_lastUpdated_`.

6b. Update `VALID_BODY` to use renamed fields: `account_id`, `external_id`, `source_type`, `mime_type`.

6c. Update all `expect(mockIngestionService.ingestDocument).toHaveBeenCalledWith(...)` matchers to use renamed input fields (`accountId`, `externalId`, `sourceType`, `mimeType`).

6d. Update `"response shape includes all four required fields"` test to check `document_id`, `chunk_count`, `_createdAt_`, `_lastUpdated_`.

6e. Add `delete` mock to `mockIngestionService`.

6f. Add DELETE handler tests:
  - `"returns 204 No Content on success"` — check `HTTP_CODE_METADATA` on `deleteDocument` is `204`.
  - `"calls deleteDocument with raw accountId (A# prefix stripped)"` — assert service called with `{ accountId: VALID_ACCOUNT_ULID, externalId: "ext-doc-001" }`.
  - `"returns void"` — assert handler returns `undefined`.
  - Validation pipe tests for `deleteDocumentSchema`: rejects missing `account_id`, rejects missing `external_id`, rejects bare accountId without `A#` prefix.
  - Error propagation: `"re-throws InternalServerErrorException from deleteDocument service"`.

### Step 7 — Update `src/tools/lookup-knowledge-base.tool.ts`

7a. Change the Qdrant search filter key from `"account_ulid"` to `"account_id"`.

7b. Change the payload field access `payload.document_ulid` → `payload.document_id` in the `flatMap` mapping block.

7c. Update the malformed-payload guard to check `chunk_text` and `document_title` — these field names do NOT change, so the guard itself is unchanged. Verify.

7d. Update the returned chunk object: `document_ulid: payload.document_ulid` → `document_id: payload.document_id`.

7e. Update any log lines referencing old field names (e.g., `accountUlid=` → `accountId=` — but note the tool receives `context.accountUlid` which is from the non-KB `ChatToolExecutionContext` type and must NOT be changed).

  Important boundary: `context.accountUlid` is from `ChatToolExecutionContext` (non-KB type — out of scope). The log line `accountUlid=${context.accountUlid}` is fine to leave unchanged. Only the Qdrant filter key and payload field references change.

### Step 8 — Update `src/tools/lookup-knowledge-base.tool.spec.ts`

8a. Update `makeScoredPoint()` stub payload: rename `account_ulid` → `account_id`, `document_ulid` → `document_id`, `created_at` → `_createdAt_`.

8b. Update the filter assertion in `"calls embedText with the query and search with limit=5..."` from `{ key: "account_ulid", ... }` to `{ key: "account_id", ... }`.

8c. Update `"maps ScoredPoint payload fields to KnowledgeBaseRetrievalChunk correctly"` — the result chunk now has `document_id` (not `document_ulid`); update `expect(chunk.document_ulid)` → `expect(chunk.document_id)`.

8d. Update the malformed payload stub (missing `chunk_text` test) — change `account_ulid` → `account_id`, `document_ulid` → `document_id`, `created_at` → `_createdAt_` in the malformed point payload override.

---

## Qdrant SDK `delete` Method — Verified Signature

Source: installed SDK at `node_modules/@qdrant/js-client-rest/dist/types/qdrant-client.d.ts` (line 500) and the Qdrant API reference at https://api.qdrant.tech/api-reference/points/delete-points.

**Signature:**
```typescript
delete(
  collection_name: string,
  {
    wait,
    ordering,
    timeout,
    ...points_selector
  }: {
    wait?: boolean;
    ordering?: Schemas['WriteOrdering'];
    timeout?: number;
  } & Schemas['PointsSelector']
): Promise<Schemas['UpdateResult']>
```

Where `PointsSelector = PointIdsList | FilterSelector` and `FilterSelector = { filter: Filter; shard_key?: ... }`.

**Correct call shape for this phase:**
```typescript
await this.qdrantClient.delete(KB_COLLECTION_NAME, {
  wait: true,
  filter: {
    must: [
      { key: "account_id", match: { value: accountId } },
      { key: "document_id", match: { value: documentId } },
    ],
  },
});
```

**Return shape (`UpdateResult`):**
```typescript
{
  operation_id?: number | null;   // sequential operation number
  status: "acknowledged" | "completed" | "wait_timeout";
}
```

**`wait: true` is required for pipeline correctness.** Without it, Qdrant returns `status: "acknowledged"` immediately — meaning the delete has been accepted into the write-ahead log but not yet applied to storage. If the upsert in step 7 executes before the delete is reflected, searches against the same `document_id` would see both the old and new chunks transiently. With `wait: true`, Qdrant blocks until `status: "completed"`, guaranteeing the old chunks are gone before new chunks are written. This matches the existing pattern in `writeQdrantPoints()` which already passes `wait: true` to `upsert`.

---

## Risks and Edge Cases

### 1. `KnowledgeBaseRetrievalChunk.document_ulid` rename affects tool output JSON (HIGH)

The field `document_ulid` in the `KnowledgeBaseRetrievalChunk` interface becomes `document_id`. This field is directly serialized into the tool result JSON returned to the Anthropic API and consumed by the chat agent. The brief explicitly locks this rename. However, any downstream consumer (e.g., agent prompt templates, integration tests, the ecommerce backend reading tool outputs) currently reading `document_ulid` from the tool output will silently receive `undefined` after this change.

Mitigation: Flag this in the code review step. Confirm no downstream consumer reads `document_ulid` from tool results. The ecommerce backend integration is noted in memory as incomplete; this rename may interact with it.

### 2. Concurrent re-ingests of the same `(account_id, external_id)` (MEDIUM)

Two POST requests arriving simultaneously for the same `(account_id, external_id)`:
- Both read the existing DDB record and both find the same `document_id`.
- Both delete the same Qdrant points (idempotent — second delete is a no-op).
- Both upsert new Qdrant chunks (with their own `randomUUID()` point IDs, so they don't collide).
- Both write a DDB PutCommand replacing the same item.

Result: both requests succeed; the DDB record and Qdrant are in a valid state. The Qdrant collection will have 2× the expected chunk count for that document until the losing write's chunks are cleaned up. The next re-ingest will delete all chunks for that `document_id` and rewrite clean. This is acceptable for the current scale.

Mitigation: Document the known race. A future phase can add optimistic locking (DDB condition expressions) if it becomes a problem.

### 3. Orphaned Qdrant chunks — DDB record gone but Qdrant chunks remain (MEDIUM)

This can happen if:
- A previous update or delete succeeded on DDB but failed on Qdrant (or vice versa), or
- An operator manually deleted the DDB record outside the API.

In this scenario:
- A new POST arrives for the same `(account_id, external_id)` → DDB lookup misses → the service treats it as a fresh create → generates a new `document_id` → writes new chunks under the new `document_id`.
- The old orphaned chunks (under the old `document_id`) remain in Qdrant indefinitely. They will appear in search results for that account.

Mitigation: The current phase does not fix this. The service cannot detect it without a Qdrant scroll/count operation on `(account_id, external_id)` which is expensive. Flag for Phase 8: add a cleanup/reconciliation mechanism if this becomes a real operational problem. For the current scale (small number of documents per account), the impact is limited.

The reverse orphan (DDB record exists, no matching Qdrant chunks) is less dangerous — search returns no results for that document, which is a false negative but not a data leak. Update will re-create the Qdrant chunks correctly.

### 4. `wait: true` on Qdrant delete and subsequent search visibility (LOW — resolved)

Confirmed via SDK `.d.ts` and API docs: `wait: true` causes the operation to block until `status: "completed"`. Subsequent `search` calls in the same pipeline (step 7 upsert and any subsequent read) will see a clean state. This is the same pattern already used for `upsert`. No risk.

### 5. Filter-scan performance on large account partitions (LOW at current scale)

The `QueryCommand` with `begins_with(SK, "KB#DOC#")` + `FilterExpression` on `external_id` scans all KB document items for the given account. At low document counts (< ~1000), this is negligible. At higher counts, each lookup adds latency.

Mitigation: The brief explicitly defers a GSI to a future phase. Document the threshold: add a GSI when an account hosts > ~500 documents or when p99 lookup latency exceeds 10ms in profiling.

### 6. `mime_type` handling in the delete lookup (LOW)

The `lookupExistingDocument()` query only projects `document_id` and `_createdAt_`. If the implementer does not add a `ProjectionExpression`, DynamoDB returns the full item, which is acceptable and avoids needing to add `ExpressionAttributeNames` for the projection. The full item is safe to read and discard.

---

## Testing Strategy

### Tests that need assertion updates (existing tests)

**`src/services/knowledge-base-ingestion.service.spec.ts`**

| Test description | What changes |
|-----------------|--------------|
| `"returns the correct result DTO"` | `result.documentUlid` → `result.document_id`; `result.chunkCount` → `result.chunk_count`; `result.createdAt` → `result._createdAt_`; add `result._lastUpdated_` assertion |
| `"upserts 3 points with correct payload fields including account_ulid and chunk_index"` | `p0.payload.account_ulid` → `p0.payload.account_id`; `p0.payload.document_ulid` → `p0.payload.document_id` |
| `"writes a DynamoDB record with the correct pk, sk, and account_ulid"` | `item.entity` → `"KNOWLEDGE_BASE_DOCUMENT"`; `item.account_ulid` → `item.account_id`; `item.document_ulid` → `item.document_id`; `item.created_at` / `item._createdAt_`; add `item._lastUpdated_` assertion |
| `"calls createPayloadIndex on account_ulid after creating a new collection"` | `field_name: "account_ulid"` → `field_name: "account_id"` |
| `"calls createPayloadIndex even when the collection already exists"` | Same `field_name` rename |
| `"account_ulid appears in every Qdrant point payload"` | Rename to `account_id`; update assertion |
| `STUB_INPUT` constant | `accountUlid` field → `accountId` |

**`src/controllers/knowledge-base.controller.spec.ts`**

| Test description | What changes |
|-----------------|--------------|
| `VALID_BODY` constant | `accountUlid` → `account_id`, `externalId` → `external_id`, `sourceType` → `source_type` |
| `STUB_RESULT` constant | `documentUlid` → `document_id`, `chunkCount` → `chunk_count`, `createdAt` → `_createdAt_`; add `_lastUpdated_` |
| `"calls ingestDocument with the raw accountUlid (A# prefix stripped)"` | Matcher fields renamed: `accountUlid` → `accountId`, `externalId` → `externalId` (unchanged), `sourceType` → `sourceType`, `mimeType` → `mimeType` |
| `"response shape includes all four required fields"` | Check `document_id`, `chunk_count`, `_createdAt_`, `_lastUpdated_` |
| All Zod pipe tests | Field names in `pipe.transform(...)` inputs renamed to snake_case |

**`src/tools/lookup-knowledge-base.tool.spec.ts`**

| Test description | What changes |
|-----------------|--------------|
| `makeScoredPoint()` default payload | `account_ulid` → `account_id`, `document_ulid` → `document_id`, `created_at` → `_createdAt_` |
| `"calls embedText with the query and search with limit=5..."` filter assertion | `key: "account_ulid"` → `key: "account_id"` |
| `"maps ScoredPoint payload fields..."` | `chunk.document_ulid` → `chunk.document_id` |
| Malformed payload stub | Rename fields in overridden payload object |

### New test cases (service spec)

- Update happy path: second POST reuses `document_id`, preserves `_createdAt_`, advances `_lastUpdated_`, calls Qdrant delete + upsert.
- Update with Qdrant delete failure: second POST returns 500, DDB PutCommand not called.
- Create path: first POST does not call Qdrant delete.

### New test cases (delete — service spec)

- Delete found: Qdrant delete and DDB DeleteCommand called, returns void.
- Delete not found: no-op, neither Qdrant delete nor DDB DeleteCommand called, returns void.
- Delete with Qdrant failure: 500.
- Delete with DDB failure: 500.
- Delete with DDB lookup failure: 500, Qdrant delete not called.

### New test cases (controller spec)

- DELETE handler returns 204 (check `HTTP_CODE_METADATA`).
- DELETE handler strips `A#` prefix and calls service correctly.
- DELETE handler returns void.
- Zod validation for delete body (missing `account_id`, missing `external_id`, invalid prefix format).
- DELETE error propagation: InternalServerErrorException from service.

---

## Out-of-Scope Confirmations

The following are explicitly out of scope for Phase 7a and must not appear in the implementation:

- Soft delete or audit history — hard delete only.
- GET / list endpoints — future KB admin phase.
- Renaming `accountUlid` in non-KB code (`web-chat.controller.ts`, `chat-session.service.ts`, `identity.service.ts`, `origin-allowlist.service.ts`, `web-chat.schema.ts`, etc.).
- A new GSI for `external_id` lookups.
- Content-hash-based idempotency.
- Compensation/rollback logic for partial failures.
- Multi-document or bulk operations.
- Any changes to `src/validation/tool.schema.ts` (the `lookupKnowledgeBaseInputSchema` is unchanged).
- Any changes to the Qdrant collection schema (collection name, vector size, distance metric are all unchanged).
- Any changes to `src/utils/knowledge-base/constants.ts`.

---

## Implementation Recommendations

1. **Apply the renames as a single pass first** before adding new behaviour. Run `npm run build` after the rename pass to confirm zero TypeScript errors before writing the update/delete logic. This keeps the diff reviewable.

2. **The `lookupExistingDocument()` method should be shared** between `ingestDocument()` and `deleteDocument()`. A single private method with a clear return type avoids duplication and ensures both paths use identical query parameters.

3. **`lastUpdated` timestamp must be captured at method entry**, not inside `writeDynamoRecord()`. This ensures the Qdrant chunk `_createdAt_` and the DDB record `_lastUpdated_` carry the same timestamp (both represent "this ingestion run started at T").

4. **Do not use `UpdateCommand` for the DDB update path.** The existing `PutCommand` already replaces the item at the same PK+SK. Using `PutCommand` is simpler, idempotent, and consistent with the existing create path. An `UpdateCommand` would require listing every attribute to update and is unnecessary.

5. **The `deleteDocument()` Qdrant filter must include both `account_id` AND `document_id`.** Using only `document_id` is technically sufficient (ULIDs are globally unique), but including `account_id` as a guard respects the per-account isolation invariant established in Phases 4 and 5. The code reviewer will check for this explicitly.

6. **Mock `QueryCommand` in the default `beforeEach` as `Items: []`** (create path). Tests that need the update path override this with their own `ddbMock.on(QueryCommand).resolves(...)`. This is consistent with how `PutCommand` is handled in the existing spec.

7. **`DeleteCommand` import**: confirm it is available from `"@aws-sdk/lib-dynamodb"`. The chat-session service does not use it, but the origin-allowlist and identity services use the same DDB document client. Run a quick grep to confirm `DeleteCommand` is re-exported from that package before the implementer writes the import line.
