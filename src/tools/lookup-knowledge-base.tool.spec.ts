import { Test, TestingModule } from "@nestjs/testing";

import { LookupKnowledgeBaseTool } from "./lookup-knowledge-base.tool";
import { QDRANT_CLIENT } from "../providers/qdrant.provider";
import { VoyageService } from "../services/voyage.service";

const ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const SESSION_ULID = "01TESTSESSION0000000000000";

const MOCK_VECTOR = [0.1, 0.2, 0.3];

function makeScoredPoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    version: 1,
    score: 0.8932,
    payload: {
      account_ulid: ACCOUNT_ULID,
      document_ulid: "01DOCUMULID000000000000000",
      document_title: "Pet Care Emergency Policy V1",
      external_id: "pet-care-emergency",
      chunk_index: 3,
      chunk_text: "In case of emergency, contact the on-call vet immediately.",
      start_offset: 100,
      end_offset: 200,
      source_type: "pdf",
      created_at: "2024-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

async function buildModule(
  voyageMock: Partial<VoyageService>,
  qdrantMock: Record<string, unknown>,
): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      LookupKnowledgeBaseTool,
      {
        provide: QDRANT_CLIENT,
        useValue: qdrantMock,
      },
      {
        provide: VoyageService,
        useValue: voyageMock,
      },
    ],
  }).compile();
}

