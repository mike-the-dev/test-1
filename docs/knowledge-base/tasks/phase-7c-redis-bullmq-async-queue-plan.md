# Phase 7c — Implementation Plan: Redis + BullMQ Async Ingestion Queue

## Overview

Phase 7c refactors `POST /knowledge-base/documents` from a synchronous, blocking call (up to several minutes for large documents) into a fast async handoff. The controller writes a `pending` DynamoDB record, enqueues a BullMQ job backed by Redis, and returns `202 Accepted` within ~100ms. A background worker processor picks up the job, runs the existing Phase 7b pipeline unchanged (chunk → enrich → embed → Qdrant → DDB), and updates the DDB record's `status` field through `pending → processing → ready` (or `failed`). A new `GET /knowledge-base/documents` endpoint lets the upstream control-panel poll the status. DELETE remains synchronous. The change wraps rather than modifies the existing pipeline logic; `KnowledgeBaseIngestionService.ingestDocument` is called by the worker exactly as it was called by the controller before.

---

## BullMQ + NestJS Verification Findings

**Confirmed versions (npm registry, 2026-04-21):**
- `@nestjs/bullmq`: `11.0.4`
- `bullmq`: `5.76.2`

Install with: `npm install @nestjs/bullmq@11.0.4 bullmq@5.76.2`

**Module registration (confirmed via NestJS docs + GitHub source):**

```typescript
// forRoot — global Redis connection
BullModule.forRoot({
  connection: { host: 'localhost', port: 6379 },
})

// registerQueue — per-queue registration
BullModule.registerQueue({ name: 'knowledge-base-ingestion' })
```

**Processor class pattern (confirmed via search results + GitHub source):**
```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('knowledge-base-ingestion')
export class KnowledgeBaseIngestionProcessor extends WorkerHost {
  async process(job: Job<KnowledgeBaseJobPayload>): Promise<void> {
    // job handling logic
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) { ... }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) { ... }
}
```

Key points:
- `WorkerHost` is the base class (replaces the old Bull `Process`-decorated methods).
- `process(job)` is the abstract method you override — it is called for every job.
- `@OnWorkerEvent(eventName)` accepts any key from BullMQ's `WorkerListener` interface: `'active'`, `'completed'`, `'failed'`, `'error'`, `'drained'`, `'progress'`, etc.
- `@Processor` accepts a queue name string or a `ProcessorOptions` object.

**Queue injection (confirmed via GitHub source):**
```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('knowledge-base-ingestion') private readonly queue: Queue) {}
```

**Job add with retry options:**
```typescript
await queue.add('ingest', payload, {
  attempts: 4,             // 1 initial + 3 retries
  backoff: {
    type: 'exponential',
    delay: 1000,           // base delay in ms
  },
});
```

**CRITICAL — Retry delay discrepancy vs. the brief:**

The brief specifies delays of "1s, 5s, 25s" (suggesting a ×5 multiplier). BullMQ's confirmed exponential backoff formula is `Math.pow(2, attemptsMade - 1) * delay` (base-2 doubling), which with `delay=1000` produces:

| Retry | attemptsMade | Formula | Delay |
|-------|-------------|---------|-------|
| 1st   | 1           | 2^0 × 1000 | 1,000 ms |
| 2nd   | 2           | 2^1 × 1000 | 2,000 ms |
| 3rd   | 3           | 2^2 × 1000 | 4,000 ms |

