import { Test, TestingModule } from "@nestjs/testing";
import Anthropic from "@anthropic-ai/sdk";

import {
  KnowledgeBaseEnrichmentService,
  ENRICHMENT_PROMPT,
  ENRICHMENT_MAX_TOKENS,
  ENRICHMENT_CONCURRENCY_CAP,
} from "./knowledge-base-enrichment.service";
import { AnthropicConfigService } from "./anthropic-config.service";

// ---------------------------------------------------------------------------
// Module-level mock for the Anthropic SDK
// ---------------------------------------------------------------------------

const mockMessagesCreate = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  const mockConstructor = jest.fn().mockImplementation(() => ({
    messages: {
      create: mockMessagesCreate,
    },
  }));

  // Attach error classes to the constructor so `instanceof Anthropic.APIError` works.
  class MockAPIError extends Error {
    status: number;
    type: string | null;
    constructor(message: string, status: number) {
      super(message);
      this.name = "APIError";
      this.status = status;
      this.type = null;
    }
  }

  class MockRateLimitError extends MockAPIError {
    constructor() {
      super("Rate limit exceeded", 429);
      this.name = "RateLimitError";
    }
  }

  mockConstructor.APIError = MockAPIError;
  mockConstructor.RateLimitError = MockRateLimitError;

  return { __esModule: true, default: mockConstructor };
});

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

const STUB_MODEL = "claude-sonnet-test";

const VALID_ENRICHMENT_TEXT =
  "SUMMARY:\nThis passage covers dog walking services.\n\nQUESTIONS:\n- What walking services are available?\n- How often are dogs walked?\n\nKEY TERMS:\ndog walking, pet care, exercise, daily walks, walker";

