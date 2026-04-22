# Phase 4 — Ingestion Endpoint + Pipeline: Implementation Plan

## Overview

This phase exposes `POST /knowledge-base/documents`, a synchronous HTTP endpoint that accepts extracted plain text from the upstream control-panel API, runs it through the ingestion pipeline (chunk → embed → write to Qdrant + DynamoDB), and returns a `201 Created` response containing the document's ULID, chunk count, status, and creation timestamp. All orchestration lives in a single `KnowledgeBaseIngestionService`. The controller is thin and follows the exact same `ZodValidationPipe` + delegate-to-service pattern used by `WebChatController`. No auth, no async queue, no enrichment, no retrieval tool.

---

## Live-Docs Verification Findings

### Voyage `voyage-3-large` output dimension

**Confirmed: 1024 dimensions.**

Source: `https://docs.voyageai.com/docs/embeddings`

The brief's assumption of 1024 is correct. The `knowledge_base` Qdrant collection must be created with `vectors: { size: 1024, distance: "Cosine" }`. Note: `voyage-3-large` does support flexible output dimensions (256, 512, 1024, 2048), but no `output_dimension` parameter is passed by `VoyageService` — it uses the model default. The collection must match that default of 1024.

### Qdrant JS client SDK shapes (verified against installed `@qdrant/js-client-rest` v1.17.0 type declarations)

Source: `node_modules/@qdrant/js-client-rest/dist/types/qdrant-client.d.ts` and `generated_schema.d.ts`

**`getCollections()`**
```typescript
getCollections(): Promise<Schemas['CollectionsResponse']>
// CollectionsResponse: { collections: { name: string }[] }
```
Use `result.collections.some(c => c.name === "knowledge_base")` to test for existence.

**`collectionExists(collection_name: string)`** — IMPORTANT DELTA FROM BRIEF
The SDK at v1.17.0 exposes a dedicated method not mentioned in the brief:
```typescript
collectionExists(collection_name: string): Promise<Schemas['CollectionExistence']>
// CollectionExistence: { exists: boolean }
```
This is the cleaner option for the existence check. Both approaches work; see the "Collection creation" section below for the recommended choice.

**`createCollection(collection_name, args)`**
```typescript
createCollection(
  collection_name: string,
  { timeout, vectors, ...}: { timeout?: number } & Schemas['CreateCollection']
): Promise<boolean>
```
The `vectors` parameter accepts either a single `VectorParams` (anonymous default vector) or a named-vector map. For Phase 4, pass a single `VectorParams`:
```typescript
{ vectors: { size: 1024, distance: "Cosine" } }
```
Note the parameter name in `CreateCollection` schema is `vectors` (not `vectors_config`). The `createCollection` method signature destructures it as `vectors`. This matches the brief.

**`upsert(collection_name, args)`**
```typescript
upsert(
  collection_name: string,
  { wait, ordering, timeout, ...points_or_batch }:
    { wait?: boolean; ordering?: WriteOrdering; timeout?: number }
    & Schemas['PointInsertOperations']
): Promise<Schemas['UpdateResult']>
```
Points are passed as:
```typescript
{ points: [{ id: number | string, vector: number[], payload: Record<string, unknown> }] }
```

**Point ID format**
`ExtendedPointId` is typed as `number | string`. UUID strings are valid point IDs — confirmed from the type definition and from inline SDK comment examples that show UUID strings like `"cd3b53f0-11a7-449f-bc50-d06310e7ed90"`. The brief's decision to generate a fresh UUID per chunk is fully supported by the SDK.

**UUID generation**
The project has no existing UUID utility — `grep` for `uuid`, `randomUUID`, and `crypto.random` returned no matches in `src/`. However, Node.js 18+ exposes `crypto.randomUUID()` as a global with no import required. The project targets Node.js (confirmed by the runtime). This is the correct approach: use `crypto.randomUUID()` directly, with no new library dependency. Flag: if the minimum Node.js version were below 18, this would need `import { randomUUID } from 'crypto'`. With NestJS 11 requiring Node 18+, the global is always available — but the implementer should use the named import form `import { randomUUID } from 'crypto'` for explicitness and testability.

---

## Affected Files and Modules

### Create (new files)

