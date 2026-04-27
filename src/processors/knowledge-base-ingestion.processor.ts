import { BadRequestException, Logger } from "@nestjs/common";
import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";

import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { KB_INGESTION_QUEUE_NAME, KB_INGESTION_RETRY_ATTEMPTS } from "../utils/knowledge-base/constants";
import { KnowledgeBaseJobPayload } from "../types/KnowledgeBase";

const ERROR_SUMMARY_GENERIC = "Processing failed after multiple retries. Please re-submit the document.";
const ERROR_SUMMARY_VALIDATION = "Document validation failed. Please check the submitted content and resubmit.";

@Processor(KB_INGESTION_QUEUE_NAME)
export class KnowledgeBaseIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(KnowledgeBaseIngestionProcessor.name);

  constructor(private readonly ingestionService: KnowledgeBaseIngestionService) {
    super();
  }

  async process(job: Job<KnowledgeBaseJobPayload>): Promise<void> {
    const { documentId, accountId, externalId } = job.data;
    const attempt = job.attemptsMade + 1;

    this.logger.log(
      `[documentId=${documentId} accountId=${accountId} externalId=${externalId} attempt=${attempt}] Processing job`,
    );

    await this.ingestionService.updateDocumentStatus(accountId, documentId, "processing");

    try {
      await this.ingestionService.ingestDocument({
        accountId: job.data.accountId,
        externalId: job.data.externalId,
        title: job.data.title,
        text: job.data.text,
        sourceType: job.data.sourceType,
        mimeType: job.data.mimeType,
      });

      this.logger.log(
        `[documentId=${documentId} accountId=${accountId} status=ready] Job completed`,
      );
    } catch (error) {
      const isValidationFailure = error instanceof BadRequestException;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const isFinalAttempt = attempt >= KB_INGESTION_RETRY_ATTEMPTS;

      this.logger.error(
        `[documentId=${documentId} accountId=${accountId} errorType=${errorName} attempt=${attempt} isFinalAttempt=${isFinalAttempt}] Job failed`,
      );

      if (isValidationFailure) {
        // Defense in depth: never echo error.message into a persisted field. The current
        // BadRequestException messages are hardcoded and safe, but a future contributor
        // throwing with user-supplied or external-API content would otherwise leak it.
        await this.ingestionService.updateDocumentStatus(accountId, documentId, "failed", ERROR_SUMMARY_VALIDATION);

        throw new UnrecoverableError(ERROR_SUMMARY_VALIDATION);
      }

      if (isFinalAttempt) {
        await this.ingestionService.updateDocumentStatus(accountId, documentId, "failed", ERROR_SUMMARY_GENERIC);
      }

      throw error;
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<KnowledgeBaseJobPayload>, error: Error): void {
    this.logger.error(
      `[documentId=${job.data.documentId} jobId=${job.id} errorType=${error.name}] Job exhausted retries`,
    );
  }
}
