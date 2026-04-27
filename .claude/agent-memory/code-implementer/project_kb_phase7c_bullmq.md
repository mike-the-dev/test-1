---
name: KB Phase 7c — BullMQ async queue pattern
description: How BullMQ is wired into the KB ingestion pipeline; key patterns for the processor and testing
type: project
---

Phase 7c made KB ingestion async. Key patterns established:

- `BullModule.forRootAsync` injects `KnowledgeBaseConfigService` for typed Redis config.
- `BullModule.registerQueue({ name: "knowledge-base-ingestion" })` registers the queue; the processor is separately added to `providers`.
- Processor uses `@Processor(queueName)` + `extends WorkerHost` with `async process(job)` override and `@OnWorkerEvent("failed")` for lifecycle events.
- `UnrecoverableError` from `bullmq` is thrown for `BadRequestException` (zero-chunk validation) so BullMQ marks job as truly failed rather than completed.
- Controller injects queue via `@InjectQueue("knowledge-base-ingestion") private readonly queue: Queue`.
- Test mock: use `getQueueToken("knowledge-base-ingestion")` from `@nestjs/bullmq` as the DI token for the mock queue.
- Processor tests mock `@nestjs/bullmq` decorators at the module level so WorkerHost has no real BullMQ dependency.
- DDB record written with `status: "pending"` BEFORE `queue.add()` — ordering is critical.
- `lookupExistingDocument` is public and returns full `KnowledgeBaseDocumentRecord | null`.
- `writePendingRecord` and `updateDocumentStatus` are public methods on `KnowledgeBaseIngestionService`.
- `updateDocumentStatus` uses `UpdateCommand` (not PutCommand) to avoid stomping other fields.

**Why:** established by Phase 7c implementation (commit 52ad724c).
**How to apply:** reference when extending BullMQ queue or adding new processors to this project.