describe("LookupKnowledgeBaseTool", () => {
  let tool: LookupKnowledgeBaseTool;
  let voyageMock: { embedText: jest.Mock };
  let qdrantMock: { search: jest.Mock };

  const context = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

  beforeEach(async () => {
    voyageMock = { embedText: jest.fn().mockResolvedValue(MOCK_VECTOR) };
    qdrantMock = { search: jest.fn().mockResolvedValue([makeScoredPoint()]) };

    const module = await buildModule(voyageMock, qdrantMock);
    tool = module.get<LookupKnowledgeBaseTool>(LookupKnowledgeBaseTool);
  });

  describe("happy path — default top_k", () => {
    it("calls embedText with the query and search with limit=5 when top_k is omitted", async () => {
      const result = await tool.execute({ query: "what is the cancellation policy" }, context);

      expect(voyageMock.embedText).toHaveBeenCalledWith("what is the cancellation policy");

      expect(qdrantMock.search).toHaveBeenCalledWith(
        "knowledge_base",
        expect.objectContaining({
          vector: MOCK_VECTOR,
          filter: { must: [{ key: "account_ulid", match: { value: ACCOUNT_ULID } }] },
          limit: 5,
          with_payload: true,
        }),
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBe(1);
      expect(parsed.chunks).toHaveLength(1);
    });
  });

  describe("happy path — explicit top_k", () => {
    it("passes top_k=10 as limit to qdrant search", async () => {
      await tool.execute({ query: "refund policy", top_k: 10 }, context);

      expect(qdrantMock.search).toHaveBeenCalledWith(
        "knowledge_base",
        expect.objectContaining({ limit: 10 }),
      );
    });
  });

  describe("top_k passed through correctly", () => {
    it("calls search with limit=1 and returns exactly 1 chunk when top_k=1", async () => {
      qdrantMock.search.mockResolvedValue([makeScoredPoint()]);

      const result = await tool.execute({ query: "emergency protocol", top_k: 1 }, context);

      expect(qdrantMock.search).toHaveBeenCalledWith(
        "knowledge_base",
        expect.objectContaining({ limit: 1 }),
      );

      const parsed = JSON.parse(result.result);
      expect(parsed.chunks).toHaveLength(1);
    });
  });

  describe("result mapping", () => {
    it("maps ScoredPoint payload fields to KnowledgeBaseRetrievalChunk correctly", async () => {
      const point = makeScoredPoint({ score: 0.9512 });
      qdrantMock.search.mockResolvedValue([point]);

      const result = await tool.execute({ query: "policy question" }, context);

      const parsed = JSON.parse(result.result);
      const chunk = parsed.chunks[0];

      expect(chunk.text).toBe("In case of emergency, contact the on-call vet immediately.");
      expect(chunk.score).toBe(0.9512);
      expect(chunk.document_title).toBe("Pet Care Emergency Policy V1");
      expect(chunk.document_ulid).toBe("01DOCUMULID000000000000000");
      expect(chunk.chunk_index).toBe(3);
    });
  });

  describe("zero results from Qdrant", () => {
    it("returns chunks=[] and count=0 as a success (no isError)", async () => {
      qdrantMock.search.mockResolvedValue([]);

      const result = await tool.execute({ query: "obscure query with no match" }, context);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.chunks).toEqual([]);
      expect(parsed.count).toBe(0);
    });
  });

  describe("missing accountUlid", () => {
    it("returns isError when accountUlid is undefined without calling embedText or search", async () => {
      const result = await tool.execute({ query: "test query" }, { sessionUlid: SESSION_ULID });

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing account context");
      expect(voyageMock.embedText).not.toHaveBeenCalled();
      expect(qdrantMock.search).not.toHaveBeenCalled();
    });

    it("returns isError when accountUlid is empty string without calling embedText or search", async () => {
      const result = await tool.execute({ query: "test query" }, { sessionUlid: SESSION_ULID, accountUlid: "" });

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing account context");
      expect(voyageMock.embedText).not.toHaveBeenCalled();
      expect(qdrantMock.search).not.toHaveBeenCalled();
    });
  });

  describe("invalid input — empty query", () => {
    it("returns isError with validation message when query is empty string", async () => {
      const result = await tool.execute({ query: "" }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Invalid input");
      expect(voyageMock.embedText).not.toHaveBeenCalled();
      expect(qdrantMock.search).not.toHaveBeenCalled();
    });
  });

  describe("invalid input — top_k out of range", () => {
    it("returns isError when top_k=0 (below minimum)", async () => {
      const result = await tool.execute({ query: "test", top_k: 0 }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Invalid input");
      expect(voyageMock.embedText).not.toHaveBeenCalled();
      expect(qdrantMock.search).not.toHaveBeenCalled();
    });

    it("returns isError when top_k=21 (above maximum)", async () => {
      const result = await tool.execute({ query: "test", top_k: 21 }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Invalid input");
      expect(voyageMock.embedText).not.toHaveBeenCalled();
      expect(qdrantMock.search).not.toHaveBeenCalled();
    });
  });

  describe("invalid input — unknown key", () => {
    it("returns isError when input contains an unknown key (strict mode)", async () => {
      const result = await tool.execute({ query: "test", extra_field: "x" }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Invalid input");
      expect(voyageMock.embedText).not.toHaveBeenCalled();
      expect(qdrantMock.search).not.toHaveBeenCalled();
    });
  });

  describe("Voyage throws", () => {
    it("returns unavailability message and does not call search when embedText throws", async () => {
      const voyageError = Object.assign(new Error("Voyage API rate limit exceeded"), {
        name: "RateLimitError",
      });
      voyageMock.embedText.mockRejectedValue(voyageError);

      const loggerErrorSpy = jest.spyOn((tool as unknown as { logger: { error: jest.Mock } }).logger, "error");

      const result = await tool.execute({ query: "some query" }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Knowledge base is temporarily unavailable");
      expect(qdrantMock.search).not.toHaveBeenCalled();

      expect(loggerErrorSpy).toHaveBeenCalled();
      const loggedMessage: string = loggerErrorSpy.mock.calls[0][0];
      expect(loggedMessage).toContain("RateLimitError");
      expect(loggedMessage).not.toContain("Voyage API rate limit exceeded");
    });
  });

  describe("Qdrant throws", () => {
    it("returns unavailability message when search throws after embedText succeeds", async () => {
      const qdrantError = Object.assign(new Error("connection refused"), {
        name: "ConnectionError",
      });
      qdrantMock.search.mockRejectedValue(qdrantError);

      const loggerErrorSpy = jest.spyOn((tool as unknown as { logger: { error: jest.Mock } }).logger, "error");

      const result = await tool.execute({ query: "some query" }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Knowledge base is temporarily unavailable");

      expect(voyageMock.embedText).toHaveBeenCalledTimes(1);

      expect(loggerErrorSpy).toHaveBeenCalled();
      const loggedMessage: string = loggerErrorSpy.mock.calls[0][0];
      expect(loggedMessage).toContain("ConnectionError");
      expect(loggedMessage).not.toContain("connection refused");
    });
  });
});