So the actual delays are **1s, 2s, 4s** — not 1s, 5s, 25s. BullMQ does not support a ×5 multiplier via its built-in exponential type. To hit 1s/5s/25s exactly would require a custom backoff strategy (a function registered with BullMQ's `defineBackoffStrategy` mechanism). This is a deviation from the brief that must be flagged to the user before implementation.

**Recommended resolution (flagged — see Risk section):** Use `delay: 1000, type: 'exponential'` and accept the 1s/2s/4s progression. This is functionally equivalent for the transient-failure recovery use case. Alternatively, use `delay: 5000` to get 5s/10s/20s. Do NOT implement a custom backoff strategy without user approval.

**Sources:**
- https://docs.bullmq.io/guide/nestjs
- https://github.com/nestjs/bull/tree/master/packages/bullmq
- https://docs.bullmq.io/guide/retrying-failing-jobs
- https://github.com/taskforcesh/bullmq/blob/master/src/classes/backoffs.ts

---

## Redis Docker-Compose Entry

**Pinned image tag:** `redis:7.4.8-alpine3.21` (confirmed latest stable 7.x alpine via Docker Hub, 2026-04-21)

Add to `docker-compose.yml`:

```yaml
  redis:
    image: redis:7.4.8-alpine3.21
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
```

Add to the `volumes:` section:

```yaml
  redis_data:
```

`--appendonly yes` enables AOF persistence so job state in Redis survives a container restart during local development.

---

## Affected Files and Modules

### Create
- `src/processors/knowledge-base-ingestion.processor.ts` — BullMQ worker processor class; calls existing `ingestDocument` and manages DDB status transitions.
- `src/processors/knowledge-base-ingestion.processor.spec.ts` — Unit tests for the processor.
- `src/services/knowledge-base-config.service.ts` — Redis config accessor following the Qdrant pattern.
- `src/controllers/knowledge-base.controller.spec.ts` — Controller unit tests (new file; no tests currently exist for this controller).

### Modify
- `src/types/KnowledgeBase.ts` — Add `KnowledgeBaseStatus` union type, expand `KnowledgeBaseDocumentRecord`, add `KnowledgeBaseJobPayload`, `KnowledgeBaseIngestAcceptedResult`, `KnowledgeBaseGetDocumentResult` types, add `error_summary` field.
- `src/validation/knowledge-base.schema.ts` — Add `getDocumentSchema` for GET query param validation; add exported `GetDocumentQuery` type.
- `src/controllers/knowledge-base.controller.ts` — Reshape POST handler (202, enqueue), add GET handler, inject `Queue`.
- `src/services/knowledge-base-ingestion.service.ts` — Extract `writePendingRecord` and `updateDocumentStatus` as new public methods; `lookupExistingDocument` must become public (or `protected`) so the controller can call it for the POST pre-check.
- `src/config/configuration.ts` — Add `redis.host` and `redis.port` keys.
- `src/config/env.schema.ts` — Add `REDIS_HOST` and `REDIS_PORT` env var entries.
- `src/app.module.ts` — Import `BullModule.forRoot(...)`, `BullModule.registerQueue(...)`, register `KnowledgeBaseIngestionProcessor` as a provider, import `KnowledgeBaseConfigService` and inject into `BullModule.forRootAsync`.
- `docker-compose.yml` — Add Redis service block and volume.
- `docs/knowledge-base/data-flows.md` — Replace Flow 1 and Flow 3 diagrams with async versions.
- `.env.local` — Add `REDIS_HOST=localhost` and `REDIS_PORT=6379`.

### Review Only (no changes)
- `src/services/knowledge-base-ingestion.service.spec.ts` — Existing tests still pass; verify `ingestDocument` call signature is unchanged.
- `src/providers/qdrant.provider.ts` — Pattern reference for startup smoke-check; Redis connection is managed by BullMQ/`@nestjs/bullmq` internally, so a separate provider is not needed.

---

## Type Changes

### `src/types/KnowledgeBase.ts`

Add/replace:

```typescript
// Status state machine (Phase 7c)
export type KnowledgeBaseStatus = "pending" | "processing" | "ready" | "failed";

// Job payload enqueued by the POST controller for the BullMQ worker.
export interface KnowledgeBaseJobPayload {
  accountId: string;        // raw ULID, A# already stripped
  externalId: string;
  title: string;
  text: string;
  sourceType: KnowledgeBaseSourceType;
  mimeType?: string;
  documentId: string;       // pre-generated or reused at POST time
  createdAt: string;        // ISO-8601; preserved from existing record on update path
}

// 202 Accepted response from POST (replaces the former 201 KnowledgeBaseIngestDocumentResult)
export interface KnowledgeBaseIngestAcceptedResult {
  document_id: string;
  status: "pending";
  _createdAt_: string;
}

// 200 response from GET /knowledge-base/documents
export interface KnowledgeBaseGetDocumentResult {
  document_id: string;
  account_id: string;
  external_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  mime_type?: string;
  chunk_count?: number;    // absent when status is "pending" or "processing"
  status: KnowledgeBaseStatus;
  _createdAt_: string;
  _lastUpdated_: string;
  error_summary?: string;  // only present when status === "failed"
}
```

Update `KnowledgeBaseDocumentRecord`:
- Change `status: "ready"` to `status: KnowledgeBaseStatus`
- Change `chunk_count: number` to `chunk_count?: number` (absent on pending record)
- Add `error_summary?: string`
- Remove `_lastUpdated_` requirement from pending records (it will be set at processing completion)

Keep `KnowledgeBaseIngestDocumentResult` for now (the service still returns it; the worker uses it internally). The controller's POST return type changes to `KnowledgeBaseIngestAcceptedResult`.

---

## Validation Changes

### `src/validation/knowledge-base.schema.ts`

Add:

```typescript
export const getDocumentSchema = z.object({
  account_id: z
    .string()
    .regex(accountIdRegex, "account_id must be an A#-prefixed 26-character ULID"),
  external_id: z.string().min(1, "external_id must not be empty"),
});

export type GetDocumentQuery = z.infer<typeof getDocumentSchema>;
```

The same `ZodValidationPipe` pattern used for body validation will be applied to query params using `@Query(new ZodValidationPipe(getDocumentSchema))`.

---

## Configuration Changes

### `src/config/configuration.ts`

Add under the returned object:

```typescript
redis: {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
},
```

### `src/config/env.schema.ts`

Add to `envSchema`:

```typescript
REDIS_HOST: z.string().default('localhost'),
REDIS_PORT: z.coerce.number().default(6379),
```

### New `src/services/knowledge-base-config.service.ts`

Follow the `QdrantConfigService` pattern exactly:

```typescript
@Injectable()
export class KnowledgeBaseConfigService {
  constructor(private readonly configService: ConfigService) {}

  get redisHost(): string {
    return this.configService.get<string>('redis.host', { infer: true }) ?? 'localhost';
  }

  get redisPort(): number {
    return this.configService.get<number>('redis.port', { infer: true }) ?? 6379;
  }
}
```

### `src/app.module.ts`

Change the `imports` array:

```typescript
imports: [
  ConfigModule.forRoot({ ... }),
  DiscoveryModule,
  BullModule.forRootAsync({
    inject: [KnowledgeBaseConfigService],
    useFactory: (config: KnowledgeBaseConfigService) => ({
      connection: {
        host: config.redisHost,
        port: config.redisPort,
      },
    }),
  }),
  BullModule.registerQueue({
    name: 'knowledge-base-ingestion',
  }),
],
```

Add to `providers`: `KnowledgeBaseConfigService`, `KnowledgeBaseIngestionProcessor`.

Note: `BullModule.forRootAsync` requires `KnowledgeBaseConfigService` to be available. Since `ConfigModule` is `isGlobal: true`, `ConfigService` (which `KnowledgeBaseConfigService` depends on) is available globally. `KnowledgeBaseConfigService` must be listed in the module's `providers` array before `BullModule.forRootAsync` resolves.

---

## POST Controller Refactor

### New handler flow (step by step)

**Location:** `src/controllers/knowledge-base.controller.ts`

```
1. Zod validation pipe runs on the request body (unchanged from today).
2. Strip "A#" prefix from account_id (rawAccountId = body.account_id.slice(2)).
3. Call ingestionService.lookupExistingDocument(rawAccountId, body.external_id).
   - Returns { documentId, createdAt } if found; null if not found.
   - Throws InternalServerErrorException on DDB error → propagates as 500.
4. Generate or reuse documentId:
   - isUpdate = existing !== null
   - documentId = isUpdate ? existing.documentId : ulid()
   - createdAt = isUpdate ? existing.createdAt : new Date().toISOString()
5. Write DDB "pending" record via ingestionService.writePendingRecord(documentId, rawAccountId, body, createdAt).
   - Uses PutCommand (overwrite-safe: same PK+SK as any existing record).
   - Sets status: "pending", chunk_count is omitted, _lastUpdated_ = createdAt (same as _createdAt_ on create; reset on update).
   - Throws InternalServerErrorException on DDB error → propagates as 500.
6. Enqueue BullMQ job:
   await queue.add('ingest', payload, { attempts: 4, backoff: { type: 'exponential', delay: 1000 } });
   - payload is KnowledgeBaseJobPayload (includes documentId so worker doesn't re-generate it).
   - If queue.add() throws (Redis unavailable): catch the error, log [level=error], throw ServiceUnavailableException("Ingestion queue is temporarily unavailable. Please retry.").
   - The DDB "pending" record is left in place (orphan decision — see below).
7. Return { document_id: documentId, status: "pending", _createdAt_: createdAt } with HTTP 202.
```

**On Redis failure at step 6 — orphan DDB record decision:**

The brief locks this decision: leave the orphaned `pending` record in place. Justification:
- Deletion is its own pipeline with its own failure modes; attempting it inside the POST error path adds complexity and a second possible failure point.
- A pending record that never transitions is harmless to data integrity: the upstream sees the 503, knows the enqueue failed, and can retry the POST. The retry will hit the `lookupExistingDocument` path (update branch), reuse the same `documentId`, overwrite the pending record with a new pending record, and attempt to enqueue again.
- Phase 8 can add a "stuck pending" detector if cleanup becomes a problem at scale.

**HTTP status codes:**
- `202 Accepted` on success.
- `400 Bad Request` on validation failure (from Zod pipe — unchanged behavior).
- `500 Internal Server Error` if DDB lookup or pending-record write fails.
- `503 Service Unavailable` if Redis enqueue fails.

---

## GET Controller Handler

**Decorator:** `@Get('documents')` with `@HttpCode(200)` (default, explicit for clarity).

**Flow:**
```
1. @Query(new ZodValidationPipe(getDocumentSchema)) query: GetDocumentQuery
   - Zod validates account_id (A# format) and external_id (non-empty).
   - Invalid/missing params → 400.
2. rawAccountId = query.account_id.slice(2)
3. Call ingestionService.lookupExistingDocument(rawAccountId, query.external_id).
   - Returns { documentId, createdAt } or null.
   - Throws InternalServerErrorException on DDB error.
4. If null → throw NotFoundException("Document not found.") → 404.
5. Fetch the full DDB record by PK + SK to return all fields.
   - New private method on ingestionService: getDocumentRecord(accountId, documentId).
   - Uses GetCommand (or reuse QueryCommand result from step 3 by returning the full Item).
6. Map to KnowledgeBaseGetDocumentResult and return.
```

**Note on lookup mechanism:** `lookupExistingDocument` currently returns only `{ documentId, createdAt }` — it does not return the full record. Two options:
- **Option A (preferred):** Extract the full `Item` from the QueryCommand result in `lookupExistingDocument` and return it (or a superset). This avoids a second DDB round-trip.
- **Option B:** Add a `getDocumentRecord(accountId, documentId)` method that does a `GetCommand` by PK+SK after the lookup.

The plan recommends Option A: change `lookupExistingDocument`'s return type to include the full `KnowledgeBaseDocumentRecord | null`, so the controller can use it directly for the GET response without an extra DDB call. The POST controller only needs `{ documentId, createdAt }` from it, which remains available as fields on the full record.

**Response shape on 200:**
```json
{
  "document_id": "01K...",
  "account_id": "01K...",
  "external_id": "...",
  "title": "...",
  "source_type": "pdf",
  "mime_type": "application/pdf",
  "chunk_count": 15,
  "status": "ready",
  "_createdAt_": "...",
  "_lastUpdated_": "...",
  "error_summary": "..."
}
```
Fields `mime_type`, `chunk_count`, and `error_summary` are omitted when absent.

---

## Worker / Processor Design

**File:** `src/processors/knowledge-base-ingestion.processor.ts`

**Class shape:**
```typescript
const KB_INGESTION_QUEUE = 'knowledge-base-ingestion';
const KB_INGEST_JOB = 'ingest';
const KB_RETRY_ATTEMPTS = 4;
const KB_BACKOFF_DELAY_MS = 1000;

@Processor(KB_INGESTION_QUEUE)
export class KnowledgeBaseIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(KnowledgeBaseIngestionProcessor.name);

  constructor(
    private readonly ingestionService: KnowledgeBaseIngestionService,
  ) {
    super();
  }

  async process(job: Job<KnowledgeBaseJobPayload>): Promise<void> {
    const { documentId, accountId, externalId } = job.data;

    this.logger.log(
      `[documentId=${documentId} accountId=${accountId} externalId=${externalId} attempt=${job.attemptsMade + 1}] Processing job`,
    );

    // Step 1: Transition status to "processing"
    await this.ingestionService.updateDocumentStatus(accountId, documentId, 'processing');

    try {
      // Step 2: Run the full pipeline (unchanged from the current service method)
      await this.ingestionService.ingestDocument({
        accountId: job.data.accountId,
        externalId: job.data.externalId,
        title: job.data.title,
        text: job.data.text,
        sourceType: job.data.sourceType,
        mimeType: job.data.mimeType,
      });

      // ingestDocument already writes the DDB record with status: "ready" via its
      // existing writeDynamoRecord method. No additional update needed here.

      this.logger.log(
        `[documentId=${documentId} accountId=${accountId} status=ready] Job completed`,
      );
    } catch (error) {
      const isValidationFailure = error instanceof BadRequestException;
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `[documentId=${documentId} accountId=${accountId} errorType=${errorName} attempt=${job.attemptsMade + 1}] Job failed`,
      );

      if (isValidationFailure || job.attemptsMade + 1 >= KB_RETRY_ATTEMPTS) {
        // Final failure — write error_summary to DDB
        const safeMessage = isValidationFailure
          ? errorMessage
          : 'Processing failed after multiple retries. Please re-submit the document.';

        await this.ingestionService.updateDocumentStatus(accountId, documentId, 'failed', safeMessage);
      }

      if (isValidationFailure) {
        // Do NOT re-throw for BadRequestException — mark job as failed immediately
        // without letting BullMQ retry. Return normally after writing "failed" status.
        return;
      }

      // Re-throw to let BullMQ apply the retry/backoff policy
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `[documentId=${job.data.documentId} jobId=${job.id} errorType=${error.name}] Job exhausted retries`,
    );
  }
}
```

**IMPORTANT — ingestDocument and writeDynamoRecord interaction:**

Currently, `ingestDocument` ends by calling `writeDynamoRecord`, which does a `PutCommand` that **overwrites the entire DDB record** and sets `status: "ready"`. This is fine — it preserves the fields we care about because the job payload carries all the necessary data. The `writePendingRecord` call at POST time writes PK+SK+all metadata; `ingestDocument`'s final `PutCommand` replaces it with the complete ready record. No data is lost.

However, the intermediate `pending → processing` transition should use `UpdateCommand` to avoid overwriting the full record mid-pipeline. See the Status Update Mechanism section below.

---

## Status Update Mechanism

**New public method on `KnowledgeBaseIngestionService`:** `updateDocumentStatus`

```typescript
async updateDocumentStatus(
  accountId: string,
  documentId: string,
  status: KnowledgeBaseStatus,
  errorSummary?: string,
): Promise<void>
```

Uses `UpdateCommand` (not `PutCommand`) to update only `status`, `_lastUpdated_`, and optionally `error_summary` — leaving all other fields (external_id, title, chunk_count, mime_type, etc.) untouched.

**Transition: pending → processing**

```typescript
UpdateCommand({
  TableName: table,
  Key: { PK: `A#${accountId}`, SK: `KB#DOC#${documentId}` },
  UpdateExpression: 'SET #status = :status, #lastUpdated = :now',
  ExpressionAttributeNames: {
    '#status': 'status',
    '#lastUpdated': '_lastUpdated_',
  },
  ExpressionAttributeValues: {
    ':status': 'processing',
    ':now': new Date().toISOString(),
  },
})
```

**Transition: processing → failed**

```typescript
UpdateCommand({
  TableName: table,
  Key: { PK: `A#${accountId}`, SK: `KB#DOC#${documentId}` },
  UpdateExpression: 'SET #status = :status, #lastUpdated = :now, error_summary = :errorSummary',
  ExpressionAttributeNames: {
    '#status': 'status',
    '#lastUpdated': '_lastUpdated_',
  },
  ExpressionAttributeValues: {
    ':status': 'failed',
    ':now': new Date().toISOString(),
    ':errorSummary': safeErrorSummary,   // sanitized string, never raw Error object
  },
})
```

**Transition: processing → ready**

This transition is handled implicitly by the existing `writeDynamoRecord` PutCommand inside `ingestDocument`. It writes the full record with `status: "ready"`, `chunk_count`, `_lastUpdated_`, etc. No additional UpdateCommand needed.

**New public method on `KnowledgeBaseIngestionService`:** `writePendingRecord`

```typescript
async writePendingRecord(
  documentId: string,
  accountId: string,
  input: IngestDocumentBody,   // or a shaped subset
  createdAt: string,
): Promise<void>
```

```typescript
PutCommand({
  TableName: table,
  Item: {
    PK: `A#${accountId}`,
    SK: `KB#DOC#${documentId}`,
    entity: 'KNOWLEDGE_BASE_DOCUMENT',
    document_id: documentId,
    account_id: accountId,
    external_id: input.external_id,
    title: input.title,
    source_type: input.source_type,
    ...(input.mime_type ? { mime_type: input.mime_type } : {}),
    status: 'pending',
    _createdAt_: createdAt,
    _lastUpdated_: createdAt,
    // chunk_count intentionally omitted — unknown until processing completes
  },
})
```

---

## Retry Configuration

**BullMQ job options passed at `queue.add()` call time:**

```typescript
{
  attempts: 4,               // 1 initial + 3 retries
  backoff: {
    type: 'exponential',
    delay: 1000,             // base delay in ms
  },
}
```

**Actual retry delays (confirmed from BullMQ source):**
- Retry 1 after: 1,000 ms (2^0 × 1000)
- Retry 2 after: 2,000 ms (2^1 × 1000)
- Retry 3 after: 4,000 ms (2^2 × 1000)

This deviates from the brief's stated 1s/5s/25s. The brief's numbers imply a ×5 multiplier, which is not a built-in BullMQ backoff type. This deviation must be flagged to the user; the plan proceeds with BullMQ's native exponential. See Risk section.

**Non-retryable errors:** `BadRequestException` is caught in the processor and handled without re-throwing. BullMQ never sees it; the job is effectively marked as done (completed, not failed from BullMQ's perspective) but the DDB record is written with `status: "failed"`. This is acceptable: the validation failure is deterministic and cannot be recovered by retrying.

Alternative approach: throw an `UnrecoverableError` (exported from `bullmq`) which tells BullMQ to move the job to failed immediately without retrying. This is cleaner because BullMQ tracks it as a failed job (visible in job history) rather than a completed one. **Recommended approach:** use `UnrecoverableError` from `bullmq` for validation failures so job history accurately reflects the failure.

```typescript
import { UnrecoverableError } from 'bullmq';

