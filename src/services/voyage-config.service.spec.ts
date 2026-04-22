import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

import { VoyageConfigService } from "./voyage-config.service";

const VOYAGE_API_KEY = "test-voyage-api-key";
const VOYAGE_MODEL = "voyage-3";

function buildMockConfigService(model: string, apiKey?: string): Partial<ConfigService> {
  return {
    getOrThrow: jest.fn().mockReturnValue(model),
    get: jest.fn().mockReturnValue(apiKey),
  };
}

async function buildModule(model: string, apiKey?: string): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      VoyageConfigService,
      {
        provide: ConfigService,
        useValue: buildMockConfigService(model, apiKey),
      },
    ],
  }).compile();
}

describe("VoyageConfigService", () => {
  describe("apiKey getter", () => {
    it("calls configService.get with 'voyage.apiKey'", async () => {
      const mockConfigService = buildMockConfigService(VOYAGE_MODEL, VOYAGE_API_KEY);
      const module = await Test.createTestingModule({
        providers: [
          VoyageConfigService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const service = module.get<VoyageConfigService>(VoyageConfigService);
      service.apiKey;

      expect(mockConfigService.get).toHaveBeenCalledWith("voyage.apiKey", { infer: true });
    });

    it("returns the value from configService", async () => {
      const module = await buildModule(VOYAGE_MODEL, VOYAGE_API_KEY);
      const service = module.get<VoyageConfigService>(VoyageConfigService);

      expect(service.apiKey).toBe(VOYAGE_API_KEY);
    });

    it("returns undefined when apiKey is not set", async () => {
      const module = await buildModule(VOYAGE_MODEL, undefined);
      const service = module.get<VoyageConfigService>(VoyageConfigService);

      expect(service.apiKey).toBeUndefined();
    });
  });

  describe("model getter", () => {
    it("calls configService.getOrThrow with 'voyage.model'", async () => {
      const mockConfigService = buildMockConfigService(VOYAGE_MODEL);
      const module = await Test.createTestingModule({
        providers: [
          VoyageConfigService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const service = module.get<VoyageConfigService>(VoyageConfigService);
      service.model;

      expect(mockConfigService.getOrThrow).toHaveBeenCalledWith("voyage.model", { infer: true });
    });

    it("returns the value from configService", async () => {
      const module = await buildModule(VOYAGE_MODEL);
      const service = module.get<VoyageConfigService>(VoyageConfigService);

      expect(service.model).toBe(VOYAGE_MODEL);
    });
  });
});
