import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { KB_INGESTION_QUEUE_NAME, KB_INGESTION_RETRY_ATTEMPTS } from "../utils/knowledge-base/constants";
import {
  KnowledgeBaseGetDocumentResult,
  KnowledgeBaseIngestAcceptedResult,
  KnowledgeBaseJobPayload,
} from "../types/KnowledgeBase";
import { ingestDocumentSchema, deleteDocumentSchema, getDocumentSchema } from "../validation/knowledge-base.schema";
import type { IngestDocumentBody, DeleteDocumentBody, GetDocumentQuery } from "../validation/knowledge-base.schema";

const KB_INGEST_JOB = "ingest";
const KB_BACKOFF_DELAY_MS = 1000;

@Controller("knowledge-base")
export class KnowledgeBaseController {
  private readonly logger = new Logger(KnowledgeBaseController.name);

  constructor(
    private readonly ingestionService: KnowledgeBaseIngestionService,
    @InjectQueue(KB_INGESTION_QUEUE_NAME) private readonly queue: Queue,
  ) {}

  @Post("documents")
  @HttpCode(202)
  async ingestDocument(
    @Body(new ZodValidationPipe(ingestDocumentSchema)) body: IngestDocumentBody,
  ): Promise<KnowledgeBaseIngestAcceptedResult> {
    const rawAccountId = body.account_id.slice(2);

    const existing = await this.ingestionService.lookupExistingDocument(rawAccountId, body.external_id);

    const isUpdate = existing !== null;
    const documentId = isUpdate ? existing.document_id : ulid();
    const createdAt = isUpdate ? existing._createdAt_ : new Date().toISOString();

    this.logger.log(
      `[documentId=${documentId} accountId=${rawAccountId} externalId=${body.external_id} isUpdate=${isUpdate}] Writing pending record`,
    );

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

    const jobPayload = {
      accountId: rawAccountId,
      externalId: body.external_id,
      title: body.title,
      text: body.text,
      sourceType: body.source_type,
      mimeType: body.mime_type,
      documentId,
      createdAt,
    } satisfies KnowledgeBaseJobPayload;

    try {
      await this.queue.add(KB_INGEST_JOB, jobPayload, {
        attempts: KB_INGESTION_RETRY_ATTEMPTS,
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
      throw new ServiceUnavailableException("Ingestion queue is temporarily unavailable. Please retry.");
    }

    this.logger.log(
      `[documentId=${documentId} accountId=${rawAccountId} externalId=${body.external_id}] Job enqueued, returning 202`,
    );

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
