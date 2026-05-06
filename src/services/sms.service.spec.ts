import { Test, TestingModule } from "@nestjs/testing";

import { SmsService } from "./sms.service";
import { TwilioConfigService } from "./twilio-config.service";

// Mock the twilio module so no real HTTP calls happen.
// jest.mock factories are hoisted before const declarations, so we create the mock
// fn inside the factory and access it via jest.requireMock after.
jest.mock("twilio", () => {
  const messagesCreateMock: jest.Mock = jest.fn();
  const constructorMock = jest.fn().mockReturnValue({
    messages: { create: messagesCreateMock },
  });
  return constructorMock;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const twilioMock = jest.requireMock("twilio");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
const mockTwilioInstance = twilioMock();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
const mockMessagesCreate: jest.Mock = mockTwilioInstance.messages.create;

const ACCOUNT_SID = "01ACCSID00000000000000000A";
const AUTH_TOKEN = "01AUTHTKN0000000000000000T";
const FROM_NUMBER = "+15558675309";
const TO_NUMBER = "+15551234567";
const SESSION_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MESSAGE_SID = "SMabc123def456ghi789jkl012mno345pq";

const mockTwilioConfig = {
  accountSid: ACCOUNT_SID,
  authToken: AUTH_TOKEN,
  phoneNumber: FROM_NUMBER,
  replyAccountId: "",
  publicWebhookUrl: "",
};

describe("SmsService", () => {
  let service: SmsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsService,
        {
          provide: TwilioConfigService,
          useValue: mockTwilioConfig,
        },
      ],
    }).compile();

    service = module.get<SmsService>(SmsService);
  });

  it("send happy path: calls messages.create with correct from/to/body and returns messageSid", async () => {
    mockMessagesCreate.mockResolvedValue({ sid: MESSAGE_SID });

    const result = await service.send({
      to: TO_NUMBER,
      body: "Hello from the assistant!",
      sessionUlid: SESSION_ULID,
    });

    expect(result).toEqual({ messageSid: MESSAGE_SID });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      from: FROM_NUMBER,
      to: TO_NUMBER,
      body: "Hello from the assistant!",
    });
  });

  it("send throws when TWILIO_PHONE_NUMBER is missing", async () => {
    // Temporarily clear phoneNumber on the mock
    const savedPhone = mockTwilioConfig.phoneNumber;
    mockTwilioConfig.phoneNumber = "";

    await expect(
      service.send({ to: TO_NUMBER, body: "Test", sessionUlid: SESSION_ULID }),
    ).rejects.toThrow("TWILIO_PHONE_NUMBER not configured");

    expect(mockMessagesCreate).not.toHaveBeenCalled();

    mockTwilioConfig.phoneNumber = savedPhone;
  });

  it("send re-throws when Twilio SDK rejects", async () => {
    const sdkError = Object.assign(new Error("Twilio API error"), {
      code: 21211,
      moreInfo: "https://www.twilio.com/docs/errors/21211",
    });

    mockMessagesCreate.mockRejectedValue(sdkError);

    await expect(
      service.send({ to: TO_NUMBER, body: "Test", sessionUlid: SESSION_ULID }),
    ).rejects.toThrow("Twilio API error");

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});
