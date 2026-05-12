import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { EmailReplyService } from "./email-reply.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { EmailService } from "./email.service";
import { ChatSessionService } from "./chat-session.service";
import { CustomerService } from "./customer.service";
import { SessionService } from "./session.service";
import { ChannelAddressService } from "./channel-address.service";
import { EmailDebounceConfigService } from "./email-debounce-config.service";
import { ReplyOrchestratorService } from "./reply-orchestrator.service";
import { SCHEDULER_SERVICE } from "./scheduler.service";

const TABLE_NAME = "test-conversations-table";
const REPLY_DOMAIN = "reply.example.com";
const SESSION_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SENDER_EMAIL = "alice@example.com";
const INBOUND_MESSAGE_ID = "abc123@mail.example.com";

const DOMAIN_ROUTED_TO = `assistant@${REPLY_DOMAIN}`;
const ACCOUNT_ULID = "01BXACCNTACCT0000000000000";
const CUSTOMER_ULID = "01BXCSTMR00000000000000000";
const PRIOR_SESSION_ULID = "01BXPRYRSESSN0000000000000";
const NEW_SESSION_ULID = "01BXNEWSESSN00000000000000";
const FROM_NAME = "Test Concierge";

const VALID_HEADERS = `MIME-Version: 1.0\nMessage-ID: <${INBOUND_MESSAGE_ID}>\nContent-Type: text/plain`;

const VALID_FORM_FIELDS = {
  to: `${SESSION_ULID}@${REPLY_DOMAIN}`,
  from: SENDER_EMAIL,
  subject: "Hello there",
  text: "My new message.",
  headers: VALID_HEADERS,
};

const DOMAIN_ROUTED_FORM_FIELDS = {
  to: DOMAIN_ROUTED_TO,
  from: SENDER_EMAIL,
  subject: "Hello assistant",
  text: "My new message.",
  headers: VALID_HEADERS,
};

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const mockChannelAddressService = {
  getAccountByChannelAddress: jest.fn(),
};

const mockEmailService = { send: jest.fn() };
const mockChatSessionService = { appendUserMessage: jest.fn() };
const mockCustomerService = { queryCustomerIdByEmail: jest.fn() };
const mockSessionService = { lookupOrCreateSession: jest.fn() };
const mockReplyOrchestratorService = { generateAndSendReply: jest.fn() };
const mockSchedulerService = { createOrResetEmailFlush: jest.fn(), cancelEmailFlush: jest.fn(), getEmailFlushFireTime: jest.fn() };

// Default: debounce disabled (synchronous path)
let mockEmailDebounceConfig = { enabled: false, windowSeconds: 90 };

function makeActiveAccountItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity: "ACCOUNT",
    status: { is_active: true },
    channels: {
      email: {
        reply_domains: [REPLY_DOMAIN],
        reply_local_part: "assistant",
        from_name: FROM_NAME,
      },
    },
    ...overrides,
  };
}

