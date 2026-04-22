import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

import { QdrantConfigService } from "./qdrant-config.service";

const QDRANT_URL = "http://localhost:6333";
const QDRANT_API_KEY = "test-api-key";

function buildMockConfigService(url: string, apiKey?: string): Partial<ConfigService> {
  return {
    getOrThrow: jest.fn().mockReturnValue(url),
    get: jest.fn().mockReturnValue(apiKey),
  };
}

async function buildModule(url: string, apiKey?: string): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      QdrantConfigService,
      {
        provide: ConfigService,
        useValue: buildMockConfigService(url, apiKey),
      },
    ],
  }).compile();
}

describe("QdrantConfigService", () => {
  describe("url getter", () => {
    it("calls configService.getOrThrow with 'qdrant.url'", async () => {
      const mockConfigService = buildMockConfigService(QDRANT_URL);
      const module = await Test.createTestingModule({
        providers: [
          QdrantConfigService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const service = module.get<QdrantConfigService>(QdrantConfigService);
      service.url;

      expect(mockConfigService.getOrThrow).toHaveBeenCalledWith("qdrant.url", { infer: true });
    });

    it("returns the value from configService", async () => {
      const module = await buildModule(QDRANT_URL);
      const service = module.get<QdrantConfigService>(QdrantConfigService);

      expect(service.url).toBe(QDRANT_URL);
    });
  });

  describe("apiKey getter", () => {
    it("calls configService.get with 'qdrant.apiKey'", async () => {
      const mockConfigService = buildMockConfigService(QDRANT_URL, QDRANT_API_KEY);
      const module = await Test.createTestingModule({
        providers: [
          QdrantConfigService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const service = module.get<QdrantConfigService>(QdrantConfigService);
      service.apiKey;

      expect(mockConfigService.get).toHaveBeenCalledWith("qdrant.apiKey", { infer: true });
    });

    it("returns undefined when apiKey is not set", async () => {
      const module = await buildModule(QDRANT_URL, undefined);
      const service = module.get<QdrantConfigService>(QdrantConfigService);

      expect(service.apiKey).toBeUndefined();
    });

    it("returns the apiKey string when present", async () => {
      const module = await buildModule(QDRANT_URL, QDRANT_API_KEY);
      const service = module.get<QdrantConfigService>(QdrantConfigService);

      expect(service.apiKey).toBe(QDRANT_API_KEY);
    });
  });
});