| File | Purpose |
|------|---------|
| `src/validation/knowledge-base.schema.ts` | Zod schema for the request body; exports the schema and its inferred type |
| `src/pipes/knowledgeBaseValidation.pipe.ts` | Re-exports `ZodValidationPipe` with the KB schema pre-bound — matches the `webChatValidation.pipe.ts` naming convention |
| `src/controllers/knowledge-base.controller.ts` | Thin controller; one `@Post("documents")` handler; applies the pipe; calls the service; returns 201 |
| `src/services/knowledge-base-ingestion.service.ts` | Pipeline orchestrator; single public method + private helpers |
| `src/controllers/knowledge-base.controller.spec.ts` | Unit test for the controller with the service mocked |
| `src/services/knowledge-base-ingestion.service.spec.ts` | Unit test for the service with Qdrant, Voyage, chunker, and DynamoDB mocked |

### Modify (existing files)

| File | Change |
|------|--------|
| `src/types/KnowledgeBase.ts` | Add new interfaces: request DTO, response DTO, DynamoDB record shape, Qdrant point payload shape |
| `src/app.module.ts` | Register `KnowledgeBaseController` in `controllers[]` and `KnowledgeBaseIngestionService` in `providers[]` |

### Review Only (no changes)

| File | Why reviewed |
|------|-------------|
| `src/providers/qdrant.provider.ts` | Confirms `QDRANT_CLIENT` token and `QdrantClient` type |
| `src/services/voyage.service.ts` | Confirms `embedTexts(texts: readonly string[]): Promise<number[][]>` signature |
| `src/utils/chunker/chunker.ts` | Confirms `chunkText(source, options?)` signature and return type |
| `src/pipes/webChatValidation.pipe.ts` | Pattern to mirror for the new pipe |
| `src/validation/web-chat.schema.ts` | Pattern to mirror for the new schema |
| `src/controllers/web-chat.controller.ts` | Pattern to mirror for the new controller |
| `src/services/chat-session.service.ts` | DI, logging, and DynamoDB usage pattern |
| `src/tools/list-services.tool.ts` | DynamoDB query pattern, bracketed log format |
| `src/services/identity.service.ts` | Confirms `ulid()` from the `ulid` package is the project's ULID generator |

---

## Dependencies and Architectural Considerations

- **ULID generation:** `ulid()` from the `ulid` package (already in `package.json`). Import from `"ulid"`. Do NOT add a new library.
- **UUID generation for Qdrant point IDs:** `randomUUID` from Node.js built-in `"crypto"`. Named import `import { randomUUID } from "crypto"`. No new dependency.
- **Qdrant client:** Injected via `QDRANT_CLIENT` token (from `src/providers/qdrant.provider.ts`). The provider is already registered in `AppModule`.
- **Voyage service:** `VoyageService` is already registered in `AppModule`. Inject by class reference.
- **DynamoDB client:** Injected via `DYNAMO_DB_CLIENT` token. Already registered in `AppModule`.
- **Database table name:** Via `DatabaseConfigService.conversationsTable`. Already registered in `AppModule`.
- **Chunker:** Pure function import — `import { chunkText } from "../utils/chunker/chunker"`. No DI needed.
- **No new environment variables:** All required config (Qdrant URL/key, Voyage key, DynamoDB table) already exist.
- **No schema migrations:** DynamoDB is schemaless. The new record shape (with `KB#DOC#` SK prefix) is additive to the existing single table.
- **No new npm packages required.**
- **`src/types/KnowledgeBase.ts` currently contains only chunker interfaces.** The new interfaces are additive — do not remove or rename existing exports.

---

## Type Additions

All additions go into `src/types/KnowledgeBase.ts`, appended after the existing `KnowledgeBaseChunk` and `KnowledgeBaseChunkOptions` interfaces.

### Request DTO (mirrors the validated body after the pipe runs)

```typescript
export type KnowledgeBaseSourceType = "pdf" | "csv" | "docx" | "txt" | "html";

export interface IngestDocumentInput {
  accountUlid: string;
  externalId: string;
  title: string;
  text: string;
  sourceType: KnowledgeBaseSourceType;
  mimeType?: string;
}
```

### Response DTO (what the controller returns; maps to the 201 response body)

```typescript
export interface IngestDocumentResult {
  documentUlid: string;
  chunkCount: number;
  status: "ready";
  createdAt: string; // ISO-8601
}
```

### DynamoDB record shape

```typescript
export interface KnowledgeBaseDocumentRecord {
  pk: string;            // "A#<accountUlid>"
  sk: string;            // "KB#DOC#<documentUlid>"
  entity: "KB_DOCUMENT";
  document_ulid: string;
  account_ulid: string;
  external_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  mime_type?: string;
  chunk_count: number;
  status: "ready";
  created_at: string;    // ISO-8601
}
```