if (isValidationFailure) {
  await this.ingestionService.updateDocumentStatus(accountId, documentId, 'failed', errorMessage);
  throw new UnrecoverableError(errorMessage);  // BullMQ moves to failed without retry
}
```

---

## Error Handling

| Error source | Exception type | Retried? | DDB status written | Action |
|---|---|---|---|---|
| Voyage API failure | `InternalServerErrorException` | Yes (up to 3 retries) | None until final failure | Re-throw; BullMQ retries |
| Qdrant failure | `InternalServerErrorException` | Yes | None until final failure | Re-throw |
| DDB failure (mid-pipeline) | `InternalServerErrorException` | Yes | None | Re-throw |
| Empty text → 0 chunks | `BadRequestException` | No | `failed` + error_summary | `UnrecoverableError` |
| All retries exhausted | any error | — | `failed` + generic error_summary | Final catch writes status |
| `updateDocumentStatus` itself fails | any | Processor re-throws | Not written | Log + re-throw (BullMQ retries the whole job) |

**Error summary sanitization rules:**
- For `BadRequestException`: use `error.message` directly (it is generated by our code, not by external APIs).
- For all other failures: use a generic message: `"Processing failed after multiple retries. Please re-submit the document."`
- Never include: raw error objects, stack traces, API keys, external API error bodies, Qdrant/Voyage endpoint URLs.

---

## Step-by-Step Implementation Sequence

### Step 1 — Install dependencies
`npm install @nestjs/bullmq@11.0.4 bullmq@5.76.2`

Done when: `package.json` and `package-lock.json` reflect the new packages with no install errors.

### Step 2 — Add Redis env vars and config
**Files:** `src/config/env.schema.ts`, `src/config/configuration.ts`, `.env.local`

Add `REDIS_HOST` and `REDIS_PORT` to `envSchema` with defaults. Add `redis.host` and `redis.port` to `configuration.ts`. Add `REDIS_HOST=localhost` and `REDIS_PORT=6379` to `.env.local`.

Done when: `npm run build` compiles clean.

### Step 3 — Create `KnowledgeBaseConfigService`
**File:** `src/services/knowledge-base-config.service.ts`

Pattern: identical to `QdrantConfigService`. Exposes `redisHost` and `redisPort` getters via `ConfigService`.

Done when: file compiles and exports `KnowledgeBaseConfigService`.

### Step 4 — Update type definitions
**File:** `src/types/KnowledgeBase.ts`

Add `KnowledgeBaseStatus`, `KnowledgeBaseJobPayload`, `KnowledgeBaseIngestAcceptedResult`, `KnowledgeBaseGetDocumentResult`. Update `KnowledgeBaseDocumentRecord` (status union, chunk_count optional, error_summary optional). Keep `KnowledgeBaseIngestDocumentResult` as-is (service still returns it internally).

Done when: `npm run build` compiles clean; no TypeScript errors downstream.

### Step 5 — Update validation schema
**File:** `src/validation/knowledge-base.schema.ts`

Add `getDocumentSchema` and `GetDocumentQuery` type.

Done when: file compiles.

### Step 6 — Refactor `KnowledgeBaseIngestionService`
**File:** `src/services/knowledge-base-ingestion.service.ts`

Changes:
- Make `lookupExistingDocument` public and update return type to include the full record (Option A): `Promise<KnowledgeBaseDocumentRecord | null>`.
- Add public `writePendingRecord(documentId, accountId, input, createdAt)` method using PutCommand.
- Add public `updateDocumentStatus(accountId, documentId, status, errorSummary?)` method using UpdateCommand.
- Update `writeDynamoRecord` to accept `status: KnowledgeBaseStatus` parameter (it still defaults to `"ready"` from `ingestDocument`'s call).
- No changes to `ingestDocument`'s logic or call signature.

Done when: existing spec file passes (`npm test -- knowledge-base-ingestion.service.spec.ts`).

### Step 7 — Refactor controller POST handler, add GET handler
**File:** `src/controllers/knowledge-base.controller.ts`

- Inject `@InjectQueue('knowledge-base-ingestion') private readonly queue: Queue`.
- Reshape POST handler: `@HttpCode(202)`, call `lookupExistingDocument`, generate/reuse documentId, call `writePendingRecord`, enqueue job, catch Redis failure → `ServiceUnavailableException`, return `{ document_id, status: 'pending', _createdAt_ }`.
- Add GET handler: `@Get('documents') @HttpCode(200)`, query param validation via `ZodValidationPipe(getDocumentSchema)`, call `lookupExistingDocument`, 404 on null, map full record to `KnowledgeBaseGetDocumentResult`, return.
- Import `ulid` at top of controller (currently called only in service).

Done when: controller compiles; manual smoke-test returns 202 on POST.

### Step 8 — Implement processor
**File:** `src/processors/knowledge-base-ingestion.processor.ts`

Full class as described in Worker/Processor Design section. Imports: `Processor`, `WorkerHost`, `OnWorkerEvent` from `@nestjs/bullmq`; `Job`, `UnrecoverableError` from `bullmq`; `KnowledgeBaseIngestionService`.

Done when: file compiles.

### Step 9 — Update `AppModule`
**File:** `src/app.module.ts`

Add imports: `BullModule.forRootAsync(...)`, `BullModule.registerQueue({ name: 'knowledge-base-ingestion' })`.
Add providers: `KnowledgeBaseConfigService`, `KnowledgeBaseIngestionProcessor`.

Done when: `npm run build` clean, `npm run start:dev` boots without error.

### Step 10 — Add Redis to docker-compose
**File:** `docker-compose.yml`

Add the Redis service block and `redis_data` volume as shown above.

Done when: `docker compose up redis` starts and accepts connections on `localhost:6379`.

### Step 11 — Write tests
**Files:**
- `src/processors/knowledge-base-ingestion.processor.spec.ts` (new)
- `src/controllers/knowledge-base.controller.spec.ts` (new)
- `src/services/knowledge-base-ingestion.service.spec.ts` (update)

See Testing Strategy section.

Done when: `npm test` passes all new and existing tests.

### Step 12 — Update data-flows doc
**File:** `docs/knowledge-base/data-flows.md`

Replace Flow 1 and Flow 3 diagrams as specified below.

Done when: file updated and reviewed.

---

## Risks and Edge Cases

### HIGH — Retry delay mismatch
**Risk:** The brief specifies 1s/5s/25s retry delays. BullMQ's exponential formula produces 1s/2s/4s with `delay: 1000`. There is no built-in BullMQ backoff type that produces ×5 progression.

**Mitigation:** Flag to user before implementation. Options: (a) accept 1s/2s/4s, (b) use `delay: 5000` for 5s/10s/20s, (c) implement a custom backoff strategy (not recommended — adds complexity). This must be resolved before Step 7.

### HIGH — Worker crash mid-processing (stuck in "processing")
**Risk:** If the worker process crashes after writing `status: "processing"` (step 1 of the processor) but before `ingestDocument` completes (which would write `status: "ready"`), the DDB record remains `status: "processing"` indefinitely. BullMQ will re-attempt the job (it uses a lock mechanism — jobs not acknowledged within `lockDuration` are moved back to "waiting"), but the DDB record still shows "processing" during the retry. More critically, if the NestJS process itself dies, the active job's lock expires and BullMQ requeues it — but the DDB `status: "processing"` write at the start of `process()` will run again on the retry, which is idempotent (same status).

**Worst case:** Redis itself crashes. BullMQ cannot requeue. The job is lost; the DDB record stays `status: "processing"` forever.

**Proposed mitigation (deferred to Phase 8):** Add a `_processingStartedAt_` timestamp field written alongside `status: "processing"`. A Phase 8 scheduled task (or startup health check) can detect records stuck in `processing` for more than N minutes and either reset them to `pending` or mark them `failed`. This is explicitly deferred. Add this item to `docs/knowledge-base/phase-8-considerations.md`.

### HIGH — DDB write succeeds, Redis enqueue fails
**Risk:** `writePendingRecord` succeeds but `queue.add()` throws. The caller gets a 503 and the DDB record is orphaned as `status: "pending"` permanently.

**Mitigation:** Accepted by brief. The upstream can re-POST; the update path overwrites the pending record and attempts enqueue again. Documented as a known limitation.

### MEDIUM — Concurrent POSTs for the same (account_id, external_id)
**Risk:** Two near-simultaneous POSTs for the same document both pass `lookupExistingDocument` (both see the same existing record or both see no record), both enqueue jobs, both run the pipeline. Last-write-wins on DDB. Qdrant points may be briefly duplicated between the delete and upsert steps of the second job.

**Mitigation:** Deferred to Phase 8 per the brief. Document in `phase-8-considerations.md`. The existing Qdrant delete (`wait: true`) + upsert ordering makes this self-healing over time.

### MEDIUM — `updateDocumentStatus` fails in the processor
**Risk:** If the `processing` or `failed` status update DDB write itself fails, the processor throws and BullMQ retries the job. The retry starts the pipeline over from the beginning (re-chunks, re-embeds, re-upserts). This is safe because the pipeline is idempotent (update path deletes old Qdrant points before upserting new ones). Excess retries may waste Voyage/Anthropic API calls.

**Mitigation:** Accept. Log clearly. The existing 3-retry limit caps the cost.

### MEDIUM — `status: "processing"` visible to polling callers
**Risk:** The GET endpoint may return `status: "processing"` if the worker has picked up the job but not finished. The upstream must handle this state gracefully (it is not an error, just intermediate).

**Mitigation:** Documented in API contract. No code change needed.

### LOW — BullMQ marks `BadRequestException` jobs as "completed" (not "failed")
**Corrected by plan:** Using `UnrecoverableError` from `bullmq` instead of silent return ensures these jobs appear as "failed" in BullMQ's job history, preserving observability.

### LOW — `lookupExistingDocument` signature change
**Risk:** The return type changes from `{ documentId, createdAt } | null` to `KnowledgeBaseDocumentRecord | null`. The spec file has assertions that call `ingestDocument` which internally calls `lookupExistingDocument` — those tests mock the DynamoDB `QueryCommand` response, not the method directly, so they should be unaffected. But the call sites in `deleteDocument` (which calls `lookupExistingDocument` and uses only `existing.documentId`) must still compile.

**Mitigation:** `KnowledgeBaseDocumentRecord` includes `document_id` and `_createdAt_`, so `existing.document_id` and `existing._createdAt_` replace `existing.documentId` and `existing.createdAt`. All callers must be updated.

---

## Testing Strategy

### Existing tests — required assertion updates

**`src/services/knowledge-base-ingestion.service.spec.ts`**

The `lookupExistingDocument` mock responses (`Items: [{ document_id, _createdAt_ }]`) need to expand to include all fields of `KnowledgeBaseDocumentRecord` (or the mock DDB response can just add the minimum required fields). Tests that currently assert `result.status === "ready"` on `ingestDocument` remain correct — the service's `writeDynamoRecord` still sets `status: "ready"`.

Tests for the two new service methods need to be added to this file.

### New test cases

**`src/services/knowledge-base-ingestion.service.spec.ts`** (additions)

| Test case | Assert |
|---|---|
| `writePendingRecord` — create path | Calls PutCommand with status: "pending", no chunk_count, correct PK/SK |
| `writePendingRecord` — mime_type present | mime_type included in Item |
| `writePendingRecord` — mime_type absent | mime_type omitted |
| `writePendingRecord` — DDB failure | Throws InternalServerErrorException |
| `updateDocumentStatus("processing")` | Calls UpdateCommand with status=processing, _lastUpdated_ set, no error_summary |
| `updateDocumentStatus("failed", message)` | Calls UpdateCommand with status=failed, error_summary set |
| `updateDocumentStatus("ready")` | Calls UpdateCommand with status=ready |
| `updateDocumentStatus` — DDB failure | Throws InternalServerErrorException |
| `lookupExistingDocument` (now public) — returns full record | Returns complete KnowledgeBaseDocumentRecord |
| `lookupExistingDocument` — not found | Returns null |

**`src/processors/knowledge-base-ingestion.processor.spec.ts`** (new file)

BullMQ is fully mocked — no real Redis. The Queue is not involved in the processor tests.

| Test case | Assert |
|---|---|
| Happy path | Calls updateDocumentStatus("processing"), then ingestDocument, no updateDocumentStatus("failed") |
| `ingestDocument` success | Does NOT call updateDocumentStatus("failed") |
| `ingestDocument` throws `InternalServerErrorException` (transient) | Re-throws; updateDocumentStatus("failed") called only on final attempt |
| `ingestDocument` throws `BadRequestException` | Throws `UnrecoverableError`; updateDocumentStatus("failed") called with error.message |
| All retries exhausted (attemptsMade = 3, attempts = 4) | updateDocumentStatus("failed") called with generic message |
| `updateDocumentStatus("processing")` throws | Job throws (BullMQ retries); ingestDocument NOT called |
| `error_summary` is never a raw Error object | Assert typeof errorSummary === 'string' on all failure paths |
| `@OnWorkerEvent('failed')` | Logs error with documentId and jobId |

Mock strategy for processor tests:
```typescript
const mockIngestionService = {
  updateDocumentStatus: jest.fn(),
  ingestDocument: jest.fn(),
};

