import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { VoyageAIClient, VoyageAIError } from "voyageai";

import { VoyageService } from "./voyage.service";
import { VoyageConfigService } from "./voyage-config.service";

jest.mock("voyageai", () => {
  class MockVoyageAIError extends Error {
    statusCode?: number;
    body?: unknown;
    constructor(message: string, statusCode?: number, body?: unknown) {
      super(message);
      this.statusCode = statusCode;
      this.body = body;
    }
  }
  return {
    VoyageAIClient: jest.fn(),
    VoyageAIError: MockVoyageAIError,
  };
});

const MockVoyageAIClient = jest.mocked(VoyageAIClient);

function buildMockVoyageConfigService(apiKey?: string, model = "voyage-3"): Partial<VoyageConfigService> {
  return {
    get apiKey() {
      return apiKey;
    },
    get model() {
      return model;
    },
  };
}

async function buildModule(configService: Partial<VoyageConfigService>): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      VoyageService,
      {
        provide: VoyageConfigService,
        useValue: configService,
      },
    ],
  }).compile();
}

describe("VoyageService", () => {
  let service: VoyageService;
  let embedMock: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    embedMock = jest.fn();
    MockVoyageAIClient.mockImplementation(() => {
      const instance = Object.create(MockVoyageAIClient.prototype);
      instance.embed = embedMock;
      return instance;
    });

    const module = await buildModule(buildMockVoyageConfigService("test-api-key"));
    service = module.get<VoyageService>(VoyageService);
  });

  describe("embedText", () => {
    it("returns a single embedding array for one text", async () => {
      embedMock.mockResolvedValue({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { totalTokens: 3 },
      });

      const result = await service.embedText("hello");

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("embedTexts", () => {
    it("makes one API call for input within the batch limit", async () => {
      const texts = Array.from({ length: 50 }, (_, i) => `text-${i}`);
      const mockData = texts.map((_, i) => ({ index: i, embedding: [i * 0.1] }));

      embedMock.mockResolvedValue({ data: mockData, usage: { totalTokens: 50 } });

      const result = await service.embedTexts(texts);

      expect(embedMock).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(50);
    });

    it("makes multiple sequential API calls for input exceeding the batch limit", async () => {
      const texts = Array.from({ length: 1001 }, (_, i) => `text-${i}`);
      const firstBatchData = Array.from({ length: 1000 }, (_, i) => ({
        index: i,
        embedding: [i * 0.001],
      }));
      const secondBatchData = [{ index: 0, embedding: [0.999] }];

      embedMock
        .mockResolvedValueOnce({ data: firstBatchData, usage: { totalTokens: 1000 } })
        .mockResolvedValueOnce({ data: secondBatchData, usage: { totalTokens: 1 } });

      const result = await service.embedTexts(texts);

      expect(embedMock).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1001);
    });

    it("returns an empty array without calling embed when input is empty", async () => {
      const result = await service.embedTexts([]);

      expect(embedMock).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("does not leak the API key in error messages or logs on auth failure", async () => {
      const secretKey = "SECRET_API_KEY_12345";
      const module = await buildModule(buildMockVoyageConfigService(secretKey));
      const serviceWithSecret = module.get<VoyageService>(VoyageService);

      embedMock.mockRejectedValue(
        new VoyageAIError(
          `body echoes: Bearer ${secretKey}`,
          401,
          { echo: `Bearer ${secretKey}` },
        ),
      );

      const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      await expect(serviceWithSecret.embedText("x")).rejects.toThrow();

      const rejection = await serviceWithSecret.embedText("x").catch((e: Error) => e);
      expect(rejection.message).not.toContain(secretKey);

      for (const call of errorSpy.mock.calls) {
        const callStr = call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
        expect(callStr).not.toContain(secretKey);
      }

      errorSpy.mockRestore();
    });
  });
});
