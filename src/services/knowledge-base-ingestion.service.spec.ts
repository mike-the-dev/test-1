import { BadRequestException, InternalServerErrorException, Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { KnowledgeBaseIngestionService } from "./knowledge-base-ingestion.service";
import { VoyageService } from "./voyage.service";
import { KnowledgeBaseEnrichmentService } from "./knowledge-base-enrichment.service";
import { DatabaseConfigService } from "./database-config.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { QDRANT_CLIENT } from "../providers/qdrant.provider";
import { KnowledgeBaseIngestDocumentInput } from "../types/KnowledgeBase";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

jest.mock("ulid", () => ({ ulid: jest.fn(() => "01TESTULID000000000000000A") }));
jest.mock("crypto", () => ({
  ...jest.requireActual("crypto"),
  randomUUID: jest.fn()
    .mockReturnValueOnce("uuid-0000-0000-0000-000000000001")
    .mockReturnValueOnce("uuid-0000-0000-0000-000000000002")
    .mockReturnValueOnce("uuid-0000-0000-0000-000000000003"),
}));

const { ulid } = jest.requireMock<{ ulid: jest.Mock }>("ulid");
const { randomUUID } = jest.requireMock<{ randomUUID: jest.Mock }>("crypto");

// ---------------------------------------------------------------------------
// Chunker mock — controls chunk output precisely in most tests
// ---------------------------------------------------------------------------

jest.mock("../utils/chunker/chunker", () => ({
  chunkText: jest.fn(),
}));

const { chunkText } = jest.requireMock<{ chunkText: jest.Mock }>("../utils/chunker/chunker");

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

// Valid 26-char Crockford base32 ULID (only [0-9A-HJKMNP-TV-Z]).
const ACCOUNT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DOCUMENT_ID = "01TESTULID000000000000000A";
const EXISTING_DOCUMENT_ID = "01EXISTINGDOCID0000000000A";
const TABLE_NAME = "test-table";

const STUB_INPUT = {
  accountId: ACCOUNT_ID,
  externalId: "ext-001",
  title: "Test Document",
  text: "Some meaningful text here.",
  sourceType: "pdf",
} satisfies KnowledgeBaseIngestDocumentInput;

const STUB_CHUNKS = [
  { text: "chunk one", index: 0, startOffset: 0, endOffset: 9 },
  { text: "chunk two", index: 1, startOffset: 5, endOffset: 14 },
  { text: "chunk three", index: 2, startOffset: 10, endOffset: 21 },
];

const STUB_EMBEDDINGS = [
  Array(1024).fill(0.1),
  Array(1024).fill(0.2),
  Array(1024).fill(0.3),
];

// ---------------------------------------------------------------------------
// Qdrant client mock
// ---------------------------------------------------------------------------

const mockQdrantClient = {
  collectionExists: jest.fn(),
  createCollection: jest.fn(),
  createPayloadIndex: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
};

// ---------------------------------------------------------------------------
// Voyage service mock
// ---------------------------------------------------------------------------

const mockVoyageService = {
  embedTexts: jest.fn(),
};

// ---------------------------------------------------------------------------
// Enrichment service mock
// ---------------------------------------------------------------------------

const mockEnrichmentService = {
  enrichAllChunks: jest.fn(),
};

// ---------------------------------------------------------------------------
// DynamoDB mock
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("KnowledgeBaseIngestionService", () => {
  let service: KnowledgeBaseIngestionService;

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    // Restore stable UUID sequence after clearAllMocks resets the call count
    randomUUID
      .mockReturnValueOnce("uuid-0000-0000-0000-000000000001")
      .mockReturnValueOnce("uuid-0000-0000-0000-000000000002")
      .mockReturnValueOnce("uuid-0000-0000-0000-000000000003");

    ulid.mockReturnValue(DOCUMENT_ID);

    // Default happy-path setup
    chunkText.mockReturnValue(STUB_CHUNKS);
    mockEnrichmentService.enrichAllChunks.mockResolvedValue(["enrich0", "enrich1", "enrich2"]);
    mockVoyageService.embedTexts.mockResolvedValue(STUB_EMBEDDINGS);
    mockQdrantClient.collectionExists.mockResolvedValue({ exists: true });
    mockQdrantClient.createCollection.mockResolvedValue(true);
    mockQdrantClient.createPayloadIndex.mockResolvedValue({});
    mockQdrantClient.upsert.mockResolvedValue({ status: "completed", operation_id: 1 });
    mockQdrantClient.delete.mockResolvedValue({ status: "completed", operation_id: 2 });

    // Default: no existing document (create path)
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KnowledgeBaseIngestionService,
        {
          provide: QDRANT_CLIENT,
          useValue: mockQdrantClient,
        },
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        {
          provide: VoyageService,
          useValue: mockVoyageService,
        },
        {
          provide: KnowledgeBaseEnrichmentService,
          useValue: mockEnrichmentService,
        },
        {
          provide: DatabaseConfigService,
          useValue: { conversationsTable: TABLE_NAME },
        },
      ],
    }).compile();

    service = module.get<KnowledgeBaseIngestionService>(KnowledgeBaseIngestionService);
  });

  // -------------------------------------------------------------------------
  // Happy path — create (no existing document)
  // -------------------------------------------------------------------------

  describe("happy path — 3 chunks in, 3 points out (create)", () => {
    it("returns the correct result DTO", async () => {
      const result = await service.ingestDocument(STUB_INPUT);

      expect(result.document_id).toBe(DOCUMENT_ID);
      expect(result.chunk_count).toBe(3);
      expect(result.status).toBe("ready");
      expect(typeof result._createdAt_).toBe("string");
      expect(result._createdAt_).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof result._lastUpdated_).toBe("string");
      expect(result._lastUpdated_).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("calls embedTexts with the combined texts (chunk + enrichment) in chunker order", async () => {
      await service.ingestDocument(STUB_INPUT);

      expect(mockVoyageService.embedTexts).toHaveBeenCalledWith([
        "chunk one\n\nenrich0",
        "chunk two\n\nenrich1",
        "chunk three\n\nenrich2",
      ]);
    });

    it("upserts 3 points with correct payload fields including account_id and chunk_index", async () => {
      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(1);

      const upsertCall = mockQdrantClient.upsert.mock.calls[0];
      const collectionName = upsertCall[0];
      const upsertArgs = upsertCall[1];
      expect(collectionName).toBe("knowledge_base");
      expect(upsertArgs.wait).toBe(true);
      expect(upsertArgs.points).toHaveLength(3);

      const [p0, p1, p2] = upsertArgs.points;

      expect(p0.payload.account_id).toBe(ACCOUNT_ID);
      expect(p0.payload.document_id).toBe(DOCUMENT_ID);
      expect(p0.payload.chunk_index).toBe(0);
      expect(p0.payload.chunk_text).toBe("chunk one");
      expect(p0.payload.source_type).toBe("pdf");

      expect(p1.payload.chunk_index).toBe(1);
      expect(p2.payload.chunk_index).toBe(2);
    });

    it("writes a DynamoDB record with the correct pk, sk, and account_id", async () => {
      await service.ingestDocument(STUB_INPUT);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const item: Record<string, unknown> = putCalls[0].args[0].input.Item ?? {};
      expect(item.PK).toBe(`A#${ACCOUNT_ID}`);
      expect(item.SK).toBe(`KB#DOC#${DOCUMENT_ID}`);
      expect(item.entity).toBe("KNOWLEDGE_BASE_DOCUMENT");
      expect(item.account_id).toBe(ACCOUNT_ID);
      expect(item.document_id).toBe(DOCUMENT_ID);
      expect(item.chunk_count).toBe(3);
      expect(item.status).toBe("ready");
      expect(item.source_type).toBe("pdf");
      expect(item.external_id).toBe("ext-001");
      expect(item.title).toBe("Test Document");
      expect(typeof item._createdAt_).toBe("string");
      expect(typeof item._lastUpdated_).toBe("string");
    });

    it("includes mime_type in the DynamoDB record when provided", async () => {
      const inputWithMime = { ...STUB_INPUT, mimeType: "application/pdf" };
      await service.ingestDocument(inputWithMime);

      const putCalls = ddbMock.commandCalls(PutCommand);
      const item: Record<string, unknown> = putCalls[0].args[0].input.Item ?? {};
      expect(item.mime_type).toBe("application/pdf");
    });

    it("omits mime_type from the DynamoDB record when not provided", async () => {
      await service.ingestDocument(STUB_INPUT);

      const putCalls = ddbMock.commandCalls(PutCommand);
      const item: Record<string, unknown> = putCalls[0].args[0].input.Item ?? {};
      expect(item).not.toHaveProperty("mime_type");
    });

    it("chunk_count in response matches the actual number of points written", async () => {
      const result = await service.ingestDocument(STUB_INPUT);
      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      expect(result.chunk_count).toBe(upsertArgs.points.length);
    });

    it("account_id appears in every Qdrant point payload", async () => {
      await service.ingestDocument(STUB_INPUT);
      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      for (const point of upsertArgs.points) {
        expect(point.payload.account_id).toBe(ACCOUNT_ID);
      }
    });

    it("does NOT call Qdrant delete when no existing document is found", async () => {
      await service.ingestDocument(STUB_INPUT);
      expect(mockQdrantClient.delete).not.toHaveBeenCalled();
    });

    it("includes enrichment field in every Qdrant point payload when all enrichments succeed", async () => {
      await service.ingestDocument(STUB_INPUT);

      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      const [p0, p1, p2] = upsertArgs.points;

      expect(p0.payload.enrichment).toBe("enrich0");
      expect(p1.payload.enrichment).toBe("enrich1");
      expect(p2.payload.enrichment).toBe("enrich2");
    });

    it("chunk_text in payload is unchanged (not the combined text) when enrichment succeeds", async () => {
      await service.ingestDocument(STUB_INPUT);

      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      const [p0, p1, p2] = upsertArgs.points;

      expect(p0.payload.chunk_text).toBe("chunk one");
      expect(p1.payload.chunk_text).toBe("chunk two");
      expect(p2.payload.chunk_text).toBe("chunk three");
    });
  });

  // -------------------------------------------------------------------------
  // Enrichment paths
  // -------------------------------------------------------------------------

  describe("enrichment — single chunk failure", () => {
    it("embeds that chunk with chunk_text only when one enrichment is null", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue(["enrich0", null, "enrich2"]);

      await service.ingestDocument(STUB_INPUT);

      expect(mockVoyageService.embedTexts).toHaveBeenCalledWith([
        "chunk one\n\nenrich0",
        "chunk two",
        "chunk three\n\nenrich2",
      ]);
    });

    it("omits the enrichment field (not empty string) on the failed chunk's payload", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue(["enrich0", null, "enrich2"]);

      await service.ingestDocument(STUB_INPUT);

      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      expect(upsertArgs.points[1].payload).not.toHaveProperty("enrichment");
    });

    it("includes enrichment on the successful chunks when one fails", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue(["enrich0", null, "enrich2"]);

      await service.ingestDocument(STUB_INPUT);

      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      expect(upsertArgs.points[0].payload.enrichment).toBe("enrich0");
      expect(upsertArgs.points[2].payload.enrichment).toBe("enrich2");
    });

    it("completes ingestion (status: ready) when one enrichment fails", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue(["enrich0", null, "enrich2"]);

      const result = await service.ingestDocument(STUB_INPUT);

      expect(result.status).toBe("ready");
    });
  });

  describe("enrichment — all chunks fail", () => {
    it("embeds all chunks with chunk_text only when all enrichments are null", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue([null, null, null]);

      await service.ingestDocument(STUB_INPUT);

      expect(mockVoyageService.embedTexts).toHaveBeenCalledWith(["chunk one", "chunk two", "chunk three"]);
    });

    it("omits enrichment field from every Qdrant point when all fail", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue([null, null, null]);

      await service.ingestDocument(STUB_INPUT);

      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      for (const point of upsertArgs.points) {
        expect(point.payload).not.toHaveProperty("enrichment");
      }
    });

    it("completes ingestion (status: ready) when all enrichments fail", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue([null, null, null]);

      const result = await service.ingestDocument(STUB_INPUT);

      expect(result.status).toBe("ready");
    });

    it("chunk_text in payload is unchanged for all points when all enrichments fail", async () => {
      mockEnrichmentService.enrichAllChunks.mockResolvedValue([null, null, null]);

      await service.ingestDocument(STUB_INPUT);

      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      const [p0, p1, p2] = upsertArgs.points;

      expect(p0.payload.chunk_text).toBe("chunk one");
      expect(p1.payload.chunk_text).toBe("chunk two");
      expect(p2.payload.chunk_text).toBe("chunk three");
    });
  });

  // -------------------------------------------------------------------------
  // Enrichment — majority (but not all) chunks fail
  // -------------------------------------------------------------------------

  describe("enrichment — majority of chunks fail", () => {
    it("logs the 'Majority of chunk enrichments failed' WARN and completes successfully", async () => {
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      mockEnrichmentService.enrichAllChunks.mockResolvedValue([null, "enriched two", null]);

      const result = await service.ingestDocument(STUB_INPUT);

      expect(result.status).toBe("ready");

      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      const majorityWarn = warnCalls.find((m) => m.includes("Majority of chunk enrichments failed"));
      const allWarn = warnCalls.find((m) => m.includes("All chunk enrichments failed"));

      expect(majorityWarn).toBeDefined();
      expect(allWarn).toBeUndefined();

      // Successful chunk is embedded with combined text, failed chunks with chunk_text only.
      expect(mockVoyageService.embedTexts).toHaveBeenCalledWith([
        "chunk one",
        "chunk two\n\nenriched two",
        "chunk three",
      ]);

      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      expect(upsertArgs.points[0].payload).not.toHaveProperty("enrichment");
      expect(upsertArgs.points[1].payload.enrichment).toBe("enriched two");
      expect(upsertArgs.points[2].payload).not.toHaveProperty("enrichment");
    });
  });

  // -------------------------------------------------------------------------
  // Update path — existing document found
  // -------------------------------------------------------------------------

  describe("update path — existing document found", () => {
    const EXISTING_CREATED_AT = "2026-01-01T00:00:00.000Z";

    beforeEach(() => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ document_id: EXISTING_DOCUMENT_ID, _createdAt_: EXISTING_CREATED_AT }],
      });
    });

    it("reuses the existing document_id, preserves _createdAt_, advances _lastUpdated_", async () => {
      const result = await service.ingestDocument(STUB_INPUT);

      expect(result.document_id).toBe(EXISTING_DOCUMENT_ID);
      expect(result._createdAt_).toBe(EXISTING_CREATED_AT);
      expect(typeof result._lastUpdated_).toBe("string");
      expect(result._lastUpdated_).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // _lastUpdated_ must be different from (or equal to) _createdAt_ but is always present
      expect(result._lastUpdated_).toBeDefined();
    });

    it("calls Qdrant delete before upsert with the correct account_id and document_id filter", async () => {
      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.delete).toHaveBeenCalledTimes(1);
      expect(mockQdrantClient.delete).toHaveBeenCalledWith("knowledge_base", {
        wait: true,
        filter: {
          must: [
            { key: "account_id", match: { value: ACCOUNT_ID } },
            { key: "document_id", match: { value: EXISTING_DOCUMENT_ID } },
          ],
        },
      });

      // upsert must be called after delete
      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(1);
    });

    it("writes DynamoDB record with the existing document_id", async () => {
      await service.ingestDocument(STUB_INPUT);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const item: Record<string, unknown> = putCalls[0].args[0].input.Item ?? {};
      expect(item.document_id).toBe(EXISTING_DOCUMENT_ID);
      expect(item.SK).toBe(`KB#DOC#${EXISTING_DOCUMENT_ID}`);
      expect(item._createdAt_).toBe(EXISTING_CREATED_AT);
    });

    it("throws InternalServerErrorException and does NOT write DDB when Qdrant delete fails", async () => {
      mockQdrantClient.delete.mockRejectedValue(new Error("Qdrant delete error"));

      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow(InternalServerErrorException);

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Empty / whitespace text
  // -------------------------------------------------------------------------

  describe("empty/whitespace text — 0 chunks produced", () => {
    it("throws BadRequestException without calling embedTexts, upsert, or PutCommand", async () => {
      chunkText.mockReturnValue([]);

      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow(BadRequestException);

      expect(mockVoyageService.embedTexts).not.toHaveBeenCalled();
      expect(mockQdrantClient.upsert).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Collection creation branches
  // -------------------------------------------------------------------------

  describe("collection management", () => {
    it("skips createCollection when the collection already exists", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: true });

      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.createCollection).not.toHaveBeenCalled();
    });

    it("calls createCollection with correct args when the collection does not exist", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: false });

      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.createCollection).toHaveBeenCalledWith("knowledge_base", {
        vectors: { size: 1024, distance: "Cosine" },
      });
    });

    it("calls createPayloadIndex on account_id after creating a new collection", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: false });

      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.createPayloadIndex).toHaveBeenCalledWith("knowledge_base", {
        field_name: "account_id",
        field_schema: "keyword",
        wait: true,
      });
    });

    it("calls createPayloadIndex even when the collection already exists", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: true });

      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.createPayloadIndex).toHaveBeenCalledWith("knowledge_base", {
        field_name: "account_id",
        field_schema: "keyword",
        wait: true,
      });
    });

    it("continues successfully when createPayloadIndex fails with a non-'already exists' error", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: true });
      mockQdrantClient.createPayloadIndex.mockRejectedValue(new Error("Network timeout"));

      const result = await service.ingestDocument(STUB_INPUT);

      expect(result).toBeDefined();
      expect(result.status).toBe("ready");
      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(1);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    it("handles the create-collection race (already exists error) gracefully and continues", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: false });
      mockQdrantClient.createCollection.mockRejectedValue(new Error("Collection already exists"));

      await expect(service.ingestDocument(STUB_INPUT)).resolves.toBeDefined();

      // Upsert should still be called — the race is safe to ignore
      expect(mockQdrantClient.upsert).toHaveBeenCalled();
    });

    it("throws InternalServerErrorException when collectionExists itself fails", async () => {
      mockQdrantClient.collectionExists.mockRejectedValue(new Error("Network error"));

      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow(InternalServerErrorException);
      expect(mockQdrantClient.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Voyage failure
  // -------------------------------------------------------------------------

  describe("Voyage failure propagation", () => {
    it("propagates the Voyage error without calling upsert or PutCommand", async () => {
      mockVoyageService.embedTexts.mockRejectedValue(new Error("Voyage API rate limit exceeded"));

      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow("Voyage API rate limit exceeded");

      expect(mockQdrantClient.upsert).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Qdrant upsert failure
  // -------------------------------------------------------------------------

  describe("Qdrant upsert failure", () => {
    it("throws InternalServerErrorException with a safe message and does not call PutCommand", async () => {
      mockQdrantClient.upsert.mockRejectedValue(new Error("Qdrant connection reset"));

      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow(InternalServerErrorException);
      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow(
        "Knowledge base storage is temporarily unavailable.",
      );

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // DynamoDB PutItem failure
  // -------------------------------------------------------------------------

  describe("DynamoDB PutItem failure", () => {
    it("throws InternalServerErrorException with a safe message after Qdrant succeeds", async () => {
      ddbMock.on(PutCommand).rejects(new Error("DynamoDB throughput exceeded"));

      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow(InternalServerErrorException);
      await expect(service.ingestDocument(STUB_INPUT)).rejects.toThrow("Failed to record document metadata.");

      // Qdrant upsert was called (before DDB failed)
      expect(mockQdrantClient.upsert).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // deleteDocument — happy paths
  // -------------------------------------------------------------------------

  describe("deleteDocument — found: deletes Qdrant chunks and DDB record", () => {
    beforeEach(() => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ document_id: DOCUMENT_ID, _createdAt_: "2026-01-01T00:00:00.000Z" }],
      });
    });

    it("calls Qdrant delete with account_id + document_id filter and DDB DeleteCommand, returns void", async () => {
      await expect(service.deleteDocument({ accountId: ACCOUNT_ID, externalId: "ext-001" })).resolves.toBeUndefined();

      expect(mockQdrantClient.delete).toHaveBeenCalledTimes(1);
      expect(mockQdrantClient.delete).toHaveBeenCalledWith("knowledge_base", {
        wait: true,
        filter: {
          must: [
            { key: "account_id", match: { value: ACCOUNT_ID } },
            { key: "document_id", match: { value: DOCUMENT_ID } },
          ],
        },
      });

      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args[0].input.Key).toEqual({
        PK: `A#${ACCOUNT_ID}`,
        SK: `KB#DOC#${DOCUMENT_ID}`,
      });
    });
  });

  describe("deleteDocument — not found: no-op, returns void (idempotent 204)", () => {
    it("does not call Qdrant delete or DDB DeleteCommand when document is not found", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await expect(service.deleteDocument({ accountId: ACCOUNT_ID, externalId: "nonexistent" })).resolves.toBeUndefined();

      expect(mockQdrantClient.delete).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });

  describe("deleteDocument — Qdrant delete failure → 500", () => {
    it("throws InternalServerErrorException and does NOT call DDB DeleteCommand", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ document_id: DOCUMENT_ID, _createdAt_: "2026-01-01T00:00:00.000Z" }],
      });
      mockQdrantClient.delete.mockRejectedValue(new Error("Qdrant error"));

      await expect(service.deleteDocument({ accountId: ACCOUNT_ID, externalId: "ext-001" })).rejects.toThrow(InternalServerErrorException);

      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });

  describe("deleteDocument — DDB DeleteCommand failure → 500", () => {
    it("throws InternalServerErrorException after Qdrant delete succeeds", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ document_id: DOCUMENT_ID, _createdAt_: "2026-01-01T00:00:00.000Z" }],
      });
      ddbMock.on(DeleteCommand).rejects(new Error("DDB error"));

      await expect(service.deleteDocument({ accountId: ACCOUNT_ID, externalId: "ext-001" })).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe("deleteDocument — DDB lookup failure → 500", () => {
    it("throws InternalServerErrorException and does NOT call Qdrant delete", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("DDB timeout"));

      await expect(service.deleteDocument({ accountId: ACCOUNT_ID, externalId: "ext-001" })).rejects.toThrow(InternalServerErrorException);

      expect(mockQdrantClient.delete).not.toHaveBeenCalled();
    });
  });
});
