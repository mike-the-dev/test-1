import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { KnowledgeBaseIngestionService } from "./knowledge-base-ingestion.service";
import { VoyageService } from "./voyage.service";
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
const ACCOUNT_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DOCUMENT_ULID = "01TESTULID000000000000000A";
const TABLE_NAME = "test-table";

const STUB_INPUT = {
  accountUlid: ACCOUNT_ULID,
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
};

// ---------------------------------------------------------------------------
// Voyage service mock
// ---------------------------------------------------------------------------

const mockVoyageService = {
  embedTexts: jest.fn(),
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

    ulid.mockReturnValue(DOCUMENT_ULID);

    // Default happy-path setup
    chunkText.mockReturnValue(STUB_CHUNKS);
    mockVoyageService.embedTexts.mockResolvedValue(STUB_EMBEDDINGS);
    mockQdrantClient.collectionExists.mockResolvedValue({ exists: true });
    mockQdrantClient.createCollection.mockResolvedValue(true);
    mockQdrantClient.createPayloadIndex.mockResolvedValue({});
    mockQdrantClient.upsert.mockResolvedValue({ status: "completed", operation_id: 1 });
    ddbMock.on(PutCommand).resolves({});

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
          provide: DatabaseConfigService,
          useValue: { conversationsTable: TABLE_NAME },
        },
      ],
    }).compile();

    service = module.get<KnowledgeBaseIngestionService>(KnowledgeBaseIngestionService);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe("happy path — 3 chunks in, 3 points out", () => {
    it("returns the correct result DTO", async () => {
      const result = await service.ingestDocument(STUB_INPUT);

      expect(result.documentUlid).toBe(DOCUMENT_ULID);
      expect(result.chunkCount).toBe(3);
      expect(result.status).toBe("ready");
      expect(typeof result.createdAt).toBe("string");
      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("calls embedTexts with the chunk texts in chunker order", async () => {
      await service.ingestDocument(STUB_INPUT);

      expect(mockVoyageService.embedTexts).toHaveBeenCalledWith(["chunk one", "chunk two", "chunk three"]);
    });

    it("upserts 3 points with correct payload fields including account_ulid and chunk_index", async () => {
      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(1);

      const upsertCall = mockQdrantClient.upsert.mock.calls[0];
      const collectionName = upsertCall[0];
      const upsertArgs = upsertCall[1];
      expect(collectionName).toBe("knowledge_base");
      expect(upsertArgs.wait).toBe(true);
      expect(upsertArgs.points).toHaveLength(3);

      const [p0, p1, p2] = upsertArgs.points;

      expect(p0.payload.account_ulid).toBe(ACCOUNT_ULID);
      expect(p0.payload.document_ulid).toBe(DOCUMENT_ULID);
      expect(p0.payload.chunk_index).toBe(0);
      expect(p0.payload.chunk_text).toBe("chunk one");
      expect(p0.payload.source_type).toBe("pdf");

      expect(p1.payload.chunk_index).toBe(1);
      expect(p2.payload.chunk_index).toBe(2);
    });

    it("writes a DynamoDB record with the correct pk, sk, and account_ulid", async () => {
      await service.ingestDocument(STUB_INPUT);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const item: Record<string, unknown> = putCalls[0].args[0].input.Item ?? {};
      expect(item.pk).toBe(`A#${ACCOUNT_ULID}`);
      expect(item.sk).toBe(`KB#DOC#${DOCUMENT_ULID}`);
      expect(item.entity).toBe("KB_DOCUMENT");
      expect(item.account_ulid).toBe(ACCOUNT_ULID);
      expect(item.document_ulid).toBe(DOCUMENT_ULID);
      expect(item.chunk_count).toBe(3);
      expect(item.status).toBe("ready");
      expect(item.source_type).toBe("pdf");
      expect(item.external_id).toBe("ext-001");
      expect(item.title).toBe("Test Document");
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

    it("chunkCount in response matches the actual number of points written", async () => {
      const result = await service.ingestDocument(STUB_INPUT);
      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      expect(result.chunkCount).toBe(upsertArgs.points.length);
    });

    it("account_ulid appears in every Qdrant point payload", async () => {
      await service.ingestDocument(STUB_INPUT);
      const upsertArgs = mockQdrantClient.upsert.mock.calls[0][1];
      for (const point of upsertArgs.points) {
        expect(point.payload.account_ulid).toBe(ACCOUNT_ULID);
      }
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

    it("calls createPayloadIndex on account_ulid after creating a new collection", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: false });

      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.createPayloadIndex).toHaveBeenCalledWith("knowledge_base", {
        field_name: "account_ulid",
        field_schema: "keyword",
        wait: true,
      });
    });

    it("does not call createPayloadIndex when the collection already exists", async () => {
      mockQdrantClient.collectionExists.mockResolvedValue({ exists: true });

      await service.ingestDocument(STUB_INPUT);

      expect(mockQdrantClient.createPayloadIndex).not.toHaveBeenCalled();
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
});
