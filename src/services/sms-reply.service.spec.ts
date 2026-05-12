import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { SmsReplyService } from "./sms-reply.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { TwilioConfigService } from "./twilio-config.service";
import { ChatSessionService } from "./chat-session.service";
import { CustomerService } from "./customer.service";
import { SessionService } from "./session.service";
import { ChannelAddressService } from "./channel-address.service";
import { ReplyOrchestratorService } from "./reply-orchestrator.service";

const TABLE_NAME = "test-conversations-table";
const ACCOUNT_ID = "01BXACCNTACCT0000000000000";
const CUSTOMER_ULID = "01BXCSTMR00000000000000000";
const PRIOR_SESSION_ULID = "01BXPRYRSESSN0000000000000";
const NEW_SESSION_ULID = "01BXNEWSESSN00000000000000";
const SENDER_PHONE = "+15551234567";
const INBOUND_TO_NUMBER = "+15558675309";
const MESSAGE_SID = "SMabc123def456ghi789jkl012mno345pq";

const VALID_FORM_FIELDS = {
  MessageSid: MESSAGE_SID,
  AccountSid: "ACfakeaccountsid",
  From: SENDER_PHONE,
  To: INBOUND_TO_NUMBER,
  Body: "Hello, I need help.",
};

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };
const mockTwilioConfig = { authToken: "", accountSid: "", publicWebhookUrl: "" };

const mockChatSessionService = { appendUserMessage: jest.fn() };
const mockCustomerService = { queryCustomerIdByPhone: jest.fn() };
const mockSessionService = { lookupOrCreateSession: jest.fn() };
const mockReplyOrchestratorService = {
  generateAndSendReply: jest.fn(),
};

const mockChannelAddressService = {
  getAccountByChannelAddress: jest.fn(),
};