### Qdrant point payload shape

```typescript
export interface KnowledgeBasePointPayload {
  account_ulid: string;
  document_ulid: string;
  document_title: string;
  external_id: string;
  chunk_index: number;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
  source_type: KnowledgeBaseSourceType;
  created_at: string;    // ISO-8601
}
```

---

## Zod Validation Schema

File: `src/validation/knowledge-base.schema.ts`

```typescript
import { z } from "zod";

// Same regex used in web-chat.schema.ts — bare 26-char ULID (no prefix)
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const ingestDocumentSchema = z.object({
  accountUlid: z
    .string()
    .regex(ulidRegex, "accountUlid must be a valid 26-character ULID"),
  externalId: z.string().min(1, "externalId must not be empty"),
  title: z.string().min(1, "title must not be empty"),
  text: z.string().min(1, "text must not be empty"),
  sourceType: z.enum(["pdf", "csv", "docx", "txt", "html"], {
    message: "sourceType must be one of: pdf, csv, docx, txt, html",
  }),
  mimeType: z.string().optional(),
});

export type IngestDocumentBody = z.infer<typeof ingestDocumentSchema>;
```

**Design note on `accountUlid` format:** In `web-chat.schema.ts`, the widget sends `accountUlid` with an `A#` prefix. In this endpoint, the upstream control-panel API is a trusted internal caller that is expected to send the raw 26-char ULID without a prefix (matching the DynamoDB storage convention). The zod schema validates against the bare ULID regex, not the `A#`-prefixed form. The controller does NOT strip any prefix — it passes `body.accountUlid` directly to the service. This is consistent with how tools like `ListServicesTool` receive `accountUlid` from the session context (already stripped). **Flag for orchestrator review:** If the control-panel API will actually send the prefixed form, the schema and controller must strip it. Confirm with the user before Step 2.

---

## Pipe Implementation

File: `src/pipes/knowledgeBaseValidation.pipe.ts`

The existing `ZodValidationPipe` in `src/pipes/webChatValidation.pipe.ts` is a generic class that accepts any `ZodSchema` in its constructor. The new pipe file should simply re-export it — following the convention where named pipe files make the schema binding explicit at the call site:

```typescript
// src/pipes/knowledgeBaseValidation.pipe.ts
export { ZodValidationPipe } from "./webChatValidation.pipe";
```

**Rationale:** The `webChatValidation.pipe.ts` export name `ZodValidationPipe` is already a generic name. The controller will instantiate it with the KB schema directly, just as `WebChatController` does:
```typescript
@Body(new ZodValidationPipe(ingestDocumentSchema)) body: IngestDocumentBody
```

There is no need to create a separate class — only a separate file to maintain the naming convention of one pipe file per domain. The pipe file simply re-exports so that the KB controller imports from the KB pipe file without needing to reach into the web-chat pipe file.

---

## Controller Design

File: `src/controllers/knowledge-base.controller.ts`

- Decorator: `@Controller("knowledge-base")`
- One handler: `@Post("documents")` — responds `201 Created` by default in NestJS (POST returns 201 automatically; no `@HttpCode` needed since NestJS POST defaults to 201 for async handlers that return a value)
- Apply `ZodValidationPipe(ingestDocumentSchema)` to `@Body()`
- No try/catch in the controller — NestJS's global exception filter handles `BadRequestException` (400) and `InternalServerErrorException` (500) thrown by the service
- Return the `IngestDocumentResult` directly

```
@Controller("knowledge-base")
export class KnowledgeBaseController {
  constructor(private readonly ingestionService: KnowledgeBaseIngestionService) {}

  @Post("documents")
  async ingestDocument(
    @Body(new ZodValidationPipe(ingestDocumentSchema)) body: IngestDocumentBody,
  ): Promise<IngestDocumentResult> {
    return this.ingestionService.ingestDocument(body);
  }
}
```

**Note:** NestJS POST handlers return 201 by default when the method is `async` and returns a value. Confirm this in the NestJS version in use (v11). If the default is 200, add `@HttpCode(201)`.

---

## Service Public API

File: `src/services/knowledge-base-ingestion.service.ts`

```typescript
@Injectable()
export class KnowledgeBaseIngestionService {
  ingestDocument(input: IngestDocumentInput): Promise<IngestDocumentResult>

  // Private helpers:
  private ensureCollection(): Promise<void>
  private writeQdrantPoints(documentUlid: string, input: IngestDocumentInput, chunks: KnowledgeBaseChunk[], embeddings: number[][], createdAt: string): Promise<void>
  private writeDynamoRecord(documentUlid: string, input: IngestDocumentInput, chunkCount: number, createdAt: string): Promise<void>
}
```

