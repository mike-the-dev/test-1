import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { Test, TestingModule } from "@nestjs/testing";

import { KnowledgeBaseController } from "./knowledge-base.controller";
import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { ZodValidationPipe } from "../pipes/knowledgeBaseValidation.pipe";
import { ingestDocumentSchema, deleteDocumentSchema } from "../validation/knowledge-base.schema";
import type { IngestDocumentBody, DeleteDocumentBody } from "../validation/knowledge-base.schema";
import type { KnowledgeBaseIngestDocumentResult } from "../types/KnowledgeBase";

// Must be a valid 26-char Crockford base32 ULID (only [0-9A-HJKMNP-TV-Z] — no I, L, O, U).
const VALID_ACCOUNT_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_ACCOUNT_ULID_WITH_PREFIX = `A#${VALID_ACCOUNT_ULID}`;

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

const STUB_RESULT = {
  document_id: "01TESTULID000000000000000A",
  chunk_count: 3,
  status: "ready",
  _createdAt_: "2026-04-21T00:00:00.000Z",
  _lastUpdated_: "2026-04-21T00:00:00.000Z",
} satisfies KnowledgeBaseIngestDocumentResult;

const mockIngestionService = {
  ingestDocument: jest.fn(),
  deleteDocument: jest.fn(),
};

describe("KnowledgeBaseController", () => {
  let controller: KnowledgeBaseController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockIngestionService.ingestDocument.mockResolvedValue(STUB_RESULT);
    mockIngestionService.deleteDocument.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [KnowledgeBaseController],
      providers: [
        {
          provide: KnowledgeBaseIngestionService,
          useValue: mockIngestionService,
        },
      ],
    }).compile();

    controller = module.get<KnowledgeBaseController>(KnowledgeBaseController);
  });

  // -------------------------------------------------------------------------
  // Decorator metadata
  // -------------------------------------------------------------------------

  describe("decorator metadata", () => {
    it("returns 201 Created on POST success", () => {
      const httpCode = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        KnowledgeBaseController.prototype.ingestDocument,
      );
      expect(httpCode).toBe(201);
    });

    it("returns 204 No Content on DELETE success", () => {
      const httpCode = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        KnowledgeBaseController.prototype.deleteDocument,
      );
      expect(httpCode).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  // POST — happy path
  // -------------------------------------------------------------------------

  describe("POST /knowledge-base/documents — happy path", () => {
    it("calls ingestDocument with the raw accountId (A# prefix stripped)", async () => {
      await controller.ingestDocument(VALID_BODY);

      expect(mockIngestionService.ingestDocument).toHaveBeenCalledWith({
        accountId: VALID_ACCOUNT_ULID,
        externalId: "ext-doc-001",
        title: "My Document",
        text: "Some meaningful document text.",
        sourceType: "pdf",
        mimeType: undefined,
      });
    });

    it("returns the service result directly", async () => {
      const result = await controller.ingestDocument(VALID_BODY);

      expect(result).toEqual(STUB_RESULT);
    });

    it("response shape includes all five required fields", async () => {
      const result = await controller.ingestDocument(VALID_BODY);

      expect(result).toHaveProperty("document_id");
      expect(result).toHaveProperty("chunk_count");
      expect(result).toHaveProperty("status", "ready");
      expect(result).toHaveProperty("_createdAt_");
      expect(result).toHaveProperty("_lastUpdated_");
    });

    it("passes mime_type through to the service when provided", async () => {
      const bodyWithMime = { ...VALID_BODY, mime_type: "application/pdf" };
      await controller.ingestDocument(bodyWithMime);

      expect(mockIngestionService.ingestDocument).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: "application/pdf" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // DELETE — happy path
  // -------------------------------------------------------------------------

  describe("DELETE /knowledge-base/documents — happy path", () => {
    it("calls deleteDocument with the raw accountId (A# prefix stripped)", async () => {
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
      expect(() =>
        pipe.transform({ ...VALID_BODY, account_id: VALID_ACCOUNT_ULID }),
      ).toThrow(BadRequestException);
    });

    it("rejects a body with no external_id", () => {
      const { external_id: _removed, ...noExternal } = VALID_BODY;
      expect(() => pipe.transform(noExternal)).toThrow(BadRequestException);
    });

    it("rejects an empty external_id", () => {
      expect(() => pipe.transform({ ...VALID_BODY, external_id: "" })).toThrow(BadRequestException);
    });

    it("rejects a body with no text", () => {
      const { text: _removed, ...noText } = VALID_BODY;
      expect(() => pipe.transform(noText)).toThrow(BadRequestException);
    });

    it("rejects an empty text string", () => {
      expect(() => pipe.transform({ ...VALID_BODY, text: "" })).toThrow(BadRequestException);
    });

    it("rejects an invalid source_type", () => {
      expect(() =>
        pipe.transform({ ...VALID_BODY, source_type: "jpg" }),
      ).toThrow(BadRequestException);
    });

    it("accepts all valid source_type values", () => {
      for (const source_type of ["pdf", "csv", "docx", "txt", "html"]) {
        expect(() => pipe.transform({ ...VALID_BODY, source_type })).not.toThrow();
      }
    });

    it("accepts a body without mime_type (optional field)", () => {
      const { mime_type: _removed, ...noMime } = { ...VALID_BODY, mime_type: "application/pdf" };
      expect(() => pipe.transform(noMime)).not.toThrow();
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

    it("rejects a bare account_id without the A# prefix", () => {
      expect(() =>
        pipe.transform({ ...VALID_DELETE_BODY, account_id: VALID_ACCOUNT_ULID }),
      ).toThrow(BadRequestException);
    });

    it("rejects a body with no external_id", () => {
      const { external_id: _removed, ...noExternal } = VALID_DELETE_BODY;
      expect(() => pipe.transform(noExternal)).toThrow(BadRequestException);
    });

    it("rejects an empty external_id", () => {
      expect(() => pipe.transform({ ...VALID_DELETE_BODY, external_id: "" })).toThrow(BadRequestException);
    });

    it("accepts a valid delete body", () => {
      expect(() => pipe.transform(VALID_DELETE_BODY)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe("error propagation — POST", () => {
    it("re-throws BadRequestException from the service (0 chunks)", async () => {
      mockIngestionService.ingestDocument.mockRejectedValue(
        new BadRequestException("Document text produced no content after chunking."),
      );

      await expect(controller.ingestDocument(VALID_BODY)).rejects.toThrow(BadRequestException);
    });

    it("re-throws InternalServerErrorException from the service", async () => {
      mockIngestionService.ingestDocument.mockRejectedValue(
        new InternalServerErrorException("Knowledge base storage is temporarily unavailable."),
      );

      await expect(controller.ingestDocument(VALID_BODY)).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe("error propagation — DELETE", () => {
    it("re-throws InternalServerErrorException from deleteDocument service", async () => {
      mockIngestionService.deleteDocument.mockRejectedValue(
        new InternalServerErrorException("Knowledge base storage is temporarily unavailable."),
      );

      await expect(controller.deleteDocument(VALID_DELETE_BODY)).rejects.toThrow(InternalServerErrorException);
    });
  });
});
