import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "crypto";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { QDRANT_CLIENT } from "../providers/qdrant.provider";
import { DatabaseConfigService } from "./database-config.service";
import { VoyageService } from "./voyage.service";
import { KnowledgeBaseEnrichmentService } from "./knowledge-base-enrichment.service";
import { SentryService } from "./sentry.service";
import { chunkText } from "../utils/chunker/chunker";
import { KB_COLLECTION_NAME } from "../utils/knowledge-base/constants";
import {
  KnowledgeBaseChunk,
  KnowledgeBaseDeleteDocumentInput,
  KnowledgeBaseDocumentRecord,
  KnowledgeBaseIngestDocumentInput,
  KnowledgeBaseIngestDocumentResult,
  KnowledgeBaseJobPayload,
  KnowledgeBasePointPayload,
  KnowledgeBaseStatus,
} from "../types/KnowledgeBase";

const KB_DOCUMENT_ENTITY = "KNOWLEDGE_BASE_DOCUMENT";
// Qdrant collection vector size matches the voyage-3-large default output dimension.
// Phase 8: add a startup assertion that the deployed Voyage model produces exactly
// 1024-dimension vectors to catch a model/collection dimension mismatch at boot time.
const KB_VECTOR_SIZE = 1024;
const KB_VECTOR_DISTANCE = "Cosine";
const KB_PK_PREFIX = "A#";
const KB_SK_PREFIX = "KB#DOC#";
const KB_ACCOUNT_ID_INDEX_FIELD = "account_id";

@Injectable()
export class KnowledgeBaseIngestionService {
  private readonly logger = new Logger(KnowledgeBaseIngestionService.name);

  constructor(
    @Inject(QDRANT_CLIENT) private readonly qdrantClient: QdrantClient,
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly voyageService: VoyageService,
    private readonly enrichmentService: KnowledgeBaseEnrichmentService,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly sentryService: SentryService,
  ) {}

  async ingestDocument(input: KnowledgeBaseIngestDocumentInput): Promise<KnowledgeBaseIngestDocumentResult> {
    const startedAt = Date.now();
    const lastUpdated = new Date().toISOString();

    this.logger.log(
      `[accountId=${input.accountId} externalId=${input.externalId} textLength=${input.text.length}] Ingesting document`,
    );

    // Generate a candidate documentId — used only if the lookup below finds no existing record.
    const documentIdCandidate = ulid();

    // Step 3 — look up whether a document with this (accountId, externalId) already exists.
    const existing = await this.lookupExistingDocument(input.accountId, input.externalId);

    // Step 4 — branch: update vs. create.
    const isUpdate = existing !== null;
    const documentId = isUpdate ? existing.document_id : documentIdCandidate;
    const createdAt = isUpdate ? existing._createdAt_ : lastUpdated;

    // Step 5 — chunk → embed → ensure collection + index.
    const chunks = chunkText(input.text);

    if (chunks.length === 0) {
      throw new BadRequestException("Document text produced no content after chunking. Ensure the text field is not empty or whitespace-only.");
    }

    this.logger.debug(`[documentId=${documentId} chunkCount=${chunks.length}] Chunked document`);

    // Step 5b — enrich each chunk with Claude (SUMMARY + QUESTIONS + KEY TERMS).
    // Per-chunk failures are isolated: enrichChunk returns null on failure.
    const enrichments = await this.enrichmentService.enrichAllChunks(chunks);

    const failedCount = enrichments.filter((enrichment) => enrichment === null).length;

    if (failedCount === chunks.length) {
      this.logger.warn(
        `[documentId=${documentId} chunkCount=${chunks.length} failedCount=${failedCount}] All chunk enrichments failed — embedding without enrichment`,
      );
    }

    if (failedCount > chunks.length / 2 && failedCount < chunks.length) {
      this.logger.warn(
        `[documentId=${documentId} chunkCount=${chunks.length} failedCount=${failedCount}] Majority of chunk enrichments failed`,
      );
    }

    // Step 5c — build texts to embed: combined text when enrichment succeeded, chunk_text only on failure.
    const textsToEmbed = chunks.map((chunk, index) => {
      return enrichments[index] !== null ? `${chunk.text}\n\n${enrichments[index]}` : chunk.text;
    });

    // VoyageService already produces sanitized error messages — let them propagate.
    const embeddings = await this.voyageService.embedTexts(textsToEmbed);

    await this.ensureCollection();
    await this.ensurePayloadIndex();

    // Step 6 — if updating, delete old Qdrant chunks before writing new ones.
    if (isUpdate) {
      await this.deleteQdrantPoints(input.accountId, documentId);
    }

    // Step 7 — upsert new Qdrant points.
    // Chunks carry _createdAt_ = this run's timestamp (not the document's original creation
    // time on the update path). On update, chunks are replaced wholesale, so they only ever
    // reflect the time they were written. The DDB record's _createdAt_ preserves the
    // original document creation time separately.
    await this.writeQdrantPoints(documentId, input, chunks, embeddings, enrichments, lastUpdated);

    // Step 8 — write DynamoDB record (PutCommand replaces existing item at same PK+SK).
    await this.writeDynamoRecord(documentId, input, chunks.length, createdAt, lastUpdated);

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `[documentId=${documentId} chunkCount=${chunks.length} durationMs=${durationMs} isUpdate=${isUpdate}] Ingestion complete`,
    );