const STUB_CHUNKS = [
  { text: "chunk one", index: 0, startOffset: 0, endOffset: 9 },
  { text: "chunk two", index: 1, startOffset: 10, endOffset: 19 },
  { text: "chunk three", index: 2, startOffset: 20, endOffset: 31 },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("KnowledgeBaseEnrichmentService", () => {
  let service: KnowledgeBaseEnrichmentService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KnowledgeBaseEnrichmentService,
        {
          provide: AnthropicConfigService,
          useValue: {
            apiKey: "test-api-key",
            model: STUB_MODEL,
          },
        },
      ],
    }).compile();

    service = module.get<KnowledgeBaseEnrichmentService>(KnowledgeBaseEnrichmentService);
  });

  // -------------------------------------------------------------------------
  // enrichChunk — happy path
  // -------------------------------------------------------------------------

  describe("enrichChunk — happy path", () => {
    it("returns trimmed enrichment string on success", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: `  ${VALID_ENRICHMENT_TEXT}  ` }],
      });

      const result = await service.enrichChunk("chunk text", 0);

      expect(result).toBe(VALID_ENRICHMENT_TEXT);
    });

    it("passes the prompt verbatim concatenated with chunk text", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: VALID_ENRICHMENT_TEXT }],
      });

      await service.enrichChunk("my chunk text", 0);

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockMessagesCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content).toBe(ENRICHMENT_PROMPT + "my chunk text");
    });

    it("uses the configured model and ENRICHMENT_MAX_TOKENS", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: VALID_ENRICHMENT_TEXT }],
      });

      await service.enrichChunk("chunk text", 0);

      const callArgs = mockMessagesCreate.mock.calls[0][0];
      expect(callArgs.model).toBe(STUB_MODEL);
      expect(callArgs.max_tokens).toBe(ENRICHMENT_MAX_TOKENS);
    });

    it("does not include system or tools in the SDK call", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: VALID_ENRICHMENT_TEXT }],
      });

      await service.enrichChunk("chunk text", 0);

      const callArgs = mockMessagesCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("system");
      expect(callArgs).not.toHaveProperty("tools");
    });
  });

  // -------------------------------------------------------------------------
  // enrichChunk — parse failures
  // -------------------------------------------------------------------------

  describe("enrichChunk — parse failures → null", () => {
    it("returns null when SUMMARY section is missing", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: "QUESTIONS:\n- Q1\n\nKEY TERMS:\nterm1" }],
      });

      const result = await service.enrichChunk("chunk text", 0);
      expect(result).toBeNull();
    });

    it("returns null when QUESTIONS section is missing", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: "SUMMARY:\nSummary text\n\nKEY TERMS:\nterm1" }],
      });

      const result = await service.enrichChunk("chunk text", 0);
      expect(result).toBeNull();
    });

    it("returns null when KEY TERMS section is missing", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: "SUMMARY:\nSummary text\n\nQUESTIONS:\n- Q1" }],
      });

      const result = await service.enrichChunk("chunk text", 0);
      expect(result).toBeNull();
    });

    it("returns null when content[0] is not a text block", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "tool_use", id: "tool-1", name: "some_tool", input: {} }],
      });

      const result = await service.enrichChunk("chunk text", 0);
      expect(result).toBeNull();
    });

    it("returns null when content array is empty", async () => {
      mockMessagesCreate.mockResolvedValue({ content: [] });

      const result = await service.enrichChunk("chunk text", 0);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // enrichChunk — API errors → null, no throw
  // -------------------------------------------------------------------------

  describe("enrichChunk — API errors → null, no throw", () => {
    it("returns null (does not throw) on RateLimitError (429)", async () => {
      // The module mock defines RateLimitError on the constructor itself — reach it via
      // jest.requireMock so we avoid a dynamic import (not supported in this Jest config).
      const MockAnthropic = jest.requireMock<{ default: { RateLimitError: new () => Error } }>(
        "@anthropic-ai/sdk",
      ).default;
      mockMessagesCreate.mockRejectedValue(new MockAnthropic.RateLimitError());

      const result = await service.enrichChunk("chunk text", 2);
      expect(result).toBeNull();
    });

    it("returns null (does not throw) on generic network error", async () => {
      mockMessagesCreate.mockRejectedValue(new Error("network timeout"));

      const result = await service.enrichChunk("chunk text", 3);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // enrichAllChunks
  // -------------------------------------------------------------------------

  describe("enrichAllChunks", () => {
    it("returns empty array immediately when given zero chunks", async () => {
      const result = await service.enrichAllChunks([]);

      expect(result).toEqual([]);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("returns index-aligned results when all chunks succeed", async () => {
      mockMessagesCreate
        .mockResolvedValueOnce({ content: [{ type: "text", text: "SUMMARY:\ns0\n\nQUESTIONS:\n- Q\n\nKEY TERMS:\nt" }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "SUMMARY:\ns1\n\nQUESTIONS:\n- Q\n\nKEY TERMS:\nt" }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "SUMMARY:\ns2\n\nQUESTIONS:\n- Q\n\nKEY TERMS:\nt" }] });

      const result = await service.enrichAllChunks(STUB_CHUNKS);

      expect(result).toHaveLength(3);
      expect(result[0]).toContain("s0");
      expect(result[1]).toContain("s1");
      expect(result[2]).toContain("s2");
    });

    it("returns null at the failed index when one chunk fails", async () => {
      mockMessagesCreate
        .mockResolvedValueOnce({ content: [{ type: "text", text: "SUMMARY:\ns0\n\nQUESTIONS:\n- Q\n\nKEY TERMS:\nt" }] })
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "SUMMARY:\ns2\n\nQUESTIONS:\n- Q\n\nKEY TERMS:\nt" }] });

      const result = await service.enrichAllChunks(STUB_CHUNKS);

      expect(result).toHaveLength(3);
      expect(result[0]).not.toBeNull();
      expect(result[1]).toBeNull();
      expect(result[2]).not.toBeNull();
    });

    it("respects the concurrency cap — no more than ENRICHMENT_CONCURRENCY_CAP calls inflight at once", async () => {
      const totalChunks = 10;
      const chunks = Array.from({ length: totalChunks }, (_element, index) => {
        return {
          text: `chunk ${index}`,
          index,
          startOffset: index * 10,
          endOffset: index * 10 + 9,
        };
      });

      let inflight = 0;
      let maxInflight = 0;

      const resolvers: ((value: void) => void)[] = [];

      mockMessagesCreate.mockImplementation(() => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);

        return new Promise<{ content: { type: string; text: string }[] }>((resolve) => {
          resolvers.push(() => {
            inflight--;
            resolve({ content: [{ type: "text", text: "SUMMARY:\ns\n\nQUESTIONS:\n- Q\n\nKEY TERMS:\nt" }] });
          });
        });
      });

      const enrichPromise = service.enrichAllChunks(chunks);

      // Drain resolvers in batches to allow the concurrency pool to run
      await new Promise<void>((resolve) => setImmediate(resolve));
      while (resolvers.length > 0) {
        resolvers.shift()!();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      await enrichPromise;

      expect(maxInflight).toBeLessThanOrEqual(ENRICHMENT_CONCURRENCY_CAP);
    });
  });
});