Constructor injections:
```typescript
constructor(
  @Inject(QDRANT_CLIENT) private readonly qdrantClient: QdrantClient,
  @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
  private readonly voyageService: VoyageService,
  private readonly databaseConfig: DatabaseConfigService,
)
```

---

## Service Control Flow

The `ingestDocument` method follows these numbered steps:

```
1. Record start timestamp for timing logs.
   const startedAt = Date.now();

2. Log the incoming request.
   this.logger.log(`Ingesting document [accountUlid=... externalId=... textLength=...]`);

3. Generate the documentUlid.
   const documentUlid = ulid();
   // Uses `ulid()` from the `ulid` package — same as identity.service.ts and chat-session.service.ts.

4. Chunk the input text using default parameters.
   const chunks = chunkText(input.text);
   // chunkText returns [] for empty/whitespace-only text.

5. Reject empty chunk result with a 400 error.
   if (chunks.length === 0) {
     throw new BadRequestException("Document text produced no content after chunking. Ensure the text field is not empty or whitespace-only.");
   }
   // The zod schema already rejects text.length === 0, but chunkText can return [] for
   // whitespace-only strings that pass min(1). This is the safety net.

6. Log chunk count.
   this.logger.debug(`Chunked document [documentUlid=... chunkCount=...]`);

7. Embed all chunk texts in a single call.
   const embeddings = await this.voyageService.embedTexts(chunks.map(c => c.text));
   // VoyageService handles internal batching (up to 1000 per API call).
   // VoyageService already throws sanitized errors — let them propagate.

8. Ensure the Qdrant collection exists.
   await this.ensureCollection();
   // See "Collection creation" section.

9. Build Qdrant points and upsert.
   await this.writeQdrantPoints(documentUlid, input, chunks, embeddings, createdAt);

10. Write DynamoDB metadata record.
    await this.writeDynamoRecord(documentUlid, input, chunks.length, createdAt);

11. Log completion with timing.
    const durationMs = Date.now() - startedAt;
    this.logger.log(`Ingestion complete [documentUlid=... chunkCount=... durationMs=...]`);

12. Return the result DTO.
    return { documentUlid, chunkCount: chunks.length, status: "ready", createdAt };
```

**`createdAt`** is captured once at the start of the method (before chunking) and reused for both the DynamoDB record and each Qdrant point payload. This ensures a single consistent timestamp across the entire document ingestion.

**`BadRequestException` from the service** is the correct pattern. The existing project convention (seen in `WebChatController.createSession`) uses `throw new BadRequestException(...)` inside the controller for business-rule rejections. In this case the service detects the empty-chunk condition — it is cleaner to throw `BadRequestException` from the service directly rather than returning a discriminated result, because there is no caller that needs to branch on success vs. failure. NestJS's exception filter correctly maps this to a 400 response. This matches how `list-services.tool.ts` returns error results from a service method.

---

## Private Method Designs

### `ensureCollection()`

```
1. Call this.qdrantClient.collectionExists("knowledge_base").
2. If result.exists === true, return immediately (no-op).
3. If result.exists === false, call:
     this.qdrantClient.createCollection("knowledge_base", {
       vectors: { size: 1024, distance: "Cosine" },
     });
4. If createCollection throws, catch the error.
   - Extract the error name/message safely (no raw error in response).
   - Log: `Failed to create Qdrant collection [errorType=...]`
   - Re-throw as: throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.")
```

**Race condition handling:** `collectionExists` + `createCollection` is not atomic. If two concurrent requests both find `exists === false` and both call `createCollection`, the second call will receive an error (Qdrant returns a 409 Conflict or similar when the collection already exists). The catch block must check for this: if the error message indicates the collection already exists, swallow the error and continue (it exists now). Use a string check on the error message or status code.

Use `collectionExists` rather than `getCollections` because it is a direct boolean answer that avoids scanning the full collection list. This is the more idiomatic v1.17.0 approach.

### `writeQdrantPoints()`

