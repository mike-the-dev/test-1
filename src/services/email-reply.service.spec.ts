import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { EmailReplyService } from "./email-reply.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { SendGridConfigService } from "./sendgrid-config.service";
import { EmailService } from "./email.service";
import { ChatSessionService } from "./chat-session.service";
import { CustomerService } from "./customer.service";
import { SessionService } from "./session.service";

const TABLE_NAME = "test-conversations-table";
const REPLY_DOMAIN = "reply.example.com";
const SESSION_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SENDER_EMAIL = "alice@example.com";
const INBOUND_MESSAGE_ID = "abc123@mail.example.com";

const ASSISTANT_TO = `assistant@${REPLY_DOMAIN}`;
const ACCOUNT_ID = "01BXACCNTACCT0000000000000";
const CUSTOMER_ULID = "01BXCSTMR00000000000000000";
const PRIOR_SESSION_ULID = "01BXPRYRSESSN0000000000000";
const NEW_SESSION_ULID = "01BXNEWSESSN00000000000000";

const VALID_HEADERS = `MIME-Version: 1.0\nMessage-ID: <${INBOUND_MESSAGE_ID}>\nContent-Type: text/plain`;

const VALID_FORM_FIELDS = {
  to: `${SESSION_ULID}@${REPLY_DOMAIN}`,
  from: SENDER_EMAIL,
  subject: "Hello there",
  text: "My new message.",
  headers: VALID_HEADERS,
};

const ASSISTANT_FORM_FIELDS = {
  to: ASSISTANT_TO,
  from: SENDER_EMAIL,
  subject: "Hello assistant",
  text: "My new message.",
  headers: VALID_HEADERS,
};

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

// sendGridConfig is mutable so individual tests can change replyAccountId
const mockSendGridConfig = { replyDomain: REPLY_DOMAIN, replyAccountId: ACCOUNT_ID };

const mockEmailService = { send: jest.fn() };

const mockChatSessionService = { handleMessage: jest.fn() };

const mockCustomerService = { queryCustomerIdByEmail: jest.fn() };

const mockSessionService = { lookupOrCreateSession: jest.fn() };