describe("EmailReplyService", () => {
  let service: EmailReplyService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    mockEmailDebounceConfig = { enabled: false, windowSeconds: 90 };
    mockChannelAddressService.getAccountByChannelAddress.mockResolvedValue({ accountId: ACCOUNT_ULID });
    mockChatSessionService.appendUserMessage.mockResolvedValue(undefined);
    mockReplyOrchestratorService.generateAndSendReply.mockResolvedValue({ outcome: "replied", reply: "Hello!", toolOutputs: [] });
    mockSchedulerService.createOrResetEmailFlush.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailReplyService,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
        { provide: EmailService, useValue: mockEmailService },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: CustomerService, useValue: mockCustomerService },
        { provide: SessionService, useValue: mockSessionService },
        { provide: ChannelAddressService, useValue: mockChannelAddressService },
        { provide: EmailDebounceConfigService, useValue: mockEmailDebounceConfig },
        { provide: SCHEDULER_SERVICE, useValue: mockSchedulerService },
        { provide: ReplyOrchestratorService, useValue: mockReplyOrchestratorService },
      ],
    }).compile();

    service = module.get<EmailReplyService>(EmailReplyService);
  });

  // -------------------------------------------------------------------------
  // Case 1 — SESSION_ULID local-part (debounce DISABLED — synchronous path)
  // -------------------------------------------------------------------------

  describe("processInboundReply — Case 1 (SESSION_ULID local-part) — debounce DISABLED", () => {
    it("calls appendUserMessage with emailContext and generateAndSendReply; does NOT call createOrResetEmailFlush", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: SENDER_EMAIL } });

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        SESSION_ULID,
        "email",
        "My new message.",
        { messageId: INBOUND_MESSAGE_ID, subject: "Hello there", replyDomain: REPLY_DOMAIN, fromName: "" },
      );
      expect(mockReplyOrchestratorService.generateAndSendReply).toHaveBeenCalledWith(SESSION_ULID, "email");
      expect(mockSchedulerService.createOrResetEmailFlush).not.toHaveBeenCalled();
    });

    it("returns 'duplicate' on ConditionalCheckFailedException and does not call appendUserMessage", async () => {
      const conditionalError = Object.assign(new Error("Conditional check failed"), {
        name: "ConditionalCheckFailedException",
      });

      ddbMock.on(PutCommand).rejects(conditionalError);

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("duplicate");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_unknown_session' when no USER_CONTACT_INFO record exists", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_session");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_sender_mismatch' when from email does not match stored email", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: "different@example.com" } });

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("rejected_sender_mismatch");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_malformed' when body is empty after stripping quoted history", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: SENDER_EMAIL } });

      const allQuotedFields = {
        ...VALID_FORM_FIELDS,
        text: "> Entirely quoted content\n> Nothing new here",
      };

      const result = await service.processInboundReply(allQuotedFields);

      expect(result).toBe("rejected_malformed");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("propagates throws from replyOrchestratorService without catching", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: SENDER_EMAIL } });

      mockReplyOrchestratorService.generateAndSendReply.mockRejectedValue(new Error("Anthropic API failure"));

      await expect(service.processInboundReply(VALID_FORM_FIELDS)).rejects.toThrow("Anthropic API failure");
    });

    it("extracts bare email from display-name 'from' field format", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: "john@example.com" } });

      const displayNameFields = {
        ...VALID_FORM_FIELDS,
        from: '"John Smith" <john@example.com>',
      };

      const result = await service.processInboundReply(displayNameFields);

      expect(result).toBe("processed");
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

  // -------------------------------------------------------------------------
  // Case 1 — EMAIL_DEBOUNCE_ENABLED=true (debounce path)
  // -------------------------------------------------------------------------

  describe("processInboundReply — Case 1 (SESSION_ULID local-part) — debounce ENABLED", () => {
    beforeEach(() => {
      // Rebuild service with debounce enabled
      mockEmailDebounceConfig = { enabled: true, windowSeconds: 90 };
    });

    it("calls appendUserMessage with emailContext and createOrResetEmailFlush; does NOT call generateAndSendReply", async () => {
      // Rebuild module with debounce enabled
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailReplyService,
          {
            provide: DYNAMO_DB_CLIENT,
            useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
          },
          { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
          { provide: EmailService, useValue: mockEmailService },
          { provide: ChatSessionService, useValue: mockChatSessionService },
          { provide: CustomerService, useValue: mockCustomerService },
          { provide: SessionService, useValue: mockSessionService },
          { provide: ChannelAddressService, useValue: mockChannelAddressService },
          { provide: EmailDebounceConfigService, useValue: { enabled: true, windowSeconds: 90 } },
          { provide: SCHEDULER_SERVICE, useValue: mockSchedulerService },
          { provide: ReplyOrchestratorService, useValue: mockReplyOrchestratorService },
        ],
      }).compile();

      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: SENDER_EMAIL } });

      const debounceService = module.get<EmailReplyService>(EmailReplyService);
      const result = await debounceService.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        SESSION_ULID,
        "email",
        "My new message.",
        { messageId: INBOUND_MESSAGE_ID, subject: "Hello there", replyDomain: REPLY_DOMAIN, fromName: "" },
      );
      expect(mockSchedulerService.createOrResetEmailFlush).toHaveBeenCalledWith(
        SESSION_ULID,
        expect.any(Number),
      );
      // The fire time should be approximately now + 90s
      const fireAt = mockSchedulerService.createOrResetEmailFlush.mock.calls[0][1];
      expect(fireAt).toBeGreaterThan(Date.now() + 80_000);
      expect(fireAt).toBeLessThan(Date.now() + 100_000);

      expect(mockReplyOrchestratorService.generateAndSendReply).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Email context — appendUserMessage receives messageId + subject
  // -------------------------------------------------------------------------

  describe("emailContext passed to appendUserMessage (ADDENDUM)", () => {
    it("Case 1: passes { messageId, subject, replyDomain, fromName } to appendUserMessage", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: SENDER_EMAIL } });

      await service.processInboundReply(VALID_FORM_FIELDS);

      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        SESSION_ULID,
        "email",
        expect.any(String),
        { messageId: INBOUND_MESSAGE_ID, subject: "Hello there", replyDomain: REPLY_DOMAIN, fromName: "" },
      );
    });

    it("Case 2 (new session): passes { messageId, subject, replyDomain, fromName } to appendUserMessage", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        NEW_SESSION_ULID,
        "email",
        expect.any(String),
        { messageId: INBOUND_MESSAGE_ID, subject: "Hello assistant", replyDomain: REPLY_DOMAIN, fromName: FROM_NAME },
      );
    });

    it("Case 3 fresh: passes { messageId, subject, replyDomain, fromName } to appendUserMessage", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } })
        .resolvesOnce({ Item: { email: SENDER_EMAIL } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        PRIOR_SESSION_ULID,
        "email",
        expect.any(String),
        { messageId: INBOUND_MESSAGE_ID, subject: "Hello assistant", replyDomain: REPLY_DOMAIN, fromName: FROM_NAME },
      );
    });

    it("Case 3 stale: passes { messageId, subject, replyDomain, fromName } to appendUserMessage", async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: eightDaysAgo } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(
        NEW_SESSION_ULID,
        "email",
        expect.any(String),
        { messageId: INBOUND_MESSAGE_ID, subject: "Hello assistant", replyDomain: REPLY_DOMAIN, fromName: FROM_NAME },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Address parsing
  // -------------------------------------------------------------------------

  describe("processInboundReply — address parsing", () => {
    it("returns 'rejected_malformed' when to field has no parseable address", async () => {
      const badFields = { ...VALID_FORM_FIELDS, to: "not-an-email" };

      const result = await service.processInboundReply(badFields);

      expect(result).toBe("rejected_malformed");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it("26-char Crockford ULID local-part routes to Case 1 (SESSION_ULID)", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: { email: SENDER_EMAIL } });

      const result = await service.processInboundReply(VALID_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(SESSION_ULID, "email", "My new message.", expect.any(Object));
    });

    it("multi-address To: field uses the first parseable address for domain lookup", async () => {
      mockChannelAddressService.getAccountByChannelAddress.mockResolvedValue({ accountId: ACCOUNT_ULID });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const multiToFields = {
        ...DOMAIN_ROUTED_FORM_FIELDS,
        to: `assistant@${REPLY_DOMAIN}, other@other.example.com`,
      };

      const result = await service.processInboundReply(multiToFields);

      expect(result).toBe("processed");
      expect(mockChannelAddressService.getAccountByChannelAddress).toHaveBeenCalledWith(
        "email_reply_domain",
        REPLY_DOMAIN,
      );
    });

    it("non-ULID local-part routes to DOMAIN_ROUTED (not rejected immediately)", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        onboardingData: null,
        wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockChannelAddressService.getAccountByChannelAddress).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Domain-routed account resolution
  // -------------------------------------------------------------------------

  describe("handleDomainRoutedEntry — account resolution", () => {
    it("returns 'rejected_unknown_account' when channel address lookup returns null", async () => {
      mockChannelAddressService.getAccountByChannelAddress.mockResolvedValue(null);

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_account");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("calls channel address service with EMAIL_REPLY_DOMAIN and the inbound domain", async () => {
      mockChannelAddressService.getAccountByChannelAddress.mockResolvedValue(null);

      await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(mockChannelAddressService.getAccountByChannelAddress).toHaveBeenCalledWith(
        "email_reply_domain",
        REPLY_DOMAIN,
      );
    });

    it("returns 'rejected_unknown_account' when account record has status.is_active === false", async () => {
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem({ status: { is_active: false } }) });

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_account");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_unknown_account' when account record has entity !== ACCOUNT", async () => {
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem({ entity: "SOMETHING_ELSE" }) });

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_account");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_unknown_account' when account GetItem returns no item", async () => {
      ddbMock.on(GetCommand).resolvesOnce({ Item: undefined });

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_account");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("returns 'rejected_unknown_local_part' when local-part does not match account's reply_local_part", async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: makeActiveAccountItem({
          channels: { email: { reply_domains: [REPLY_DOMAIN], reply_local_part: "concierge", from_name: FROM_NAME } },
        }),
      });

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("rejected_unknown_local_part");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("local-part validation is case-insensitive", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const upperFields = { ...DOMAIN_ROUTED_FORM_FIELDS, to: `ASSISTANT@${REPLY_DOMAIN}` };
      const result = await service.processInboundReply(upperFields);

      expect(result).toBe("processed");
    });

    it("defaults reply_local_part to 'assistant' when account has no channels config", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: { entity: "ACCOUNT", status: { is_active: true } } });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
    });
  });

  // -------------------------------------------------------------------------
  // Outbound send — per-account branding
  // -------------------------------------------------------------------------

  describe("handleDomainRoutedEntry — per-account branding on outbound send", () => {
    it("passes account's replyDomain and fromName to generateAndSendReply path (Case 2)", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      // In the synchronous path, the orchestrator handles sending — no direct emailService.send call
      expect(mockReplyOrchestratorService.generateAndSendReply).toHaveBeenCalledWith(NEW_SESSION_ULID, "email");
    });
  });

  // -------------------------------------------------------------------------
  // Case 2 — unknown sender (domain-routed path)
  // -------------------------------------------------------------------------

  describe("Case 2 — unknown sender (domain-routed)", () => {
    it("unknown sender creates new session, calls appendUserMessage, calls generateAndSendReply", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("email", null, "lead_capture", ACCOUNT_ULID);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const contactInfoUpdate = updateCalls.find((call) => call.args[0].input.Key?.SK === "USER_CONTACT_INFO");
      expect(contactInfoUpdate).toBeDefined();
      expect(contactInfoUpdate!.args[0].input.UpdateExpression).toContain("if_not_exists(email");

      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(NEW_SESSION_ULID, "email", "My new message.", expect.any(Object));

      const metadataUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "METADATA" && call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataUpdate).toBeUndefined();
    });

    it("dedup: second identical domain-routed email returns duplicate", async () => {
      const conditionalError = Object.assign(new Error("Conditional check failed"), { name: "ConditionalCheckFailedException" });
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      ddbMock.on(PutCommand).rejects(conditionalError);

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("duplicate");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("Case 2 empty body after strip returns rejected_malformed", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const allQuotedFields = { ...DOMAIN_ROUTED_FORM_FIELDS, text: "> Entirely quoted content\n> Nothing new here" };

      const result = await service.processInboundReply(allQuotedFields);

      expect(result).toBe("rejected_malformed");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 3 fresh — known sender, recent session (domain-routed path)
  // -------------------------------------------------------------------------

  describe("Case 3 fresh — known sender, recent session (domain-routed)", () => {
    it("known sender with session < 7 days old calls appendUserMessage with existing session", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } })
        .resolvesOnce({ Item: { email: SENDER_EMAIL } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(PRIOR_SESSION_ULID, "email", "My new message.", expect.any(Object));
      expect(mockSessionService.lookupOrCreateSession).not.toHaveBeenCalled();

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataCustomerIdUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "METADATA" && call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataCustomerIdUpdate).toBeUndefined();
    });

    it("Case 3 fresh: sender mismatch returns rejected_sender_mismatch", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } })
        .resolvesOnce({ Item: { email: "different@example.com" } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("rejected_sender_mismatch");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });

    it("Case 3 fresh: empty body after strip returns rejected_malformed", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: twoHoursAgo } })
        .resolvesOnce({ Item: { email: SENDER_EMAIL } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      const allQuotedFields = { ...DOMAIN_ROUTED_FORM_FIELDS, text: "> Entirely quoted content\n> Nothing new here" };

      const result = await service.processInboundReply(allQuotedFields);

      expect(result).toBe("rejected_malformed");
      expect(mockChatSessionService.appendUserMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 3 stale — known sender, old session (domain-routed path)
  // -------------------------------------------------------------------------

  describe("Case 3 stale — known sender, old session (domain-routed)", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    it("known sender with session >= 7 days old creates new linked session and calls appendUserMessage", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: eightDaysAgo } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("email", null, "lead_capture", ACCOUNT_ULID);
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(NEW_SESSION_ULID, "email", "My new message.", expect.any(Object));

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "METADATA" && call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataUpdate).toBeDefined();
      const expr = metadataUpdate!.args[0].input.UpdateExpression!;
      const values = metadataUpdate!.args[0].input.ExpressionAttributeValues!;
      expect(values[":customerId"]).toBe(`C#${CUSTOMER_ULID}`);
      expect(values[":contFrom"]).toBe(`CHAT_SESSION#${PRIOR_SESSION_ULID}`);
      expect(expr).not.toContain("continuation_loaded_at");
      expect(values).not.toHaveProperty(":contAt");
    });

    it("Case 3 stale with null latestSessionId writes continuation_from_session_id = null", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: null,
      });

      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "METADATA" && call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataUpdate).toBeDefined();
      expect(metadataUpdate!.args[0].input.ExpressionAttributeValues![":contFrom"]).toBeNull();
    });

    it("Case 3 stale: prior session METADATA not found treats as stale and creates new linked session", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: undefined });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
    });

    it("Case 3 stale: USER_CONTACT_INFO write uses if_not_exists", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: eightDaysAgo } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const contactInfoUpdate = updateCalls.find((call) => call.args[0].input.Key?.SK === "USER_CONTACT_INFO");
      expect(contactInfoUpdate).toBeDefined();
      expect(contactInfoUpdate!.args[0].input.UpdateExpression).toContain("if_not_exists(email");
    });
  });

  // -------------------------------------------------------------------------
  // Freshness boundary cases (domain-routed path)
  // -------------------------------------------------------------------------

  describe("freshness boundary cases (domain-routed)", () => {
    it("7 days or older is STALE — creates new linked session", async () => {
      const atLeastSevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: atLeastSevenDaysAgo } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(NEW_SESSION_ULID, "email", "My new message.", expect.any(Object));
    });

    it("one hour under 7 days is FRESH — appends to existing session", async () => {
      const justUnder7Days = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)).toISOString();

      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: justUnder7Days } })
        .resolvesOnce({ Item: { email: SENDER_EMAIL } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).not.toHaveBeenCalled();
      expect(mockChatSessionService.appendUserMessage).toHaveBeenCalledWith(PRIOR_SESSION_ULID, "email", "My new message.", expect.any(Object));
    });

    it("unparseable _lastUpdated_ timestamp treats as stale", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: makeActiveAccountItem() })
        .resolvesOnce({ Item: { _lastUpdated_: "not-a-date" } });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({
        customerUlid: CUSTOMER_ULID,
        latestSessionId: PRIOR_SESSION_ULID,
      });
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // customer-not-found in domain-routed branch
  // -------------------------------------------------------------------------

  describe("customer-not-found in domain-routed branch", () => {
    it("domain-routed entry but customer not in GSI falls through to Case 2 (new session, no customer link)", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(GetCommand).resolvesOnce({ Item: makeActiveAccountItem() });
      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);
      mockSessionService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: NEW_SESSION_ULID, onboardingCompletedAt: null, kickoffCompletedAt: null, onboardingData: null, wasCreated: true,
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.processInboundReply(DOMAIN_ROUTED_FORM_FIELDS);

      expect(result).toBe("processed");
      expect(mockSessionService.lookupOrCreateSession).toHaveBeenCalledWith("email", null, "lead_capture", ACCOUNT_ULID);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataCustomerIdUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "METADATA" && call.args[0].input.UpdateExpression?.includes("customer_id"),
      );
      expect(metadataCustomerIdUpdate).toBeUndefined();
    });
  });
});