```
1. Build the points array:
   const points = chunks.map((chunk, i) => ({
     id: randomUUID(),           // UUID string — valid ExtendedPointId per SDK schema
     vector: embeddings[i],
     payload: {
       account_ulid: input.accountUlid,
       document_ulid: documentUlid,
       document_title: input.title,
       external_id: input.externalId,
       chunk_index: chunk.index,
       chunk_text: chunk.text,
       start_offset: chunk.startOffset,
       end_offset: chunk.endOffset,
       source_type: input.sourceType,
       created_at: createdAt,
     } satisfies KnowledgeBasePointPayload,
   }));

2. Call:
   await this.qdrantClient.upsert(KB_COLLECTION_NAME, { wait: true, points });

3. On error: catch, log [errorType=...], throw InternalServerErrorException with safe message.
```

`wait: true` ensures the upsert is durable before the method returns. Without it, the HTTP response could be sent before points are actually indexed.

### `writeDynamoRecord()`

```
1. Construct the item:
   {
     pk: `A#${input.accountUlid}`,
     sk: `KB#DOC#${documentUlid}`,
     entity: KB_DOCUMENT_ENTITY,     // "KB_DOCUMENT"
     document_ulid: documentUlid,
     account_ulid: input.accountUlid,
     external_id: input.externalId,
     title: input.title,
     source_type: input.sourceType,
     mime_type: input.mimeType,       // undefined → omitted in DynamoDB
     chunk_count: chunkCount,
     status: "ready",
     created_at: createdAt,
   } satisfies KnowledgeBaseDocumentRecord

2. Call:
   await this.dynamoDb.send(new PutCommand({ TableName: this.databaseConfig.conversationsTable, Item: item }));

3. On error: catch, log [errorType=...], throw InternalServerErrorException with safe message.
```

---

## Collection Creation — Race Safety Detail

**Pattern:** `collectionExists` → branch on `exists` → `createCollection` → catch "already exists" race.

The SDK's `collectionExists` method returns `{ exists: boolean }`. This is a point-in-time check. Between the check and `createCollection`, another request could win the race. The `createCollection` error in that case will be a REST error from Qdrant with a status indicating the collection already exists. The implementer should catch `createCollection` errors and inspect the error message or status:

```typescript
} catch (error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("already exists")) {
    // Lost the race — collection now exists. Safe to continue.
    return;
  }
  // Genuine failure
  const errorName = error instanceof Error ? error.name : "UnknownError";
  this.logger.error(`Failed to create Qdrant collection [errorType=${errorName}]`);
  throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
}
```

This race only occurs on first-ever ingestion for the instance. Once the collection exists, `collectionExists` returns `true` and `createCollection` is never called. The pattern is safe for the Phase 4 MVP.

---

## Error Handling Strategy

| Failure scenario | Error surface | Log line | HTTP response |
|-----------------|---------------|----------|---------------|
| Empty/whitespace text (0 chunks) | `BadRequestException` thrown from service | None | 400 with clear message |
| Zod validation failure | `BadRequestException` thrown from `ZodValidationPipe` | None | 400 with field-level message |
| Voyage auth failure (401) | `VoyageService` throws `Error("Voyage API authentication failed — check VOYAGE_API_KEY")` — propagates | None additional (VoyageService already logs `[statusCode=401]`) | 500 via NestJS unhandled exception filter |
| Voyage rate limit (429) | `VoyageService` throws — propagates | None additional | 500 |
| Voyage network error | `VoyageService` throws — propagates | None additional | 500 |
| Qdrant collection check fails | Caught in `ensureCollection` | `[errorType=...]` via `logger.error` | 500 with `"Knowledge base storage is temporarily unavailable."` |
| Qdrant upsert fails | Caught in `writeQdrantPoints` | `[errorType=... documentUlid=...]` via `logger.error` | 500 with same safe message |
| DynamoDB PutItem fails | Caught in `writeDynamoRecord` | `[errorType=... documentUlid=...]` via `logger.error` | 500 with `"Failed to record document metadata."` |

**Key rules:**
- Never include Voyage error bodies, API keys, Qdrant URLs, or DynamoDB table names in HTTP response bodies.
- Log with `[key=value]` format, extracting only `error.name` (not `error.message` or `error.stack`) for the `errorType` field in most cases. The exception is Qdrant's "already exists" check where the message is inspected internally but not logged or surfaced.
- Voyage errors propagate without re-wrapping because `VoyageService` already produces safe sanitized error messages and logs the status code. The NestJS global exception filter turns unhandled `Error` throws into 500s with a generic body.

---

## Named Constants

Define at the top of `knowledge-base-ingestion.service.ts`:

```typescript
const KB_COLLECTION_NAME = "knowledge_base";
const KB_DOCUMENT_ENTITY = "KB_DOCUMENT";
const KB_VECTOR_SIZE = 1024;
const KB_VECTOR_DISTANCE = "Cosine";
const KB_PK_PREFIX = "A#";
const KB_SK_PREFIX = "KB#DOC#";
```

---

## Step-by-Step Implementation Order

Steps are sequenced so each file depends only on files already completed.

```
1. [src/types/KnowledgeBase.ts]
   Append the four new interfaces: KnowledgeBaseSourceType, IngestDocumentInput,
   IngestDocumentResult, KnowledgeBaseDocumentRecord, KnowledgeBasePointPayload.
   Do not remove existing KnowledgeBaseChunk or KnowledgeBaseChunkOptions exports.
   Done when: TypeScript compiles without errors on this file alone.