describe("EmailReplyService", () => {
  let service: EmailReplyService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    // Reset replyAccountId to populated default (individual tests override when needed)
    mockSendGridConfig.replyAccountId = ACCOUNT_ID;

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
        {
          provide: CustomerService,
          useValue: mockCustomerService,
        },
        {
          provide: SessionService,
          useValue: mockSessionService,
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

  describe("dispatcher routing", () => {
    it("26-char Crockford ULID local-part routes to Case 1 (SESSION_ULID)", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: SENDER_EMAIL } });
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(SESSION_ULID, "My new message.");
    });

    it("'assistant' local-part with no replyAccountId returns rejected_unknown_account", async () => {
      mockSendGridConfig.replyAccountId = "";

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_account");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("unrecognized local-part returns rejected_malformed without any DDB writes", async () => {
      const badFields = { ...VALID_FORM_FIELDS, to: `garbage@${REPLY_DOMAIN}` };

      const result = await service.processInboundReply(badFields);

      expect(result).toBe("rejected_malformed");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("uppercase 'ASSISTANT' local-part routes to ASSISTANT_ENTRY (case-insensitive)", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const upperFields = { ...ASSISTANT_FORM_FIELDS, to: `ASSISTANT@${REPLY_DOMAIN}` };
      const result = await service.processInboundReply(upperFields);

      // Routes to Case 2 (customer not found)
      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
    });

    it("mixed-case 'Assistant' local-part routes to ASSISTANT_ENTRY", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const mixedFields = { ...ASSISTANT_FORM_FIELDS, to: `Assistant@${REPLY_DOMAIN}` };
      const result = await service.processInboundReply(mixedFields);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
    });

    it("empty string local-part returns rejected_malformed", async () => {
      const emptyLocalFields = { ...VALID_FORM_FIELDS, to: `@${REPLY_DOMAIN}` };

      const result = await service.processInboundReply(emptyLocalFields);

      expect(result).toBe("rejected_malformed");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it("26 'O' characters (not valid Crockford) returns rejected_malformed", async () => {
      // 'O' is excluded from Crockford base-32
      const notCrockfordFields = {
        ...VALID_FORM_FIELDS,
        to: `OOOOOOOOOOOOOOOOOOOOOOOOOO@${REPLY_DOMAIN}`,
      };

      const result = await service.processInboundReply(notCrockfordFields);

      expect(result).toBe("rejected_malformed");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("Case 2 — unknown sender", () => {
    it("unknown sender creates new session without customer_id and returns processed", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Welcome!", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("email", null, "lead_capture", ACCOUNT_ID);

      // USER_CONTACT_INFO UpdateCommand should be called
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const contactInfoUpdate = updateCalls.find((call) =>
        call.args[0].input.Key?.SK === "USER_CONTACT_INFO",
      );
      expect(contactInfoUpdate).toBeDefined();
      expect(contactInfoUpdate!.args[0].input.UpdateExpression).toContain("if_not_exists(email");

      // handleMessage called with new session
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(NEW_SESSION_ULID, "My new message.");

      // No METADATA customer_id UpdateCommand (only USER_CONTACT_INFO)
      const metadataUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataUpdate).toBeUndefined();
    });

    it("dedup: second identical assistant entry email returns duplicate", async () => {
      const conditionalError = Object.assign(new Error("Conditional check failed"), {
        name: "ConditionalCheckFailedException",
      });
      ddbMock.on(PutCommand).rejects(conditionalError);

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("duplicate");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("Case 2 empty body after strip returns rejected_malformed", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});

      const allQuotedFields = {
        ...ASSISTANT_FORM_FIELDS,
        text: "> Entirely quoted content\n> Nothing new here",
      };

      const result = await service.processInboundReply(allQuotedFields);

      expect(result).toBe("rejected_malformed");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });
  });

  describe("Case 3 fresh — known sender, recent session", () => {
    it("known sender with session < 7 days old appends to existing session", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      // First GetCommand: prior session METADATA (freshness check)
      // Second GetCommand: USER_CONTACT_INFO for existing session (sender validation)
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } })
        .resolvesOnce({ Item: { email: SENDER_EMAIL } });

      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Welcome back!", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      // handleMessage must be called with the EXISTING session, not a new one
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(PRIOR_SESSION_ULID, "My new message.");
      // No session creation
      expect(mockSessionService.lookupOrCreateSession).not.toHaveBeenCalled();
      // No METADATA customer_id UpdateCommand
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataCustomerIdUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataCustomerIdUpdate).toBeUndefined();
    });

    it("Case 3 fresh: sender mismatch returns rejected_sender_mismatch", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } })
        .resolvesOnce({ Item: { email: "different@example.com" } });

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("rejected_sender_mismatch");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });

    it("Case 3 fresh: empty body after strip returns rejected_malformed", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } })
        .resolvesOnce({ Item: { email: SENDER_EMAIL } });

      const allQuotedFields = {
        ...ASSISTANT_FORM_FIELDS,
        text: "> Entirely quoted content\n> Nothing new here",
      };

      const result = await service.processInboundReply(allQuotedFields);

      expect(result).toBe("rejected_malformed");
      expect(mockChatSessionService.handleMessage).not.toHaveBeenCalled();
    });
  });

  describe("Case 3 stale — known sender, old session", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    it("known sender with session >= 7 days old creates new linked session with all three METADATA fields", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      // First GetCommand: prior session METADATA (freshness check — 8 days old = stale)
      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: eightDaysAgo } });

      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Good to see you again!", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("email", null, "lead_capture", ACCOUNT_ID);
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(NEW_SESSION_ULID, "My new message.");

      // Verify the METADATA UpdateCommand includes all three continuation fields
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );

      expect(metadataUpdate).toBeDefined();
      const values = metadataUpdate!.args[0].input.ExpressionAttributeValues!;
      expect(values[":customerId"]).toBe(`C#${CUSTOMER_ULID}`);
      expect(values[":contFrom"]).toBe(PRIOR_SESSION_ULID);
      expect(values[":contAt"]).toBeNull();
    });

    it("continuation_from_session_id is the CAPTURED prior latestSessionId, not re-fetched", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: eightDaysAgo } });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("continuation_from_session_id"),
      );
      expect(metadataUpdate!.args[0].input.ExpressionAttributeValues![":contFrom"]).toBe(PRIOR_SESSION_ULID);
    });

    it("Case 3 stale with null latestSessionId writes continuation_from_session_id = null", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: null,
      });

      // No GetCommand for prior metadata needed (latestSessionId is null — skip freshness check)
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );

      expect(metadataUpdate).toBeDefined();
      const values = metadataUpdate!.args[0].input.ExpressionAttributeValues!;
      expect(values[":customerId"]).toBe(`C#${CUSTOMER_ULID}`);
      expect(values[":contFrom"]).toBeNull();
    });

    it("Case 3 stale: prior session METADATA not found treats as stale and creates new linked session", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      // Prior session METADATA not found
      ddbMock.on(GetCommand).resolvesOnce({ Item: undefined });

      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataUpdate).toBeDefined();
    });

    it("Case 3 stale: USER_CONTACT_INFO write uses if_not_exists", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: eightDaysAgo } });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const contactInfoUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "USER_CONTACT_INFO",
      );

      expect(contactInfoUpdate).toBeDefined();
      expect(contactInfoUpdate!.args[0].input.UpdateExpression).toContain("if_not_exists(email");
    });
  });

  describe("freshness boundary cases", () => {
    it("7 days or older is STALE — creates new linked session", async () => {
      // At least 7 days old — ageMs >= EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS = stale
      const atLeastSevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: atLeastSevenDaysAgo } });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      // Stale path: new session created
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
      // handleMessage called with NEW session (stale path)
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(NEW_SESSION_ULID, "My new message.");
    });

    it("one hour under 7 days is FRESH — appends to existing session", async () => {
      // Use 1 hour margin so test is not sensitive to execution time
      const justUnder7Days = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)).toISOString();

      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      // First GetCommand: prior session METADATA (fresh)
      // Second GetCommand: USER_CONTACT_INFO for sender validation
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: { _lastUpdated_: justUnder7Days } })
        .resolvesOnce({ Item: { email: SENDER_EMAIL } });

      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      // Fresh path: no new session created
      expect(mockSessionService.lookupOrCreateSession).not.toHaveBeenCalled();
      // handleMessage called with EXISTING session (fresh path)
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(PRIOR_SESSION_ULID, "My new message.");
    });

    it("unparseable _lastUpdated_ timestamp treats as stale", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: "not-a-date" } });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Hi.", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      // Stale path taken due to unparseable timestamp
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
    });
  });

  describe("customer-not-found in assistant branch", () => {
    it("assistant entry but customer not in GSI falls through to Case 2 (new session, no customer link)", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({ sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true });
      ddbMock.on(UpdateCommand).resolves({});
      mockChatSessionService.handleMessage.mockResolvedValue({ reply: "Welcome!", toolOutputs: [] });
      mockEmailService.send.mockResolvedValue({});

      const result = await service.processInboundReply(ASSISTANT_FORM_FIELDS);

      expect(result).toBe("processed");
      // New session created (Case 2)
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("email", null, "lead_capture", ACCOUNT_ID);

      // No METADATA customer_id UpdateCommand written
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataCustomerIdUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataCustomerIdUpdate).toBeUndefined();
    });
  });
});
