import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { UnrecoverableError } from "bullmq";

import { KnowledgeBaseIngestionProcessor } from "./knowledge-base-ingestion.processor";
import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { KnowledgeBaseJobPayload } from "../types/KnowledgeBase";

// ---------------------------------------------------------------------------
// Module-level mocks — BullMQ decorators are no-ops in test context
// ---------------------------------------------------------------------------

// WorkerHost base class has no runnable logic; mock it so the processor class
// doesn't need a real BullMQ worker connection.
jest.mock("@nestjs/bullmq", () => ({
  Processor: () => () => {},
  WorkerHost: class {
    worker = undefined;
  },
  OnWorkerEvent: () => () => {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeJob = (overrides: Partial<{ attemptsMade: number; id: string }> = {}) => ({
  id: overrides.id ?? "job-1",
  attemptsMade: overrides.attemptsMade ?? 0,
  data: {
    documentId: "doc-id-001",
    accountId: "acct-id-001",
    externalId: "ext-001",
    title: "Test Document",
    text: "Some text content.",
    sourceType: "pdf",
    createdAt: "2026-01-01T00:00:00.000Z",
  } satisfies KnowledgeBaseJobPayload,
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockIngestionService = {
  updateDocumentStatus: jest.fn(),
  ingestDocument: jest.fn(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("KnowledgeBaseIngestionProcessor", () => {
  let processor: KnowledgeBaseIngestionProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KnowledgeBaseIngestionProcessor,
        {
          provide: KnowledgeBaseIngestionService,
          useValue: mockIngestionService,
        },
      ],
    }).compile();

    processor = module.get<KnowledgeBaseIngestionProcessor>(KnowledgeBaseIngestionProcessor);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe("happy path", () => {
    it("transitions to processing, calls ingestDocument, and does NOT write failed status", async () => {
      mockIngestionService.updateDocumentStatus.mockResolvedValue(undefined);
      mockIngestionService.ingestDocument.mockResolvedValue({
        document_id: "doc-id-001",
        chunk_count: 3,
        status: "ready",
        _createdAt_: "2026-01-01T00:00:00.000Z",
        _lastUpdated_: "2026-01-01T00:01:00.000Z",
      });

      const job = makeJob();
      await processor.process(job as never);

      expect(mockIngestionService.updateDocumentStatus).toHaveBeenCalledTimes(1);
      expect(mockIngestionService.updateDocumentStatus).toHaveBeenCalledWith("acct-id-001", "doc-id-001", "processing");
      expect(mockIngestionService.ingestDocument).toHaveBeenCalledTimes(1);
      expect(mockIngestionService.ingestDocument).toHaveBeenCalledWith({
        accountId: "acct-id-001",
        externalId: "ext-001",
        title: "Test Document",
        text: "Some text content.",
        sourceType: "pdf",
        mimeType: undefined,
      });
    });

    it("passes mimeType to ingestDocument when present in job payload", async () => {
      mockIngestionService.updateDocumentStatus.mockResolvedValue(undefined);
      mockIngestionService.ingestDocument.mockResolvedValue({ status: "ready" });

      const job = makeJob();
      job.data = { ...job.data, mimeType: "application/pdf" };
      await processor.process(job as never);

      expect(mockIngestionService.ingestDocument).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: "application/pdf" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Transient failure — retryable
  // -------------------------------------------------------------------------

  describe("transient failure — retryable", () => {
    it("re-throws InternalServerErrorException to let BullMQ retry (not the final attempt)", async () => {
      const transientError = new Error("Voyage API unavailable");
      mockIngestionService.updateDocumentStatus.mockResolvedValue(undefined);
      mockIngestionService.ingestDocument.mockRejectedValue(transientError);

      const job = makeJob({ attemptsMade: 0 }); // attempt 1 of 4

      await expect(processor.process(job as never)).rejects.toThrow("Voyage API unavailable");

      // Not the final attempt — should NOT write failed status
      expect(mockIngestionService.updateDocumentStatus).toHaveBeenCalledTimes(1);
      expect(mockIngestionService.updateDocumentStatus).toHaveBeenCalledWith("acct-id-001", "doc-id-001", "processing");
    });

    it("writes failed status with generic message on the final retry attempt", async () => {
      const transientError = new Error("Qdrant unavailable");
      mockIngestionService.updateDocumentStatus.mockResolvedValue(undefined);
      mockIngestionService.ingestDocument.mockRejectedValue(transientError);

      const job = makeJob({ attemptsMade: 3 }); // attempt 4 of 4 (final)

      await expect(processor.process(job as never)).rejects.toThrow("Qdrant unavailable");

      expect(mockIngestionService.updateDocumentStatus).toHaveBeenCalledTimes(2);
      expect(mockIngestionService.updateDocumentStatus).toHaveBeenNthCalledWith(1, "acct-id-001", "doc-id-001", "processing");
      expect(mockIngestionService.updateDocumentStatus).toHaveBeenNthCalledWith(
        2,
        "acct-id-001",
        "doc-id-001",
        "failed",
        "Processing failed after multiple retries. Please re-submit the document.",
      );
    });

    it("error_summary on final failure is a string, never a raw Error object", async () => {
      mockIngestionService.updateDocumentStatus.mockResolvedValue(undefined);
      mockIngestionService.ingestDocument.mockRejectedValue(new Error("Raw internal error with API key: sk-xyz"));

      const job = makeJob({ attemptsMade: 3 }); // final attempt

      await expect(processor.process(job as never)).rejects.toThrow();

      const failedCall = mockIngestionService.updateDocumentStatus.mock.calls.find(
        (call) => call[2] === "failed",
      );
      expect(failedCall).toBeDefined();
      const errorSummaryArg = failedCall![3];
      expect(typeof errorSummaryArg).toBe("string");
      // Generic message — does NOT include the raw error message
      expect(errorSummaryArg).not.toContain("sk-xyz");
      expect(errorSummaryArg).not.toContain("Raw internal error");
    });
  });

  // -------------------------------------------------------------------------
  // Validation failure — non-retryable (BadRequestException)
  // -------------------------------------------------------------------------

  describe("validation failure — BadRequestException throws UnrecoverableError", () => {
    it("writes failed status with the validation error message and throws UnrecoverableError", async () => {
      const validationError = new BadRequestException(
        "Document text produced no content after chunking. Ensure the text field is not empty or whitespace-only.",
      );
      mockIngestionService.updateDocumentStatus.mockResolvedValue(undefined);
      mockIngestionService.ingestDocument.mockRejectedValue(validationError);

      const job = makeJob({ attemptsMade: 0 });

      await expect(processor.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(mockIngestionService.updateDocumentStatus).toHaveBeenCalledTimes(2);
      expect(mockIngestionService.updateDocumentStatus).toHaveBeenNthCalledWith(1, "acct-id-001", "doc-id-001", "processing");
      expect(mockIngestionService.updateDocumentStatus).toHaveBeenNthCalledWith(
        2,
        "acct-id-001",
        "doc-id-001",
        "failed",
        expect.any(String),
      );
    });

    it("error_summary for validation failure is a safe string, not a raw Error object", async () => {
      const validationError = new BadRequestException("Document text produced no content after chunking.");
      mockIngestionService.updateDocumentStatus.mockResolvedValue(undefined);
      mockIngestionService.ingestDocument.mockRejectedValue(validationError);

      const job = makeJob({ attemptsMade: 0 });

      await expect(processor.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);

      const failedCall = mockIngestionService.updateDocumentStatus.mock.calls.find(
        (call) => call[2] === "failed",
      );
      expect(typeof failedCall![3]).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // updateDocumentStatus("processing") fails
  // -------------------------------------------------------------------------

  describe("updateDocumentStatus processing transition fails", () => {
    it("throws without calling ingestDocument when the processing status update fails", async () => {
      mockIngestionService.updateDocumentStatus.mockRejectedValue(new Error("DDB error"));

      const job = makeJob();

      await expect(processor.process(job as never)).rejects.toThrow("DDB error");

      expect(mockIngestionService.ingestDocument).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // @OnWorkerEvent('failed') lifecycle handler
  // -------------------------------------------------------------------------

  describe("@OnWorkerEvent('failed') — onFailed", () => {
    it("does not throw and handles the event gracefully", () => {
      const job = makeJob();
      const error = new Error("Qdrant unavailable");

      expect(() => processor.onFailed(job as never, error)).not.toThrow();
    });
  });
});