2. [src/validation/knowledge-base.schema.ts]
   Create file. Define ingestDocumentSchema with the six fields. Export the schema
   and the IngestDocumentBody type. Mirror the structure of web-chat.schema.ts exactly.
   Done when: Schema correctly rejects missing required fields and invalid sourceType
   values when tested manually via the ZodValidationPipe.

3. [src/pipes/knowledgeBaseValidation.pipe.ts]
   Create file. Re-export ZodValidationPipe from webChatValidation.pipe.ts.
   Done when: File compiles and imports cleanly.

4. [src/services/knowledge-base-ingestion.service.ts]
   Create file. Implement the full service:
   - Named constants at top.
   - Constructor with four injected dependencies.
   - Public ingestDocument() method following the control flow above.
   - Three private helper methods.
   - Bracketed [key=value] log lines at every major step.
   Done when: File compiles without errors. No runtime test yet.

5. [src/controllers/knowledge-base.controller.ts]
   Create file. Implement the thin controller with one @Post("documents") handler.
   Import from the KB pipe file and the KB validation schema.
   Done when: File compiles.

6. [src/app.module.ts]
   Modify: Add KnowledgeBaseController to the controllers array.
   Add KnowledgeBaseIngestionService to the providers array.
   Add the necessary imports at the top.
   Done when: npm run build produces zero errors.

7. [src/services/knowledge-base-ingestion.service.spec.ts]
   Create file. Service unit tests (see Testing Strategy below).
   Done when: npm test passes for this spec file.

8. [src/controllers/knowledge-base.controller.spec.ts]
   Create file. Controller unit tests (see Testing Strategy below).
   Done when: npm test passes for this spec file and the full suite is green.
```

---

## Risks and Edge Cases

### High

**Empty/whitespace-only text passing zod but producing 0 chunks**
Risk: zod validates `text: z.string().min(1)`, which allows a single-space string. `chunkText` returns `[]` for whitespace-only input. Without the explicit chunk-count guard, the service would call Voyage with an empty array (which returns `[]` without error), then attempt to upsert 0 points, then write a DDB record with `chunk_count: 0`.
Mitigation: The guard at step 5 (`if (chunks.length === 0) throw new BadRequestException(...)`) is mandatory.

**Per-account invariant violated if `accountUlid` is missing from a write**
Risk: Any code path that builds a DynamoDB record or Qdrant point payload without forwarding `input.accountUlid` breaks the per-account isolation invariant that Phase 5 retrieval depends on.
Mitigation: The code reviewer spec explicitly checks this. The `satisfies KnowledgeBaseDocumentRecord` and `satisfies KnowledgeBasePointPayload` type assertions on the constructed objects enforce it at compile time.

**Qdrant point vector length mismatch**
Risk: If `VoyageService` is configured with a model other than `voyage-3-large`, the output dimension may not match the collection's 1024-size. Upsert will fail with a dimension mismatch error from Qdrant.
Mitigation: The Qdrant error will surface as a caught exception → 500. In the log line for this failure, include `[errorType=...]`. This is an environment/config issue, not a code bug. No code mitigation is required for Phase 4; document it in the service's module-level comment.

### Medium

**Very large input (thousands of chunks)**
Risk: A document with tens of thousands of characters will produce hundreds of chunks. Voyage's `embedTexts` batches at 1000 and loops, so this is handled. The Qdrant upsert of a large point array is a single HTTP request; very large payloads could exceed timeout. The Qdrant client default timeout is 300 seconds.
Mitigation: No chunk count limit is enforced in Phase 4 (out of scope). Document that Phase 7 or 8 should add a max-chunk guard.

**Qdrant upsert partial write**
Risk: If the upsert fails mid-write (e.g., timeout on a very large batch), some points may be written and others not. Qdrant's upsert with `wait: true` is an all-or-nothing request from the client's perspective — if the server returns an error, the client sees a failure. However, if the client times out but the server succeeds, points may exist without a corresponding DynamoDB record.
Mitigation: The brief explicitly accepts this. Rollback is Phase 8. Log the documentUlid in the failure so the orphan can be cleaned up manually.

**DynamoDB write after successful Qdrant upsert**
Risk: If `writeDynamoRecord` fails after `writeQdrantPoints` succeeds, vectors exist in Qdrant with no DynamoDB record. The document is invisible to any listing/retrieval built in Phase 5.
Mitigation: Same as above — no rollback in Phase 4. The documentUlid is logged with the error for manual recovery.

**`collectionExists` race on first-ever ingestion**
Risk: Two concurrent first-ever requests both see `exists: false`, both call `createCollection`, and one receives an "already exists" error.
Mitigation: The catch block in `ensureCollection` checks for "already exists" in the error message and swallows it. This race is a one-time event per deployment lifetime.

### Low

**Voyage timeout mid-embed on large batches**
Risk: For documents with >1000 chunks (over Voyage's single-call batch size), the second Voyage API call may timeout even though the first succeeded.
Mitigation: `VoyageService.embedTexts` will throw on failure. The service catches this (or lets it propagate) and returns a 500. No partial vectors are written because the upsert hasn't happened yet. Safe failure.

**`accountUlid` format ambiguity**
Risk: The brief says `accountUlid: string (required, ULID format, matches existing convention)`. The web-chat convention uses `A#`-prefixed form from the widget. Internal callers in the existing codebase work with the raw ULID. The schema in this plan validates the raw form. If the control-panel sends the `A#`-prefixed form, every DynamoDB write will produce `pk: "A#A#..."` which is wrong.
Mitigation: Flagged in the schema design note above. Orchestrator must confirm the expected format with the user before Step 2.

