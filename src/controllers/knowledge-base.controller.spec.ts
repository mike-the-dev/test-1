import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { KnowledgeBaseController } from "./knowledge-base.controller";
import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { ZodValidationPipe } from "../pipes/knowledgeBaseValidation.pipe";
import { ingestDocumentSchema } from "../validation/knowledge-base.schema";
import type { IngestDocumentResult } from "../types/KnowledgeBase";

// Must be a valid 26-char Crockford base32 ULID (only [0-9A-HJKMNP-TV-Z] — no I, L, O, U).
const VALID_ACCOUNT_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_ACCOUNT_ULID_WITH_PREFIX = `A#${VALID_ACCOUNT_ULID}`;

const VALID_BODY = {
  accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
  externalId: "ext-doc-001",
  title: "My Document",
  text: "Some meaningful document text.",
  sourceType: "pdf" as const,
};

const STUB_RESULT: IngestDocumentResult = {
  documentUlid: "01TESTULID000000000000000A",
  chunkCount: 3,
  status: "ready",
  createdAt: "2026-04-21T00:00:00.000Z",
};

const mockIngestionService = {
  ingestDocument: jest.fn(),
};

describe("KnowledgeBaseController", () => {
  let controller: KnowledgeBaseController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockIngestionService.ingestDocument.mockResolvedValue(STUB_RESULT);

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
  // Happy path
  // -------------------------------------------------------------------------

  describe("POST /knowledge-base/documents — happy path", () => {
    it("calls ingestDocument with the raw accountUlid (A# prefix stripped)", async () => {
      await controller.ingestDocument(VALID_BODY);

      expect(mockIngestionService.ingestDocument).toHaveBeenCalledWith({
        accountUlid: VALID_ACCOUNT_ULID,
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

    it("response shape includes all four required fields", async () => {
      const result = await controller.ingestDocument(VALID_BODY);

      expect(result).toHaveProperty("documentUlid");
      expect(result).toHaveProperty("chunkCount");
      expect(result).toHaveProperty("status", "ready");
      expect(result).toHaveProperty("createdAt");
    });

    it("passes mimeType through to the service when provided", async () => {
      const bodyWithMime = { ...VALID_BODY, mimeType: "application/pdf" };
      await controller.ingestDocument(bodyWithMime);

      expect(mockIngestionService.ingestDocument).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: "application/pdf" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Validation pipe tests
  // -------------------------------------------------------------------------

  describe("ZodValidationPipe — ingestDocumentSchema", () => {
    const pipe = new ZodValidationPipe(ingestDocumentSchema);

    it("rejects a body with no accountUlid", () => {
      const { accountUlid: _removed, ...noAccount } = VALID_BODY;
      expect(() => pipe.transform(noAccount)).toThrow(BadRequestException);
    });

    it("rejects a bare accountUlid without the A# prefix", () => {
      expect(() =>
        pipe.transform({ ...VALID_BODY, accountUlid: VALID_ACCOUNT_ULID }),
      ).toThrow(BadRequestException);
    });

    it("rejects a body with no externalId", () => {
      const { externalId: _removed, ...noExternal } = VALID_BODY;
      expect(() => pipe.transform(noExternal)).toThrow(BadRequestException);
    });

    it("rejects an empty externalId", () => {
      expect(() => pipe.transform({ ...VALID_BODY, externalId: "" })).toThrow(BadRequestException);
    });

    it("rejects a body with no text", () => {
      const { text: _removed, ...noText } = VALID_BODY;
      expect(() => pipe.transform(noText)).toThrow(BadRequestException);
    });

    it("rejects an empty text string", () => {
      expect(() => pipe.transform({ ...VALID_BODY, text: "" })).toThrow(BadRequestException);
    });

    it("rejects an invalid sourceType", () => {
      expect(() =>
        pipe.transform({ ...VALID_BODY, sourceType: "jpg" }),
      ).toThrow(BadRequestException);
    });

    it("accepts all valid sourceType values", () => {
      for (const sourceType of ["pdf", "csv", "docx", "txt", "html"]) {
        expect(() => pipe.transform({ ...VALID_BODY, sourceType })).not.toThrow();
      }
    });

    it("accepts a body without mimeType (optional field)", () => {
      const { mimeType: _removed, ...noMime } = { ...VALID_BODY, mimeType: "application/pdf" };
      expect(() => pipe.transform(noMime)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe("error propagation", () => {
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
});