describe("SmsReplyService", () => {
  let service: SmsReplyService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    mockChannelAddressService.getAccountByChannelAddress.mockResolvedValue({ accountId: ACCOUNT_ID });
    mockChatSessionService.appendUserMessage.mockResolvedValue(undefined);
    mockReplyOrchestratorService.generateAndSendReply.mockResolvedValue({
      outcome: "replied",
      reply: "Welcome!",
      toolOutputs: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsReplyService,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
        { provide: TwilioConfigService, useValue: mockTwilioConfig },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: CustomerService, useValue: mockCustomerService },
        { provide: SessionService, useValue: mockSessionService },
        { provide: ChannelAddressService, useValue: mockChannelAddressService },
        { provide: ReplyOrchestratorService, useValue: mockReplyOrchestratorService },
      ],
    }).compile();

    service = module.get<SmsReplyService>(SmsReplyService);
  });

  // ---------------------------------------------------------------------------
  // Guard / rejection cases
  // ---------------------------------------------------------------------------

  it("returns rejected_unknown_account when channel address lookup returns null", async () => {
    mockChannelAddressService.getAccountByChannelAddress.mockResolvedValue(null);

    const result = await service.processInboundMessage(VALID_FORM_FIELDS);

    expect(result).toBe("rejected_unknown_account");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
  });

  it("queries channel address service with TWILIO_NUMBER type and the inbound To number", async () => {
    mockChannelAddressService.getAccountByChannelAddress.mockResolvedValue(null);

    await service.processInboundMessage(VALID_FORM_FIELDS);

    expect(mockChannelAddressService.getAccountByChannelAddress).toHaveBeenCalledWith(
      "twilio_number",
      INBOUND_TO_NUMBER,
    );
  });

  it("returns rejected_malformed when From phone is not E.164", async () => {
    const badFields = { ...VALID_FORM_FIELDS, From: "5551234567" };

    const result = await service.processInboundMessage(badFields);

    expect(result).toBe("rejected_malformed");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns rejected_malformed when Body is empty", async () => {
    const emptyBodyFields = { ...VALID_FORM_FIELDS, Body: "   " };

    const result = await service.processInboundMessage(emptyBodyFields);

    expect(result).toBe("rejected_malformed");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns duplicate on ConditionalCheckFailedException and does not call appendUserMessage", async () => {
    const conditionalError = Object.assign(new Error("Conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.on(PutCommand).rejects(conditionalError);

    const result = await service.processInboundMessage(VALID_FORM_FIELDS);

    expect(result).toBe("duplicate");
    expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 2 — cold entry (phone unknown to account)
  // ---------------------------------------------------------------------------

  describe("Case 2 — cold entry (phone unknown to account)", () => {
    it("mints new session, stamps phone with if_not_exists, calls appendUserMessage with sms channel, calls generateAndSendReply, returns processed", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByPhone.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundMessage(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("sms", null, "lead_capture", ACCOUNT_ID);
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        NEW_SESSION_ULID,
        "sms",
        VALID_FORM_FIELDS.Body,
      );
      expect(mockReplyOrchestratorService.generateAndSendReply).toHaveBeenCalledWith(
        NEW_SESSION_ULID,
        "sms",
        { sms: { to: SENDER_PHONE, from: INBOUND_TO_NUMBER } },
      );

      // USER_CONTACT_INFO update must use if_not_exists
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const contactInfoUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "USER_CONTACT_INFO",
      );
      expect(contactInfoUpdate).toBeDefined();
      expect(contactInfoUpdate!.args[0].input.UpdateExpression).toContain("if_not_exists(phone");

      // Dedupe record must be backfilled with the resolved sessionId
      const dedupeUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.PK === `SMS_INBOUND#${MESSAGE_SID}` &&
          call.args[0].input.Key?.SK === "METADATA",
      );
      expect(dedupeUpdate).toBeDefined();
      expect(dedupeUpdate!.args[0].input.ExpressionAttributeValues?.[":sessionId"]).toBe(
        `CHAT_SESSION#${NEW_SESSION_ULID}`,
      );
    });

    it("appendUserMessage is called with no emailContext argument for sms channel", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByPhone.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      await service.processInboundMessage(VALID_FORM_FIELDS);

      // Only 3 positional args — no emailContext
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        NEW_SESSION_ULID,
        "sms",
        VALID_FORM_FIELDS.Body,
      );
      expect(mockChatSessionService.appendUserMessage.mock.calls[0]).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Case 3 fresh — known sender, recent session
  // ---------------------------------------------------------------------------

  describe("Case 3 fresh — known sender, recent session", () => {
    it("attaches to existing session, stamps phone with if_not_exists, calls appendUserMessage, calls generateAndSendReply with sms context", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByPhone.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });
      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundMessage(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      // Existing session must be used — no new session created
      expect(mockSessionService.lookupOrCreateSession).not.toHaveBeenCalled();
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        PRIOR_SESSION_ULID,
        "sms",
        VALID_FORM_FIELDS.Body,
      );
      expect(mockReplyOrchestratorService.generateAndSendReply).toHaveBeenCalledWith(
        PRIOR_SESSION_ULID,
        "sms",
        { sms: { to: SENDER_PHONE, from: INBOUND_TO_NUMBER } },
      );

      // USER_CONTACT_INFO update must use if_not_exists
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const contactInfoUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "USER_CONTACT_INFO",
      );
      expect(contactInfoUpdate).toBeDefined();
      expect(contactInfoUpdate!.args[0].input.UpdateExpression).toContain("if_not_exists(phone");

      // Dedupe record must be backfilled with the resolved sessionId (existing session)
      const dedupeUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.PK === `SMS_INBOUND#${MESSAGE_SID}` &&
          call.args[0].input.Key?.SK === "METADATA",
      );
      expect(dedupeUpdate).toBeDefined();
      expect(dedupeUpdate!.args[0].input.ExpressionAttributeValues?.[":sessionId"]).toBe(
        `CHAT_SESSION#${PRIOR_SESSION_ULID}`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Case 3 stale — known sender, old session
  // ---------------------------------------------------------------------------

  describe("Case 3 stale — known sender, old session", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    it("creates new linked session with customer_id and continuation_from_session_id, calls appendUserMessage, calls generateAndSendReply", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByPhone.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });
      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: eightDaysAgo } });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundMessage(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("sms", null, "lead_capture", ACCOUNT_ID);
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        NEW_SESSION_ULID,
        "sms",
        VALID_FORM_FIELDS.Body,
      );
      expect(mockReplyOrchestratorService.generateAndSendReply).toHaveBeenCalledWith(
        NEW_SESSION_ULID,
        "sms",
        { sms: { to: SENDER_PHONE, from: INBOUND_TO_NUMBER } },
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );

      expect(metadataUpdate).toBeDefined();
      const expr = metadataUpdate!.args[0].input.UpdateExpression!;
      const values = metadataUpdate!.args[0].input.ExpressionAttributeValues!;
      expect(values[":customerId"]).toBe(`C#${CUSTOMER_ULID}`);
      expect(values[":contFrom"]).toBe(`CHAT_SESSION#${PRIOR_SESSION_ULID}`);

      // Inverse assertions: continuation_loaded_at must NOT be pre-initialized
      expect(expr).not.toContain("continuation_loaded_at");
      expect(values).not.toHaveProperty(":contLoadedAt");

      // Dedupe record must be backfilled with the resolved sessionId
      const dedupeUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.PK === `SMS_INBOUND#${MESSAGE_SID}` &&
          call.args[0].input.Key?.SK === "METADATA",
      );
      expect(dedupeUpdate).toBeDefined();
      expect(dedupeUpdate!.args[0].input.ExpressionAttributeValues?.[":sessionId"]).toBe(
        `CHAT_SESSION#${NEW_SESSION_ULID}`,
      );
    });

    it("Case 3 stale with null latestSessionId calls stale path with null", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByPhone.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: null,
      });
      // No GetCommand needed — latestSessionId is null, goes straight to stale
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundMessage(VALID_FORM_FIELDS);

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
      // continuation_from_session_id must be null when no prior session exists
      expect(values[":contFrom"]).toBeNull();

      // Dedupe record must be backfilled with the resolved sessionId
      const dedupeUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.PK === `SMS_INBOUND#${MESSAGE_SID}` &&
          call.args[0].input.Key?.SK === "METADATA",
      );
      expect(dedupeUpdate).toBeDefined();
      expect(dedupeUpdate!.args[0].input.ExpressionAttributeValues?.[":sessionId"]).toBe(
        `CHAT_SESSION#${NEW_SESSION_ULID}`,
      );
    });

    it("Case 3 stale: prior session METADATA not found treats as stale and creates new linked session", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByPhone.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });
      ddbMock.on(GetCommand).resolvesOnce({ Item: undefined });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundMessage(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
    });

    it("Case 3 stale: prior session METADATA has bad timestamp treats as stale and does NOT include continuation_loaded_at", async () => {
      ddbMock.on(PutCommand).resolves({});
      mockCustomerService.queryCustomerIdByPhone.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });
      ddbMock.on(GetCommand).resolvesOnce({ Item: { _lastUpdated_: "not-a-date" } });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundMessage(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) =>
          call.args[0].input.Key?.SK === "METADATA" &&
          call.args[0].input.UpdateExpression?.includes("customer_id"),
      );

      expect(metadataUpdate).toBeDefined();
      const expr = metadataUpdate!.args[0].input.UpdateExpression!;
      const values = metadataUpdate!.args[0].input.ExpressionAttributeValues!;
      // Inverse assertions: continuation_loaded_at must NOT be pre-initialized
      expect(expr).not.toContain("continuation_loaded_at");
      expect(values).not.toHaveProperty(":contLoadedAt");
    });
  });
});