---

## Testing Strategy

### `src/services/knowledge-base-ingestion.service.spec.ts`

**Dependencies to mock:**
- `QdrantClient` — mock the injected client via `{ provide: QDRANT_CLIENT, useValue: mockQdrantClient }`
- `VoyageService` — mock via `{ provide: VoyageService, useValue: mockVoyageService }`
- `DynamoDBDocumentClient` — use `mockClient(DynamoDBDocumentClient)` from `aws-sdk-client-mock` (same pattern as `chat-session.service.spec.ts`)
- `DatabaseConfigService` — mock with `{ conversationsTable: "test-table" }`
- `chunkText` — use the real implementation (pure function, well-tested separately, no side effects) OR mock via `jest.mock("../utils/chunker/chunker", () => ({ chunkText: jest.fn() }))` to control outputs precisely
- `ulid` — mock via `jest.mock("ulid", () => ({ ulid: jest.fn(() => "01TESTULID000000000000000A") }))` for deterministic ULIDs
- `randomUUID` — mock via `jest.mock("crypto", () => ({ randomUUID: jest.fn(() => "test-uuid-0000-0000-0000-000000000001") }))` for deterministic point IDs

**Test cases:**

| Test | What it asserts |
|------|----------------|
| Happy path — 3 chunks in, 3 points out | `collectionExists` returns `true`; `embedTexts` returns 3 vectors; `upsert` called with 3 points with correct payload fields (including `account_ulid`, `chunk_index`, `chunk_text`); `PutCommand` called with correct DDB record; returns `{ documentUlid, chunkCount: 3, status: "ready", createdAt }` |
| Empty/whitespace text rejection | `chunkText` returns `[]`; throws `BadRequestException` with descriptive message; `embedTexts` not called; `upsert` not called; `PutCommand` not called |
| Collection missing — creates it | `collectionExists` returns `{ exists: false }`; `createCollection` called with `{ vectors: { size: 1024, distance: "Cosine" } }`; upsert proceeds |
| Collection exists — skips creation | `collectionExists` returns `{ exists: true }`; `createCollection` not called |
| Collection create race (already exists error) | `collectionExists` returns `{ exists: false }`; `createCollection` throws error with "already exists" in message; `ensureCollection` resolves without error; upsert proceeds |
| Voyage failure propagation | `embedTexts` throws `Error("Voyage API rate limit exceeded")`; service re-throws; `upsert` not called; `PutCommand` not called |
| Qdrant upsert failure | `upsert` throws; service catches, logs, throws `InternalServerErrorException` with safe message; `PutCommand` not called |
| DynamoDB PutItem failure | `upsert` succeeds; `PutCommand` throws; service catches, logs, throws `InternalServerErrorException` with safe message |
| `account_ulid` appears in DDB record and all point payloads | Assert on the `Item` arg of `PutCommand` and each point's `payload` field |
| `chunk_index` on each point matches chunker-assigned index | Assert points[0].payload.chunk_index === 0, points[1].payload.chunk_index === 1, etc. |
| `chunkCount` in response matches actual points written | Assert `result.chunkCount === chunks.length` |