// Mock job object
const mockJob = {
  data: { documentId: 'doc-1', accountId: 'acct-1', externalId: 'ext-1', ... },
  attemptsMade: 0,
  id: 'job-1',
};
```

**`src/controllers/knowledge-base.controller.spec.ts`** (new file)

Mock strategy: `KnowledgeBaseIngestionService` and `Queue` are both fully mocked using jest. No DDB, no Redis.

| Test case | Endpoint | Assert |
|---|---|---|
| POST — happy path (new document) | POST /knowledge-base/documents | Returns 202, { document_id, status: "pending", _createdAt_ } |
| POST — update path (existing document) | POST | Returns 202, reuses existing document_id |
| POST — Redis enqueue failure | POST | Returns 503 |
| POST — DDB writePendingRecord failure | POST | Returns 500 |
| POST — invalid account_id (no A# prefix) | POST | Returns 400 |
| POST — missing required fields | POST | Returns 400 |
| GET — document found, status: ready | GET | Returns 200 with full record |
| GET — document found, status: pending | GET | Returns 200 with status: pending (no chunk_count) |
| GET — document found, status: failed | GET | Returns 200 with error_summary |
| GET — document not found | GET | Returns 404 |
| GET — invalid account_id | GET | Returns 400 |
| GET — missing external_id | GET | Returns 400 |
| DELETE — unchanged | DELETE | Still returns 204, still synchronous |

**Mock BullMQ in all unit tests:**

In test files that touch the controller or processor, mock `@nestjs/bullmq` at the module level:
```typescript
jest.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => {},
  BullModule: { forRoot: jest.fn(), registerQueue: jest.fn() },
  Processor: () => () => {},
  WorkerHost: class {},
  OnWorkerEvent: () => () => {},
}));
```

Or use `Test.createTestingModule` with a mocked Queue provider:
```typescript
{
  provide: getQueueToken('knowledge-base-ingestion'),
  useValue: { add: jest.fn() },
}
```
This is the cleaner approach — do not mock the entire `@nestjs/bullmq` module.

---

## Data-Flows Doc Updates

Replace the header note and Flow 1 and Flow 3 in `docs/knowledge-base/data-flows.md`:

**Update the "Current state" line:**
```
**Current state**: Phases 1–5 + Phase 6 (benchmark) + Phase 7a (update + delete + naming alignment) + Phase 7b (Claude enrichment at ingestion) + Phase 7c (Redis + BullMQ async queue).
```

**Replace Flow 1:**

```
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
```

**Replace Flow 3:**

```
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
```

**Add new Flow 5:**

```
## Flow 5 — Document Status Check (new in Phase 7c)

