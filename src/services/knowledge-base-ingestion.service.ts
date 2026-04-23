import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "crypto";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { QDRANT_CLIENT } from "../providers/qdrant.provider";
import { DatabaseConfigService } from "./database-config.service";
import { VoyageService } from "./voyage.service";
import { chunkText } from "../utils/chunker/chunker";
import { KB_COLLECTION_NAME } from "../utils/knowledge-base/constants";
import {
  KnowledgeBaseChunk,
  KnowledgeBaseDocumentRecord,
  KnowledgeBaseIngestDocumentInput,
  KnowledgeBaseIngestDocumentResult,
  KnowledgeBasePointPayload,
} from "../types/KnowledgeBase";
const KB_DOCUMENT_ENTITY = "KB_DOCUMENT";
// Qdrant collection vector size matches the voyage-3-large default output dimension.
// Phase 8: add a startup assertion that the deployed Voyage model produces exactly
// 1024-dimension vectors to catch a model/collection dimension mismatch at boot time.
const KB_VECTOR_SIZE = 1024;
const KB_VECTOR_DISTANCE = "Cosine";
const KB_PK_PREFIX = "A#";
const KB_SK_PREFIX = "KB#DOC#";
const KB_ACCOUNT_ULID_INDEX_FIELD = "account_ulid";

@Injectable()
export class KnowledgeBaseIngestionService {
  private readonly logger = new Logger(KnowledgeBaseIngestionService.name);

  constructor(
    @Inject(QDRANT_CLIENT) private readonly qdrantClient: QdrantClient,
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly voyageService: VoyageService,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async ingestDocument(input: KnowledgeBaseIngestDocumentInput): Promise<KnowledgeBaseIngestDocumentResult> {
    const startedAt = Date.now();
    const createdAt = new Date().toISOString();

    this.logger.log(
      `Ingesting document [accountUlid=${input.accountUlid} externalId=${input.externalId} textLength=${input.text.length}]`,
    );

    const documentUlid = ulid();

    const chunks = chunkText(input.text);

    if (chunks.length === 0) {
      throw new BadRequestException("Document text produced no content after chunking. Ensure the text field is not empty or whitespace-only.");
    }

    this.logger.debug(`Chunked document [documentUlid=${documentUlid} chunkCount=${chunks.length}]`);

    // VoyageService already produces sanitized error messages — let them propagate.
    const embeddings = await this.voyageService.embedTexts(chunks.map((chunk) => chunk.text));

    await this.ensureCollection();
    await this.ensurePayloadIndex();

    await this.writeQdrantPoints(documentUlid, input, chunks, embeddings, createdAt);

    await this.writeDynamoRecord(documentUlid, input, chunks.length, createdAt);

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `Ingestion complete [documentUlid=${documentUlid} chunkCount=${chunks.length} durationMs=${durationMs}]`,
    );

    return { documentUlid, chunkCount: chunks.length, status: "ready", createdAt };
  }

  private async ensureCollection(): Promise<void> {
    let exists: boolean;

    try {
      const result = await this.qdrantClient.collectionExists(KB_COLLECTION_NAME);
      exists = result.exists;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`Failed to check Qdrant collection existence [errorType=${errorName}]`);
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
      this.logger.error(`Failed to create Qdrant collection [errorType=${errorName}]`);
      throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
    }
  }

  // Add a keyword index on account_ulid so retrieval queries can filter efficiently.
  // Runs on every ingestion — idempotent: "already exists" errors are swallowed.
  // Non-fatal: the index is a performance optimization, not a correctness requirement.
  private async ensurePayloadIndex(): Promise<void> {
    try {
      await this.qdrantClient.createPayloadIndex(KB_COLLECTION_NAME, {
        field_name: KB_ACCOUNT_ULID_INDEX_FIELD,
        field_schema: "keyword",
        wait: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("already exists")) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        this.logger.warn(`Failed to create payload index on account_ulid [errorType=${errorName}]`);
      }
    }
  }

  private async writeQdrantPoints(
    documentUlid: string,
    input: KnowledgeBaseIngestDocumentInput,
    chunks: KnowledgeBaseChunk[],
    embeddings: number[][],
    createdAt: string,
  ): Promise<void> {
    const points = chunks.map((chunk, index) => {
      return {
        id: randomUUID(),
        vector: embeddings[index],
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
      };
    });

    try {
      await this.qdrantClient.upsert(KB_COLLECTION_NAME, { wait: true, points });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `Failed to upsert Qdrant points [errorType=${errorName} documentUlid=${documentUlid}]`,
      );
      throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
    }
  }

  private async writeDynamoRecord(
    documentUlid: string,
    input: KnowledgeBaseIngestDocumentInput,
    chunkCount: number,
    createdAt: string,
  ): Promise<void> {
    const item = {
      pk: `${KB_PK_PREFIX}${input.accountUlid}`,
      sk: `${KB_SK_PREFIX}${documentUlid}`,
      entity: KB_DOCUMENT_ENTITY,
      document_ulid: documentUlid,
      account_ulid: input.accountUlid,
      external_id: input.externalId,
      title: input.title,
      source_type: input.sourceType,
      ...(input.mimeType ? { mime_type: input.mimeType } : {}),
      chunk_count: chunkCount,
      status: "ready",
      created_at: createdAt,
    } satisfies KnowledgeBaseDocumentRecord;

    try {
      await this.dynamoDb.send(
        new PutCommand({ TableName: this.databaseConfig.conversationsTable, Item: item }),
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `Failed to write DynamoDB document record [errorType=${errorName} documentUlid=${documentUlid}]`,
      );
      throw new InternalServerErrorException("Failed to record document metadata.");
    }
  }
}