### `src/controllers/knowledge-base.controller.spec.ts`

**Dependencies to mock:**
- `KnowledgeBaseIngestionService` — mock via `{ provide: KnowledgeBaseIngestionService, useValue: mockIngestionService }`

**Test cases:**

| Test | What it asserts |
|------|----------------|
| Happy path — valid body | `ingestionService.ingestDocument` called with the validated body; result returned as-is |
| Pipe rejects missing `accountUlid` | `ZodValidationPipe(ingestDocumentSchema)` throws `BadRequestException` |
| Pipe rejects missing `externalId` | Same |
| Pipe rejects missing `text` | Same |
| Pipe rejects invalid `sourceType` | Pipe throws `BadRequestException` for `sourceType: "jpg"` |
| Pipe rejects empty `text` | Pipe throws `BadRequestException` for `text: ""` |
| Service throws `BadRequestException` (0 chunks) | Controller re-throws; response is 400 |
| Service throws `InternalServerErrorException` | Controller re-throws; response is 500 |
| Response shape matches `IngestDocumentResult` | Assert all four fields present in the response |

**Note on NestJS POST default status:** In the controller spec, verify the handler returns 201 — if using `@nestjs/testing` + `supertest`, make a full HTTP call to confirm the status code rather than just calling the method directly. Alternatively, check if `@HttpCode(201)` is needed and add it if NestJS 11 defaults POST to 200.

---

## Out-of-Scope Confirmations

The following are explicitly NOT part of Phase 4:

- Async queue (Redis, Bull) — Phase 7
- Claude enrichment per chunk — Phase 7
- Retrieval tool for agents — Phase 5
- Delete, update, or list endpoints — future
- Idempotency via deterministic point IDs or delete-before-write — Phase 8
- Retry logic on transient Voyage/Qdrant/DynamoDB failures — Phase 8
- Sentry / Slack alerting — Phase 8
- Auth middleware on the new endpoint — Phase 8
- Payload indexes in Qdrant for `account_ulid` — the retrieval tool (Phase 5) will add the index; Phase 4 only creates the collection with the default configuration
- Any modification to existing agents, tools, or chat services

---

## Implementation Recommendations

1. **Import order:** Mirror the import order seen in `chat-session.service.ts`: NestJS imports first, AWS SDK imports second, internal provider/service imports third, type imports last.

2. **Logger initialization:** `private readonly logger = new Logger(KnowledgeBaseIngestionService.name);` — same pattern as every other service.

3. **`satisfies` over type assertions:** Use `satisfies KnowledgeBaseDocumentRecord` and `satisfies KnowledgeBasePointPayload` when constructing objects to get compile-time shape enforcement while retaining the inferred type.

4. **NestJS POST status code:** NestJS 11's `@Post` decorator on an async controller method returns 201 by default — this is correct. Do not add `@HttpCode(201)` unless testing reveals the default is 200.

5. **Do not catch Voyage errors in the service.** `VoyageService.embedTexts` already produces sanitized error messages and logs the status code. Catching and re-wrapping them would lose the specific error message that was already made safe. Let them propagate to NestJS's global exception filter, which will return a generic 500 body.

6. **`mime_type` in DynamoDB:** If `input.mimeType` is `undefined`, do not include the key in the DynamoDB `Item` at all — DynamoDB ignores `undefined` values in the document client, but it is cleaner to use a conditional spread: `...(input.mimeType ? { mime_type: input.mimeType } : {})`.

7. **Timing:** Capture `const startedAt = Date.now()` before any async work begins. Log `durationMs = Date.now() - startedAt` in the completion log line. Do not log partial timings per step — one completion log is sufficient for Phase 4.

8. **`createdAt` vs `_createdAt_`:** The existing DynamoDB records use `_createdAt_` (with underscores) for internal framework timestamps. The `KB_DOCUMENT` record uses `created_at` (with underscore, no outer underscores) as specified in the brief. Do not use `_createdAt_` for the KB record.
