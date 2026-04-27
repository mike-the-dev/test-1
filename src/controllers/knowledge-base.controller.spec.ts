import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";

import { KnowledgeBaseController } from "./knowledge-base.controller";
import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { ZodValidationPipe } from "../pipes/knowledgeBaseValidation.pipe";
import { ingestDocumentSchema, deleteDocumentSchema, getDocumentSchema } from "../validation/knowledge-base.schema";
import type { IngestDocumentBody, DeleteDocumentBody, GetDocumentQuery } from "../validation/knowledge-base.schema";
import type { KnowledgeBaseDocumentRecord } from "../types/KnowledgeBase";

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

// Valid 26-char Crockford base32 ULID (only [0-9A-HJKMNP-TV-Z]).
const VALID_ACCOUNT_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_ACCOUNT_ULID_WITH_PREFIX = `A#${VALID_ACCOUNT_ULID}`;
const DOCUMENT_ID = "01TESTULID000000000000000A";
const CREATED_AT = "2026-04-21T00:00:00.000Z";

// Mock ulid so the controller produces predictable IDs on the create path.
jest.mock("ulid", () => ({ ulid: jest.fn(() => DOCUMENT_ID) }));

const VALID_BODY = {
  account_id: VALID_ACCOUNT_ULID_WITH_PREFIX,
  external_id: "ext-doc-001",
  title: "My Document",
  text: "Some meaningful document text.",
  source_type: "pdf",
} satisfies IngestDocumentBody;

const VALID_DELETE_BODY = {
  account_id: VALID_ACCOUNT_ULID_WITH_PREFIX,
  external_id: "ext-doc-001",
} satisfies DeleteDocumentBody;

const VALID_GET_QUERY = {
  account_id: VALID_ACCOUNT_ULID_WITH_PREFIX,
  external_id: "ext-doc-001",
} satisfies GetDocumentQuery;