    // Step 9 — return result.
    return { document_id: documentId, chunk_count: chunks.length, status: "ready", _createdAt_: createdAt, _lastUpdated_: lastUpdated };
  }

  /**
   * Writes a "pending" DynamoDB record for a newly enqueued ingestion job.
   * Called at POST time before the job is enqueued. Uses PutCommand — safe to
   * overwrite an existing record (update path reuses the same PK+SK).
   */
  async writePendingRecord(
    documentId: string,
    accountId: string,
    payload: Pick<KnowledgeBaseJobPayload, "externalId" | "title" | "sourceType" | "mimeType">,
    createdAt: string,
  ): Promise<void> {
    const item = {
      PK: `${KB_PK_PREFIX}${accountId}`,
      SK: `${KB_SK_PREFIX}${documentId}`,
      entity: KB_DOCUMENT_ENTITY,
      document_id: documentId,
      account_id: accountId,
      external_id: payload.externalId,
      title: payload.title,
      source_type: payload.sourceType,
      ...(payload.mimeType ? { mime_type: payload.mimeType } : {}),
      status: "pending",
      _createdAt_: createdAt,
      _lastUpdated_: createdAt,
    } satisfies KnowledgeBaseDocumentRecord;

    try {
      await this.dynamoDb.send(
        new PutCommand({ TableName: this.databaseConfig.conversationsTable, Item: item }),
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} documentId=${documentId} accountId=${accountId}] Failed to write pending DynamoDB record`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "ingestion-service", account_id: accountId, document_id: documentId },
      });
      throw new InternalServerErrorException("Failed to record document metadata.");
    }
  }

  /**
   * Updates the status (and optionally error_summary) of an existing DDB document record.
   * Uses UpdateCommand to avoid stomping on other fields (title, text, chunk_count, etc.).
   */
  async updateDocumentStatus(
    accountId: string,
    documentId: string,
    status: KnowledgeBaseStatus,
    errorSummary?: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    const hasError = status === "failed" && errorSummary !== undefined;

    const updateExpression = hasError
      ? "SET #status = :status, #lastUpdated = :now, error_summary = :errorSummary"
      : "SET #status = :status, #lastUpdated = :now";

    const expressionAttributeValues: Record<string, unknown> = {
      ":status": status,
      ":now": now,
    };

    if (hasError) {
      expressionAttributeValues[":errorSummary"] = errorSummary;
    }

    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: this.databaseConfig.conversationsTable,
          Key: {
            PK: `${KB_PK_PREFIX}${accountId}`,
            SK: `${KB_SK_PREFIX}${documentId}`,
          },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: {
            "#status": "status",
            "#lastUpdated": "_lastUpdated_",
          },
          ExpressionAttributeValues: expressionAttributeValues,
        }),
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} accountId=${accountId} documentId=${documentId} status=${status}] Failed to update document status`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "ingestion-service", account_id: accountId, document_id: documentId },
      });
      throw new InternalServerErrorException("Failed to update document status.");
    }
  }

  async deleteDocument(input: KnowledgeBaseDeleteDocumentInput): Promise<void> {
    this.logger.log(`[accountId=${input.accountId} externalId=${input.externalId}] Deleting document`);

    // Step 2 — look up the document.
    const existing = await this.lookupExistingDocument(input.accountId, input.externalId);

    if (existing === null) {
      this.logger.log(`[accountId=${input.accountId} externalId=${input.externalId} action=noop] Document not found, no-op`);
      return;
    }

    const documentId = existing.document_id;

    // Step 3 — delete all Qdrant chunks for this document.
    await this.deleteQdrantPoints(input.accountId, documentId);

    // Step 4 — delete the DynamoDB record.
    try {
      await this.dynamoDb.send(
        new DeleteCommand({
          TableName: this.databaseConfig.conversationsTable,
          Key: {
            PK: `${KB_PK_PREFIX}${input.accountId}`,
            SK: `${KB_SK_PREFIX}${documentId}`,
          },
        }),
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} accountId=${input.accountId} documentId=${documentId}] Failed to delete DynamoDB document record`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "ingestion-service", account_id: input.accountId, document_id: documentId },
      });
      throw new InternalServerErrorException("Failed to delete document metadata.");
    }

    this.logger.log(`[accountId=${input.accountId} documentId=${documentId} action=deleted] Document deleted`);
  }

  /**
   * Looks up an existing KB document record by (accountId, externalId).
   * Returns the full KnowledgeBaseDocumentRecord if found, or null if not found.
   * Throws InternalServerErrorException on DynamoDB error.
   *
   * Uses a Query on PK = A#<accountId> with begins_with(SK, "KB#DOC#") and a
   * FilterExpression on external_id. No GSI required at current scale; a future
   * phase can add one when accounts host > ~500 documents or p99 lookup latency
   * exceeds 10ms in profiling.
   */
  async lookupExistingDocument(
    accountId: string,
    externalId: string,
  ): Promise<KnowledgeBaseDocumentRecord | null> {
    this.logger.debug(`[accountId=${accountId} externalId=${externalId}] Looking up existing document`);

    try {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.databaseConfig.conversationsTable,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          FilterExpression: "external_id = :externalId",
          ExpressionAttributeValues: {
            ":pk": `${KB_PK_PREFIX}${accountId}`,
            ":skPrefix": KB_SK_PREFIX,
            ":externalId": externalId,
          },
          Limit: 1,
        }),
      );

      if (!result.Items || result.Items.length === 0) {
        return null;
      }

      return result.Items[0] as unknown as KnowledgeBaseDocumentRecord;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} accountId=${accountId} externalId=${externalId}] Failed to query DynamoDB for existing document`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "ingestion-service", account_id: accountId },
      });
      throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
    }
  }

  /**
   * Deletes all Qdrant points matching (accountId, documentId).
   * Uses wait: true to ensure the delete is reflected before subsequent operations.
   */
  private async deleteQdrantPoints(accountId: string, documentId: string): Promise<void> {
    try {
      await this.qdrantClient.delete(KB_COLLECTION_NAME, {
        wait: true,
        filter: {
          must: [
            { key: "account_id", match: { value: accountId } },
            { key: "document_id", match: { value: documentId } },
          ],
        },
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} accountId=${accountId} documentId=${documentId}] Failed to delete Qdrant points`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "qdrant", account_id: accountId, document_id: documentId },
      });
      throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
    }
  }

  private async ensureCollection(): Promise<void> {
    let exists: boolean;

    try {
      const result = await this.qdrantClient.collectionExists(KB_COLLECTION_NAME);
      exists = result.exists;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`[errorType=${errorName}] Failed to check Qdrant collection existence`);
      this.sentryService.captureException(error, {
        tags: { category: "qdrant" },
      });
      throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
    }

    if (exists) {
      return;
    }

    try {
      await this.qdrantClient.createCollection(KB_COLLECTION_NAME, {
        vectors: { size: KB_VECTOR_SIZE, distance: KB_VECTOR_DISTANCE },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("already exists")) {
        // Lost the race — another concurrent request created the collection. Safe to continue.
        return;
      }
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`[errorType=${errorName}] Failed to create Qdrant collection`);
      this.sentryService.captureException(error, {
        tags: { category: "qdrant" },
      });
      throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
    }
  }

  // Add a keyword index on account_id so retrieval queries can filter efficiently.
  // Runs on every ingestion — idempotent: "already exists" errors are swallowed.
  // Non-fatal: the index is a performance optimization, not a correctness requirement.
  private async ensurePayloadIndex(): Promise<void> {
    try {
      await this.qdrantClient.createPayloadIndex(KB_COLLECTION_NAME, {
        field_name: KB_ACCOUNT_ID_INDEX_FIELD,
        field_schema: "keyword",
        wait: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("already exists")) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        this.logger.warn(`[errorType=${errorName}] Failed to create payload index on account_id`);
      }
    }
  }

  private async writeQdrantPoints(
    documentId: string,
    input: KnowledgeBaseIngestDocumentInput,
    chunks: KnowledgeBaseChunk[],
    embeddings: number[][],
    enrichments: (string | null)[],
    createdAt: string,
  ): Promise<void> {
    const points = chunks.map((chunk, index) => {
      return {
        id: randomUUID(),
        vector: embeddings[index],
        payload: {
          account_id: input.accountId,
          document_id: documentId,
          document_title: input.title,
          external_id: input.externalId,
          chunk_index: chunk.index,
          chunk_text: chunk.text,
          start_offset: chunk.startOffset,
          end_offset: chunk.endOffset,
          source_type: input.sourceType,
          _createdAt_: createdAt,
          ...(enrichments[index] !== null ? { enrichment: enrichments[index] } : {}),
        } satisfies KnowledgeBasePointPayload,
      };
    });

    try {
      await this.qdrantClient.upsert(KB_COLLECTION_NAME, { wait: true, points });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} documentId=${documentId}] Failed to upsert Qdrant points`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "qdrant", account_id: input.accountId, document_id: documentId },
      });
      throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
    }
  }

  private async writeDynamoRecord(
    documentId: string,
    input: KnowledgeBaseIngestDocumentInput,
    chunkCount: number,
    createdAt: string,
    lastUpdated: string,
  ): Promise<void> {
    const item: KnowledgeBaseDocumentRecord = {
      PK: `${KB_PK_PREFIX}${input.accountId}`,
      SK: `${KB_SK_PREFIX}${documentId}`,
      entity: KB_DOCUMENT_ENTITY,
      document_id: documentId,
      account_id: input.accountId,
      external_id: input.externalId,
      title: input.title,
      source_type: input.sourceType,
      ...(input.mimeType ? { mime_type: input.mimeType } : {}),
      chunk_count: chunkCount,
      status: "ready",
      _createdAt_: createdAt,
      _lastUpdated_: lastUpdated,
    };

    try {
      await this.dynamoDb.send(
        new PutCommand({ TableName: this.databaseConfig.conversationsTable, Item: item }),
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorName} documentId=${documentId}] Failed to write DynamoDB document record`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "ingestion-service", document_id: documentId },
      });
      throw new InternalServerErrorException("Failed to record document metadata.");
    }
  }
}