**Triggered by:** the upstream control-panel API polling for ingestion completion.

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
```

---

## Out-of-Scope Confirmations

The following items are explicitly excluded from Phase 7c and must not be added:

- Multi-worker scaling — Phase 8
- Job de-duplication by `(account_id, external_id)` — Phase 8
- Sentry/Slack alerts on job failures — Phase 8
- Manual retry endpoint for failed jobs — future
- Dead-letter queue inspection UI — future
- Auth on any KB endpoint — Phase 8
- Change to DELETE behavior — stays sync, unchanged
- Change to `lookup_knowledge_base` retrieval tool — unchanged
- "List all documents for an account" endpoint — future
- Stuck-processing detector / self-healing — deferred to Phase 8 (document in `phase-8-considerations.md`)
- Custom backoff strategy — deferred pending user decision on retry delay values

---

## Implementation Recommendations

1. **Implement Step 6 (service refactor) before Step 7 (controller refactor)** — the controller depends on the new public service methods. Get the service tests green first.

2. **`lookupExistingDocument` visibility change** — currently `private`. Making it `public` is a broader surface change than making it `protected`. Since the controller calls it directly, `public` is required. Alternatively, add a dedicated `findDocument(accountId, externalId)` controller-facing method that wraps it, keeping the original private. This is cleaner architecturally. The plan recommends a thin wrapper to preserve encapsulation.

3. **`forRootAsync` vs `forRoot`** — use `forRootAsync` so the Redis connection config is loaded via `KnowledgeBaseConfigService` (which depends on `ConfigService`) rather than reading `process.env` directly. This is consistent with how the project handles all other config (Qdrant, DynamoDB, Voyage) via config service injection.

4. **Worker concurrency** — `@Processor('knowledge-base-ingestion')` defaults to concurrency 1, which matches the brief's requirement. Do not pass a `concurrency` option unless you want more than 1; default is correct.

5. **Processor must be registered as a provider in `AppModule`** — `@Processor` is a NestJS injectable. Registering `KnowledgeBaseIngestionProcessor` in `providers` is required. `BullModule.registerQueue` alone does not discover the processor.

6. **Phase 8 considerations doc** — add entries for: stuck-processing self-healing via `_processingStartedAt_` field + stuck-job detector, concurrent-update de-duplication, multi-worker scaling.
