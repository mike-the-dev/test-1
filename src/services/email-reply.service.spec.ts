import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { EmailReplyService } from "./email-reply.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { SendGridConfigService } from "./sendgrid-config.service";
import { EmailService } from "./email.service";
import { ChatSessionService } from "./chat-session.service";

const TABLE_NAME = "test-conversations-table";
const REPLY_DOMAIN = "reply.example.com";
const SESSION_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SENDER_EMAIL = "alice@example.com";
const INBOUND_MESSAGE_ID = "abc123@mail.example.com";

const VALID_HEADERS = `MIME-Version: 1.0\nMessage-ID: <${INBOUND_MESSAGE_ID}>\nContent-Type: text/plain`;

const VALID_FORM_FIELDS = {
  to: `${SESSION_ULID}@${REPLY_DOMAIN}`,
  from: SENDER_EMAIL,
  subject: "Hello there",
  text: "My new message.",
  headers: VALID_HEADERS,
};

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const mockSendGridConfig = { replyDomain: REPLY_DOMAIN };

const mockEmailService = { send: jest.fn() };

const mockChatSessionService = { handleMessage: jest.fn() };

describe("EmailReplyService", () => {
  let service: EmailReplyService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailReplyService,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        {
          provide: DatabaseConfigService,
          useValue: mockDatabaseConfig,
        },
        {
          provide: SendGridConfigService,
          useValue: mockSendGridConfig,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: ChatSessionService,
          useValue: mockChatSessionService,
        },
      ],
    }).compile();

    service = module.get<EmailReplyService>(EmailReplyService);
  });

  describe("processInboundReply", () => {
    it("returns 'processed' on happy path and calls handleMessage and send once each", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({
        Item: { email: SENDER_EMAIL },
      });

      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hello from the assistant.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({ messageId: "outbound-id" });

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledTimes(1);
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(SESSION_ULID, "My new message.");
      expect(mockEmailService.send).toHaveBeenCalledTimes(1);
    });

    it("passes correct threading headers and sessionUlid to EmailService.send on happy path", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({
        Item: { email: SENDER_EMAIL },
      });

      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Reply text.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({ messageId: "outbound-id" });

      await service.processInboundReply(VALID_FORM_FIELDS);

      const sendCall = mockEmailService.send.mock.calls[0][0];

      expect(sendCall.sessionUlid).toBe(SESSION_ULID);
      expect(sendCall.inReplyToMessageId).toBe(INBOUND_MESSAGE_ID);
      expect(sendCall.referencesMessageId).toBe(INBOUND_MESSAGE_ID);
      expect(sendCall.subject).toBe("Re: Hello there");
    });

    it("returns 'duplicate' on ConditionalCheckFailedException and does not call handleMessage", async () => {
      const conditionalError = Object.assign(new Error("Conditional check failed"), {
        name: "ConditionalCheckFailedException",
      });

      ddbMock.on(PutCommand).rejects(conditionalError);

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("duplicate");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_unknown_session' when no USER_CONTACT_INFO record exists", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_session");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_sender_mismatch' when from email does not match stored email", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({
        Item: { email: "different@example.com" },
      });

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("rejected_sender_mismatch");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_malformed' when local-part is not a 26-char ULID", async () => {
      const badFields = {
        ...VALID_FORM_FIELDS,
        to: `notaulid@${REPLY_DOMAIN}`,
      };

      const result = await service.processInboundReply(badFields);

      expect(result).toBe("rejected_malformed");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(0);
    });

    it("returns 'rejected_malformed' when to address has no recipient matching reply domain", async () => {
      const badFields = {
        ...VALID_FORM_FIELDS,
        to: `someone@other-domain.com`,
      };

      const result = await service.processInboundReply(badFields);

      expect(result).toBe("rejected_malformed");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(0);
    });

    it("returns 'rejected_malformed' when body is empty after stripping quoted history", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({
        Item: { email: SENDER_EMAIL },
      });

      const allQuotedFields = {
        ...VALID_FORM_FIELDS,
        text: "> Entirely quoted content\n> Nothing new here",
      };

      const result = await service.processInboundReply(allQuotedFields);

      expect(result).toBe("rejected_malformed");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("propagates throws from ChatSessionService without catching", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({
        Item: { email: SENDER_EMAIL },
      });

      const serviceError = new Error("Anthropic API failure");

      mockChatSessionService.handleMessage.mockRejectedValue(serviceError);

      await expect(service.processInboundReply(VALID_FORM_FIELDS)).rejects.toThrow("Anthropic API failure");
    });

    it("extracts bare email from display-name 'from' field format", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({
        Item: { email: "john@example.com" },
      });

      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi John.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({ messageId: "out-id" });

      const displayNameFields = {
        ...VALID_FORM_FIELDS,
        from: '"John Smith" <john@example.com>',
      };

      const result = await service.processInboundReply(displayNameFields);

      expect(result).toBe("processed");

      const sendCall = mockEmailService.send.mock.calls[0][0];
      expect(sendCall.to).toBe("john@example.com");
    });

    it("falls back to SHA-256 hash when Message-ID header is absent and still handles idempotency on second call", async () => {
      const conditionalError = Object.assign(new Error("Conditional check failed"), {
        name: "ConditionalCheckFailedException",
      });

      ddbMock.on(PutCommand).rejectsOnce(conditionalError);

      const noHeaderFields = {
        ...VALID_FORM_FIELDS,
        headers: "MIME-Version: 1.0",
      };

      const result = await service.processInboundReply(noHeaderFields);

      expect(result).toBe("duplicate");
    });
  });
});
