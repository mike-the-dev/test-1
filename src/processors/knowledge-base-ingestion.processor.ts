import { BadRequestException, Logger } from "@nestjs/common";
import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";

import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { KnowledgeBaseJobPayload } from "../types/KnowledgeBase";

const KB_INGESTION_QUEUE = "knowledge-base-ingestion";
const KB_RETRY_ATTEMPTS = 4;

const ERROR_SUMMARY_GENERIC = "Processing failed after multiple retries. Please re-submit the document.";

@Processor(KB_INGESTION_QUEUE)
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

    // Transition status to "processing" before running the pipeline.
    await this.ingestionService.updateDocumentStatus(accountId, documentId, "processing");

    try {
      // Run the full Phase 7b pipeline — unchanged behavior.
      await this.ingestionService.ingestDocument({
        accountId: job.data.accountId,
        externalId: job.data.externalId,
        title: job.data.title,
        text: job.data.text,
        sourceType: job.data.sourceType,
        mimeType: job.data.mimeType,
      });

      // ingestDocument ends by calling writeDynamoRecord with status: "ready" via PutCommand.
      // No additional update needed here — the record is fully written by the service.
      this.logger.log(
        `[documentId=${documentId} accountId=${accountId} status=ready] Job completed`,
      );
    } catch (error) {
      const isValidationFailure = error instanceof BadRequestException;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const isFinalAttempt = attempt >= KB_RETRY_ATTEMPTS;

      this.logger.error(
        `[documentId=${documentId} accountId=${accountId} errorType=${errorName} attempt=${attempt} isFinalAttempt=${isFinalAttempt}] Job failed`,
      );

      if (isValidationFailure) {
        // Deterministic failure — retrying would produce the same result.
        // Write failed status with the (safe, internally-generated) error message.
        const safeMessage =
          error instanceof BadRequestException && typeof error.message === "string"
            ? error.message
            : "Document validation failed.";

        await this.ingestionService.updateDocumentStatus(accountId, documentId, "failed", safeMessage);

        // UnrecoverableError tells BullMQ to move the job to failed without retrying,
        // so it appears as a true failure in job history — not silently "completed".
        throw new UnrecoverableError(safeMessage);
      }

      if (isFinalAttempt) {
        // All retries exhausted — write the failed status with a generic safe message.
        // Never expose raw error.message here; it may contain API keys or upstream error bodies.
        await this.ingestionService.updateDocumentStatus(accountId, documentId, "failed", ERROR_SUMMARY_GENERIC);
      }

      // Re-throw to let BullMQ apply the retry/backoff policy.
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
