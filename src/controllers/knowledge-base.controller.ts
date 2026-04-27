import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ulid } from "ulid";

import { ZodValidationPipe } from "../pipes/knowledgeBaseValidation.pipe";
import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import {
  KnowledgeBaseGetDocumentResult,
  KnowledgeBaseIngestAcceptedResult,
  KnowledgeBaseJobPayload,
} from "../types/KnowledgeBase";
import { ingestDocumentSchema, deleteDocumentSchema, getDocumentSchema } from "../validation/knowledge-base.schema";
import type { IngestDocumentBody, DeleteDocumentBody, GetDocumentQuery } from "../validation/knowledge-base.schema";

const KB_INGESTION_QUEUE = "knowledge-base-ingestion";
const KB_INGEST_JOB = "ingest";
const KB_RETRY_ATTEMPTS = 4;
const KB_BACKOFF_DELAY_MS = 1000;

@Controller("knowledge-base")
export class KnowledgeBaseController {
  private readonly logger = new Logger(KnowledgeBaseController.name);

  constructor(
    private readonly ingestionService: KnowledgeBaseIngestionService,
    @InjectQueue(KB_INGESTION_QUEUE) private readonly queue: Queue,
  ) {}

  @Post("documents")
  @HttpCode(202)
  async ingestDocument(
    @Body(new ZodValidationPipe(ingestDocumentSchema)) body: IngestDocumentBody,
  ): Promise<KnowledgeBaseIngestAcceptedResult> {
    // Schema validates the A#-prefixed form; strip the prefix so the service
    // and all downstream writes operate on the raw 26-character ULID only.
    const rawAccountId = body.account_id.slice(2);

    // Step 1 — look up existing record to determine create vs. update path.
    const existing = await this.ingestionService.lookupExistingDocument(rawAccountId, body.external_id);

    // Step 2 — generate or reuse document_id and createdAt.
    const isUpdate = existing !== null;
    const documentId = isUpdate ? existing.document_id : ulid();
    const createdAt = isUpdate ? existing._createdAt_ : new Date().toISOString();

    this.logger.log(
      `[documentId=${documentId} accountId=${rawAccountId} externalId=${body.external_id} isUpdate=${isUpdate}] Writing pending record`,
    );

    // Step 3 — write pending DDB record BEFORE enqueueing so the record exists
    // immediately and the upstream can poll on it from the moment 202 returns.
    await this.ingestionService.writePendingRecord(
      documentId,
      rawAccountId,
      {
        externalId: body.external_id,
        title: body.title,
        sourceType: body.source_type,
        mimeType: body.mime_type,
      },
      createdAt,
    );

    // Step 4 — enqueue the BullMQ job.
    const jobPayload: KnowledgeBaseJobPayload = {
      accountId: rawAccountId,
      externalId: body.external_id,
      title: body.title,
      text: body.text,
      sourceType: body.source_type,
      mimeType: body.mime_type,
      documentId,
      createdAt,
    };

    try {
      await this.queue.add(KB_INGEST_JOB, jobPayload, {
        attempts: KB_RETRY_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: KB_BACKOFF_DELAY_MS,
        },
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} documentId=${documentId} accountId=${rawAccountId}] Failed to enqueue ingestion job — pending record left in place`,
      );
      // The DDB pending record is left as an orphan. The upstream can re-POST
      // to retry — the update path will overwrite the pending record and
      // attempt enqueue again. See Phase 8 for stuck-pending cleanup.
      throw new ServiceUnavailableException(
        "Ingestion queue is temporarily unavailable. Please retry.",
      );
    }

    this.logger.log(
      `[documentId=${documentId} accountId=${rawAccountId} externalId=${body.external_id}] Job enqueued, returning 202`,
    );

    // Step 5 — return 202 immediately.
    return { document_id: documentId, status: "pending", _createdAt_: createdAt };
  }

  @Get("documents")
  @HttpCode(200)
  async getDocument(
    @Query(new ZodValidationPipe(getDocumentSchema)) query: GetDocumentQuery,
  ): Promise<KnowledgeBaseGetDocumentResult> {
    const rawAccountId = query.account_id.slice(2);

    const record = await this.ingestionService.lookupExistingDocument(rawAccountId, query.external_id);

    if (record === null) {
      throw new NotFoundException("Document not found.");
    }

    return {
      document_id: record.document_id,
      account_id: record.account_id,
      external_id: record.external_id,
      title: record.title,
      source_type: record.source_type,
      ...(record.mime_type !== undefined ? { mime_type: record.mime_type } : {}),
      ...(record.chunk_count !== undefined ? { chunk_count: record.chunk_count } : {}),
      status: record.status,
      _createdAt_: record._createdAt_,
      _lastUpdated_: record._lastUpdated_,
      ...(record.error_summary !== undefined ? { error_summary: record.error_summary } : {}),
    };
  }

  @Delete("documents")
  @HttpCode(204)
  async deleteDocument(
    @Body(new ZodValidationPipe(deleteDocumentSchema)) body: DeleteDocumentBody,
  ): Promise<void> {
    const rawAccountId = body.account_id.slice(2);
    return this.ingestionService.deleteDocument({ accountId: rawAccountId, externalId: body.external_id });
  }
}
