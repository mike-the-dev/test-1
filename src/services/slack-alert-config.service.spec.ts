import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

import { SlackAlertConfigService } from "./slack-alert-config.service";

describe("SlackAlertConfigService", () => {
  let service: SlackAlertConfigService;
  const mockGet = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlackAlertConfigService,
        {
          provide: ConfigService,
          useValue: { get: mockGet },
        },
      ],
    }).compile();

    service = module.get<SlackAlertConfigService>(SlackAlertConfigService);
  });

  describe("webhookUrl", () => {
    it("returns undefined when ConfigService returns undefined", () => {
      mockGet.mockReturnValue(undefined);

      expect(service.webhookUrl).toBeUndefined();
      expect(mockGet).toHaveBeenCalledWith("slack.webhookUrl", { infer: true });
    });

    it("returns the webhook URL string when ConfigService returns a value", () => {
      const url = "https://hooks.slack.com/services/T000/B000/xxxx";
      mockGet.mockReturnValue(url);

      expect(service.webhookUrl).toBe(url);
    });
  });
});