const STUB_READY_RECORD: KnowledgeBaseDocumentRecord = {
  PK: `A#${VALID_ACCOUNT_ULID}`,
  SK: `KB#DOC#${DOCUMENT_ID}`,
  entity: "KNOWLEDGE_BASE_DOCUMENT",
  document_id: DOCUMENT_ID,
  account_id: VALID_ACCOUNT_ULID,
  external_id: "ext-doc-001",
  title: "My Document",
  source_type: "pdf",
  chunk_count: 3,
  status: "ready",
  _createdAt_: CREATED_AT,
  _lastUpdated_: CREATED_AT,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockIngestionService = {
  lookupExistingDocument: jest.fn(),
  writePendingRecord: jest.fn(),
  deleteDocument: jest.fn(),
};

const mockQueue = {
  add: jest.fn(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("KnowledgeBaseController", () => {
  let controller: KnowledgeBaseController;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default: create path (no existing document)
    mockIngestionService.lookupExistingDocument.mockResolvedValue(null);
    mockIngestionService.writePendingRecord.mockResolvedValue(undefined);
    mockIngestionService.deleteDocument.mockResolvedValue(undefined);
    mockQueue.add.mockResolvedValue({ id: "job-1" });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [KnowledgeBaseController],
      providers: [
        {
          provide: KnowledgeBaseIngestionService,
          useValue: mockIngestionService,
        },
        {
          provide: getQueueToken("knowledge-base-ingestion"),
          useValue: mockQueue,
        },
      ],
    }).compile();

    controller = module.get<KnowledgeBaseController>(KnowledgeBaseController);
  });

  // -------------------------------------------------------------------------
  // Decorator metadata
  // -------------------------------------------------------------------------

  describe("decorator metadata", () => {
    it("returns 202 Accepted on POST", () => {
      const httpCode = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        KnowledgeBaseController.prototype.ingestDocument,
      );
      expect(httpCode).toBe(202);
    });

    it("returns 204 No Content on DELETE", () => {
      const httpCode = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        KnowledgeBaseController.prototype.deleteDocument,
      );
      expect(httpCode).toBe(204);
    });

    it("returns 200 on GET", () => {
      const httpCode = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        KnowledgeBaseController.prototype.getDocument,
      );
      expect(httpCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // POST — happy path (new document)
  // -------------------------------------------------------------------------

  describe("POST — happy path (create path)", () => {
    it("returns 202 shape: { document_id, status: pending, _createdAt_ }", async () => {
      const result = await controller.ingestDocument(VALID_BODY);

      expect(result.document_id).toBe(DOCUMENT_ID);
      expect(result.status).toBe("pending");
      expect(typeof result._createdAt_).toBe("string");
    });

    it("does NOT include chunk_count or _lastUpdated_ in the 202 response", async () => {
      const result = await controller.ingestDocument(VALID_BODY);

      expect(result).not.toHaveProperty("chunk_count");
      expect(result).not.toHaveProperty("_lastUpdated_");
    });

    it("calls lookupExistingDocument with the raw accountId (A# stripped)", async () => {
      await controller.ingestDocument(VALID_BODY);

      expect(mockIngestionService.lookupExistingDocument).toHaveBeenCalledWith(
        VALID_ACCOUNT_ULID,
        "ext-doc-001",
      );
    });

    it("calls writePendingRecord with generated documentId on the create path", async () => {
      await controller.ingestDocument(VALID_BODY);

      expect(mockIngestionService.writePendingRecord).toHaveBeenCalledWith(
        DOCUMENT_ID,
        VALID_ACCOUNT_ULID,
        expect.objectContaining({ externalId: "ext-doc-001", title: "My Document", sourceType: "pdf" }),
        expect.any(String),
      );
    });

    it("enqueues a job with attempts: 4 and exponential backoff", async () => {
      await controller.ingestDocument(VALID_BODY);

      expect(mockQueue.add).toHaveBeenCalledWith(
        "ingest",
        expect.objectContaining({ documentId: DOCUMENT_ID, accountId: VALID_ACCOUNT_ULID }),
        expect.objectContaining({
          attempts: 4,
          backoff: { type: "exponential", delay: 1000 },
        }),
      );
    });

    it("passes mimeType through to writePendingRecord and the job payload", async () => {
      const bodyWithMime = { ...VALID_BODY, mime_type: "application/pdf" };
      await controller.ingestDocument(bodyWithMime);

      expect(mockIngestionService.writePendingRecord).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ mimeType: "application/pdf" }),
        expect.any(String),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "ingest",
        expect.objectContaining({ mimeType: "application/pdf" }),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // POST — update path (existing document)
  // -------------------------------------------------------------------------

  describe("POST — update path (existing document)", () => {
    const EXISTING_DOCUMENT_ID = "01EXISTINGDOCID0000000000A";
    const EXISTING_CREATED_AT = "2026-01-01T00:00:00.000Z";

    beforeEach(() => {
      mockIngestionService.lookupExistingDocument.mockResolvedValue({
        ...STUB_READY_RECORD,
        document_id: EXISTING_DOCUMENT_ID,
        _createdAt_: EXISTING_CREATED_AT,
      } satisfies KnowledgeBaseDocumentRecord);
    });

    it("reuses the existing document_id in the 202 response", async () => {
      const result = await controller.ingestDocument(VALID_BODY);

      expect(result.document_id).toBe(EXISTING_DOCUMENT_ID);
    });

    it("preserves the existing _createdAt_ in the 202 response", async () => {
      const result = await controller.ingestDocument(VALID_BODY);

      expect(result._createdAt_).toBe(EXISTING_CREATED_AT);
    });

    it("enqueues the job with the reused documentId", async () => {
      await controller.ingestDocument(VALID_BODY);

      expect(mockQueue.add).toHaveBeenCalledWith(
        "ingest",
        expect.objectContaining({ documentId: EXISTING_DOCUMENT_ID }),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // POST — failure paths
  // -------------------------------------------------------------------------

  describe("POST — Redis enqueue failure → 503", () => {
    it("throws ServiceUnavailableException when queue.add() fails", async () => {
      mockQueue.add.mockRejectedValue(new Error("Redis ECONNREFUSED"));

      await expect(controller.ingestDocument(VALID_BODY)).rejects.toThrow(ServiceUnavailableException);
    });

    it("includes the safe message in the 503 response", async () => {
      mockQueue.add.mockRejectedValue(new Error("Redis ECONNREFUSED"));

      await expect(controller.ingestDocument(VALID_BODY)).rejects.toThrow(
        "Ingestion queue is temporarily unavailable. Please retry.",
      );
    });
  });

  describe("POST — DDB writePendingRecord failure → 500", () => {
    it("throws InternalServerErrorException when writePendingRecord fails", async () => {
      mockIngestionService.writePendingRecord.mockRejectedValue(
        new InternalServerErrorException("Failed to record document metadata."),
      );

      await expect(controller.ingestDocument(VALID_BODY)).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe("POST — DDB lookup failure → 500", () => {
    it("throws InternalServerErrorException when lookupExistingDocument fails", async () => {
      mockIngestionService.lookupExistingDocument.mockRejectedValue(
        new InternalServerErrorException("Knowledge base storage is temporarily unavailable."),
      );

      await expect(controller.ingestDocument(VALID_BODY)).rejects.toThrow(InternalServerErrorException);
    });
  });

  // -------------------------------------------------------------------------
  // GET — happy path
  // -------------------------------------------------------------------------

  describe("GET — document found", () => {
    it("returns the full record when status is ready", async () => {
      mockIngestionService.lookupExistingDocument.mockResolvedValue(STUB_READY_RECORD);

      const result = await controller.getDocument(VALID_GET_QUERY);

      expect(result.document_id).toBe(DOCUMENT_ID);
      expect(result.status).toBe("ready");
      expect(result.chunk_count).toBe(3);
      expect(result.account_id).toBe(VALID_ACCOUNT_ULID);
      expect(result.external_id).toBe("ext-doc-001");
    });

    it("returns a pending record without chunk_count", async () => {
      mockIngestionService.lookupExistingDocument.mockResolvedValue({
        ...STUB_READY_RECORD,
        status: "pending",
        chunk_count: undefined,
      } satisfies KnowledgeBaseDocumentRecord);

      const result = await controller.getDocument(VALID_GET_QUERY);

      expect(result.status).toBe("pending");
      expect(result).not.toHaveProperty("chunk_count");
    });

    it("returns a failed record with error_summary", async () => {
      mockIngestionService.lookupExistingDocument.mockResolvedValue({
        ...STUB_READY_RECORD,
        status: "failed",
        chunk_count: undefined,
        error_summary: "Processing failed after multiple retries. Please re-submit the document.",
      } satisfies KnowledgeBaseDocumentRecord);

      const result = await controller.getDocument(VALID_GET_QUERY);

      expect(result.status).toBe("failed");
      expect(result.error_summary).toBe("Processing failed after multiple retries. Please re-submit the document.");
    });

    it("omits mime_type from response when not present on the record", async () => {
      mockIngestionService.lookupExistingDocument.mockResolvedValue(STUB_READY_RECORD);

      const result = await controller.getDocument(VALID_GET_QUERY);

      expect(result).not.toHaveProperty("mime_type");
    });

    it("includes mime_type in response when present on the record", async () => {
      mockIngestionService.lookupExistingDocument.mockResolvedValue({
        ...STUB_READY_RECORD,
        mime_type: "application/pdf",
      });

      const result = await controller.getDocument(VALID_GET_QUERY);

      expect(result.mime_type).toBe("application/pdf");
    });
  });

  describe("GET — document not found → 404", () => {
    it("throws NotFoundException when lookupExistingDocument returns null", async () => {
      mockIngestionService.lookupExistingDocument.mockResolvedValue(null);

      await expect(controller.getDocument(VALID_GET_QUERY)).rejects.toThrow(NotFoundException);
    });
  });

  describe("GET — DDB error → 500", () => {
    it("throws InternalServerErrorException when the DDB lookup fails", async () => {
      mockIngestionService.lookupExistingDocument.mockRejectedValue(
        new InternalServerErrorException("Knowledge base storage is temporarily unavailable."),
      );

      await expect(controller.getDocument(VALID_GET_QUERY)).rejects.toThrow(InternalServerErrorException);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE — unchanged behavior
  // -------------------------------------------------------------------------

  describe("DELETE — unchanged (still synchronous, still 204)", () => {
    it("calls deleteDocument with raw accountId (A# stripped)", async () => {
      await controller.deleteDocument(VALID_DELETE_BODY);

      expect(mockIngestionService.deleteDocument).toHaveBeenCalledWith({
        accountId: VALID_ACCOUNT_ULID,
        externalId: "ext-doc-001",
      });
    });

    it("returns void (undefined)", async () => {
      const result = await controller.deleteDocument(VALID_DELETE_BODY);
      expect(result).toBeUndefined();
    });

    it("re-throws InternalServerErrorException from deleteDocument service", async () => {
      mockIngestionService.deleteDocument.mockRejectedValue(
        new InternalServerErrorException("Failed to delete document metadata."),
      );

      await expect(controller.deleteDocument(VALID_DELETE_BODY)).rejects.toThrow(InternalServerErrorException);
    });
  });

  // -------------------------------------------------------------------------
  // Validation pipe tests — POST
  // -------------------------------------------------------------------------

  describe("ZodValidationPipe — ingestDocumentSchema", () => {
    const pipe = new ZodValidationPipe(ingestDocumentSchema);

    it("rejects a body with no account_id", () => {
      const { account_id: _removed, ...noAccount } = VALID_BODY;
      expect(() => pipe.transform(noAccount)).toThrow(BadRequestException);
    });

    it("rejects a bare account_id without the A# prefix", () => {
      expect(() => pipe.transform({ ...VALID_BODY, account_id: VALID_ACCOUNT_ULID })).toThrow(BadRequestException);
    });

    it("rejects a body with no text", () => {
      const { text: _removed, ...noText } = VALID_BODY;
      expect(() => pipe.transform(noText)).toThrow(BadRequestException);
    });

    it("rejects an invalid source_type", () => {
      expect(() => pipe.transform({ ...VALID_BODY, source_type: "jpg" })).toThrow(BadRequestException);
    });

    it("accepts all valid source_type values", () => {
      for (const source_type of ["pdf", "csv", "docx", "txt", "html"]) {
        expect(() => pipe.transform({ ...VALID_BODY, source_type })).not.toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Validation pipe tests — DELETE
  // -------------------------------------------------------------------------

  describe("ZodValidationPipe — deleteDocumentSchema", () => {
    const pipe = new ZodValidationPipe(deleteDocumentSchema);

    it("rejects a body with no account_id", () => {
      const { account_id: _removed, ...noAccount } = VALID_DELETE_BODY;
      expect(() => pipe.transform(noAccount)).toThrow(BadRequestException);
    });

    it("rejects a body with no external_id", () => {
      const { external_id: _removed, ...noExternal } = VALID_DELETE_BODY;
      expect(() => pipe.transform(noExternal)).toThrow(BadRequestException);
    });

    it("accepts a valid delete body", () => {
      expect(() => pipe.transform(VALID_DELETE_BODY)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Validation pipe tests — GET
  // -------------------------------------------------------------------------

  describe("ZodValidationPipe — getDocumentSchema", () => {
    const pipe = new ZodValidationPipe(getDocumentSchema);

    it("rejects query params with no account_id", () => {
      const { account_id: _removed, ...noAccount } = VALID_GET_QUERY;
      expect(() => pipe.transform(noAccount)).toThrow(BadRequestException);
    });

    it("rejects a bare account_id without the A# prefix", () => {
      expect(() =>
        pipe.transform({ ...VALID_GET_QUERY, account_id: VALID_ACCOUNT_ULID }),
      ).toThrow(BadRequestException);
    });

    it("rejects query params with no external_id", () => {
      const { external_id: _removed, ...noExternal } = VALID_GET_QUERY;
      expect(() => pipe.transform(noExternal)).toThrow(BadRequestException);
    });

    it("rejects an empty external_id", () => {
      expect(() => pipe.transform({ ...VALID_GET_QUERY, external_id: "" })).toThrow(BadRequestException);
    });

    it("accepts a valid get query", () => {
      expect(() => pipe.transform(VALID_GET_QUERY)).not.toThrow();
    });
  });
});
