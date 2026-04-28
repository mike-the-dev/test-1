import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

import { InternalApiAuthConfigService } from "./internal-api-auth-config.service";

describe("InternalApiAuthConfigService", () => {
  let service: InternalApiAuthConfigService;
  let configService: { getOrThrow: jest.Mock };

  beforeEach(async () => {
    configService = {
      getOrThrow: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InternalApiAuthConfigService,
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    service = module.get<InternalApiAuthConfigService>(InternalApiAuthConfigService);
  });

  it("key getter delegates to ConfigService.getOrThrow with the correct config path", () => {
    configService.getOrThrow.mockReturnValue("test-internal-api-key-32chars-aaaaa");

    const result = service.key;

    expect(configService.getOrThrow).toHaveBeenCalledWith("internalApiAuth.key", { infer: true });
    expect(result).toBe("test-internal-api-key-32chars-aaaaa");
  });

  it("key getter uses getOrThrow (not get) — propagates the throw when the key is absent", () => {
    configService.getOrThrow.mockImplementation(() => {
      throw new Error("Config key internalApiAuth.key is missing");
    });

    expect(() => service.key).toThrow("Config key internalApiAuth.key is missing");
  });
});
