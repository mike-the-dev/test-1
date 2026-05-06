import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

import { TwilioConfigService } from "./twilio-config.service";

const mockConfigService = {
  get: jest.fn(),
};

describe("TwilioConfigService", () => {
  let service: TwilioConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwilioConfigService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<TwilioConfigService>(TwilioConfigService);
  });

  it("accountSid returns value from ConfigService", () => {
    mockConfigService.get.mockReturnValue("ACtest1234567890");

    expect(service.accountSid).toBe("ACtest1234567890");
    expect(mockConfigService.get).toHaveBeenCalledWith("twilio.accountSid", { infer: true });
  });

  it("accountSid returns empty string when ConfigService returns undefined", () => {
    mockConfigService.get.mockReturnValue(undefined);

    expect(service.accountSid).toBe("");
  });

  it("authToken returns value from ConfigService", () => {
    mockConfigService.get.mockReturnValue("test_auth_token_abc");

    expect(service.authToken).toBe("test_auth_token_abc");
    expect(mockConfigService.get).toHaveBeenCalledWith("twilio.authToken", { infer: true });
  });

  it("phoneNumber returns value from ConfigService", () => {
    mockConfigService.get.mockReturnValue("+15558675309");

    expect(service.phoneNumber).toBe("+15558675309");
    expect(mockConfigService.get).toHaveBeenCalledWith("twilio.phoneNumber", { infer: true });
  });

  it("replyAccountId returns value from ConfigService", () => {
    mockConfigService.get.mockReturnValue("01ACCT000000000000000000000");

    expect(service.replyAccountId).toBe("01ACCT000000000000000000000");
    expect(mockConfigService.get).toHaveBeenCalledWith("twilio.replyAccountId", { infer: true });
  });

  it("publicWebhookUrl returns value from ConfigService", () => {
    mockConfigService.get.mockReturnValue("https://api.example.com");

    expect(service.publicWebhookUrl).toBe("https://api.example.com");
    expect(mockConfigService.get).toHaveBeenCalledWith("twilio.publicWebhookUrl", { infer: true });
  });

  it("publicWebhookUrl strips trailing slash to prevent double-slash in webhook URLs", () => {
    mockConfigService.get.mockReturnValue("https://api.example.com/");

    expect(service.publicWebhookUrl).toBe("https://api.example.com");
  });
});
