import { Test, TestingModule } from "@nestjs/testing";

import { TwilioWebhookController } from "./twilio-webhook.controller";
import { SmsReplyService } from "../services/sms-reply.service";
import { TwilioConfigService } from "../services/twilio-config.service";

// Mock the twilio module to control validateRequest.
// jest.mock factories are hoisted before const declarations, so we create the mock
// fn inside the factory and access it via jest.requireMock after.
jest.mock("twilio", () => {
  const validateRequestMock: jest.Mock = jest.fn();
  const constructorMock: jest.Mock & { validateRequest: jest.Mock } = Object.assign(
    jest.fn().mockReturnValue({ messages: { create: jest.fn() } }),
    { validateRequest: validateRequestMock },
  );
  return constructorMock;
});

// Access the mocked validateRequest after the module mock is registered.
// We use requireMock to get the mock factory's result and extract the validateRequest fn.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const twilioMockModule = jest.requireMock("twilio");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const mockValidateRequest: jest.Mock = twilioMockModule.validateRequest;

const AUTH_TOKEN = "test_auth_token_abc";
const PUBLIC_WEBHOOK_URL = "https://api.example.com";
const EXPECTED_VERIFY_URL = `${PUBLIC_WEBHOOK_URL}/webhooks/twilio/inbound`;
const VALID_SIGNATURE = "valid-sig-abc123";

const VALID_FORM_FIELDS = {
  MessageSid: "SMabc123def456ghi789jkl012mno345pq",
  AccountSid: "ACfakeaccountsid",
  From: "+15551234567",
  To: "+15558675309",
  Body: "Hello from a test.",
};

// twilioConfig is mutable so tests can change authToken
const mockTwilioConfig = {
  authToken: AUTH_TOKEN,
  publicWebhookUrl: PUBLIC_WEBHOOK_URL,
  accountSid: "",
  phoneNumber: "",
  replyAccountId: "",
};

const mockSmsReplyService = {
  processInboundMessage: jest.fn(),
};

describe("TwilioWebhookController", () => {
  let controller: TwilioWebhookController;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset mutable fields to defaults
    mockTwilioConfig.authToken = AUTH_TOKEN;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TwilioWebhookController],
      providers: [
        { provide: SmsReplyService, useValue: mockSmsReplyService },
        { provide: TwilioConfigService, useValue: mockTwilioConfig },
      ],
    }).compile();

    controller = module.get<TwilioWebhookController>(TwilioWebhookController);
  });

  it("valid signature routes to processInboundMessage and returns void", async () => {
    mockValidateRequest.mockReturnValue(true);
    mockSmsReplyService.processInboundMessage.mockResolvedValue("processed");

    const result = await controller.handleInbound(VALID_FORM_FIELDS, VALID_SIGNATURE);

    expect(result).toBeUndefined();
    expect(mockValidateRequest).toHaveBeenCalledWith(
      AUTH_TOKEN,
      VALID_SIGNATURE,
      EXPECTED_VERIFY_URL,
      VALID_FORM_FIELDS,
    );
    expect(mockSmsReplyService.processInboundMessage).toHaveBeenCalledWith(VALID_FORM_FIELDS);
  });

  it("invalid signature does NOT call processInboundMessage and returns void", async () => {
    mockValidateRequest.mockReturnValue(false);

    const result = await controller.handleInbound(VALID_FORM_FIELDS, "bad-signature");

    expect(result).toBeUndefined();
    expect(mockSmsReplyService.processInboundMessage).not.toHaveBeenCalled();
  });

  it("missing signature header does NOT call processInboundMessage and returns void", async () => {
    const result = await controller.handleInbound(VALID_FORM_FIELDS, undefined);

    expect(result).toBeUndefined();
    // validateRequest is never called when signature is missing
    expect(mockValidateRequest).not.toHaveBeenCalled();
    expect(mockSmsReplyService.processInboundMessage).not.toHaveBeenCalled();
  });

  it("missing auth token does NOT call processInboundMessage and returns void", async () => {
    mockTwilioConfig.authToken = "";

    const result = await controller.handleInbound(VALID_FORM_FIELDS, VALID_SIGNATURE);

    expect(result).toBeUndefined();
    // validateRequest is never called when auth token is missing
    expect(mockValidateRequest).not.toHaveBeenCalled();
    expect(mockSmsReplyService.processInboundMessage).not.toHaveBeenCalled();
  });
});
