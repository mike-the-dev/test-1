import { Test, TestingModule } from "@nestjs/testing";

import { EmailService } from "./email.service";
import { SendGridConfigService } from "./sendgrid-config.service";

// Mock the @sendgrid/mail module — hoisted before const declarations.
jest.mock("@sendgrid/mail", () => {
  const sendMock: jest.Mock = jest.fn();
  const setApiKeyMock: jest.Mock = jest.fn();
  return { __esModule: true, default: { send: sendMock, setApiKey: setApiKeyMock } };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const sgMailMock = jest.requireMock("@sendgrid/mail").default;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
const mockSend: jest.Mock = sgMailMock.send;

const SESSION_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPLY_DOMAIN = "reply.example.com";
const FROM_NAME = "Test Concierge";
const TO_EMAIL = "visitor@example.com";
const SUBJECT = "Hello";
const BODY = "<p>Hi!</p>";
const OUTBOUND_MESSAGE_ID = "outbound-message-id-123";

const mockSendGridConfig = {
  apiKey: "SG.test-api-key",
};

describe("EmailService", () => {
  let service: EmailService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: SendGridConfigService,
          useValue: mockSendGridConfig,
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  describe("send — with replyDomain (reply-service-originated)", () => {
    it("happy path — calls sgMail.send with from address built from sessionUlid@replyDomain", async () => {
      mockSend.mockResolvedValue([{ headers: { "x-message-id": OUTBOUND_MESSAGE_ID } }]);

      const result = await service.send({
        to: TO_EMAIL,
        subject: SUBJECT,
        body: BODY,
        sessionUlid: SESSION_ULID,
        replyDomain: REPLY_DOMAIN,
        fromName: FROM_NAME,
      });

      expect(result).toEqual({ messageId: OUTBOUND_MESSAGE_ID });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const sentMessage = mockSend.mock.calls[0][0];
      expect(sentMessage.from.email).toBe(`${SESSION_ULID}@${REPLY_DOMAIN}`);
      expect(sentMessage.from.name).toBe(FROM_NAME);
      expect(sentMessage.to).toBe(TO_EMAIL);
      expect(sentMessage.subject).toBe(SUBJECT);
      expect(sentMessage.html).toBe(BODY);
    });

    it("fromName defaults to empty string when replyDomain is present but fromName is absent", async () => {
      mockSend.mockResolvedValue([{ headers: { "x-message-id": OUTBOUND_MESSAGE_ID } }]);

      await service.send({
        to: TO_EMAIL,
        subject: SUBJECT,
        body: BODY,
        sessionUlid: SESSION_ULID,
        replyDomain: REPLY_DOMAIN,
      });

      const sentMessage = mockSend.mock.calls[0][0];
      expect(sentMessage.from.name).toBe("");
    });

    it("includes In-Reply-To and References headers when inReplyToMessageId is provided", async () => {
      mockSend.mockResolvedValue([{ headers: { "x-message-id": OUTBOUND_MESSAGE_ID } }]);

      await service.send({
        to: TO_EMAIL,
        subject: SUBJECT,
        body: BODY,
        sessionUlid: SESSION_ULID,
        replyDomain: REPLY_DOMAIN,
        fromName: FROM_NAME,
        inReplyToMessageId: "inbound-msg-id",
        referencesMessageId: "inbound-msg-id",
      });

      const sentMessage = mockSend.mock.calls[0][0];
      expect(sentMessage.headers?.["In-Reply-To"]).toBe("<inbound-msg-id>");
      expect(sentMessage.headers?.["References"]).toBe("<inbound-msg-id>");
    });

    it("re-throws when sgMail.send rejects", async () => {
      const sendError = new Error("SendGrid API error");
      mockSend.mockRejectedValue(sendError);

      await expect(
        service.send({
          to: TO_EMAIL,
          subject: SUBJECT,
          body: BODY,
          sessionUlid: SESSION_ULID,
          replyDomain: REPLY_DOMAIN,
          fromName: FROM_NAME,
        }),
      ).rejects.toThrow("SendGrid API error");
    });
  });

  describe("send — without replyDomain (tool-originated)", () => {
    it("sends without a custom from address when replyDomain is absent", async () => {
      mockSend.mockResolvedValue([{ headers: { "x-message-id": OUTBOUND_MESSAGE_ID } }]);

      const result = await service.send({
        to: TO_EMAIL,
        subject: SUBJECT,
        body: BODY,
        sessionUlid: SESSION_ULID,
      });

      expect(result).toEqual({ messageId: OUTBOUND_MESSAGE_ID });
      const sentMessage = mockSend.mock.calls[0][0];
      expect(sentMessage.from.email).toBe("");
    });

    it("returns messageId from x-message-id response header", async () => {
      mockSend.mockResolvedValue([{ headers: { "x-message-id": "special-id-999" } }]);

      const result = await service.send({
        to: TO_EMAIL,
        subject: SUBJECT,
        body: BODY,
        sessionUlid: SESSION_ULID,
        replyDomain: REPLY_DOMAIN,
        fromName: FROM_NAME,
      });

      expect(result.messageId).toBe("special-id-999");
    });
  });
});
