/**
 * Cross-channel integration spec.
 *
 * Uses the real SchedulerFakeService (not mocked) to exercise the coherence
 * contract: every call to generateAndSendReply cancels any pending email
 * schedule for the session, regardless of which channel fired.
 *
 * DynamoDB is mocked via aws-sdk-client-mock. AnthropicService, EmailService,
 * and SmsService are mocked at the NestJS provider level.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { ReplyOrchestratorService } from "./reply-orchestrator.service";
import { SchedulerFakeService } from "./scheduler-fake.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { AnthropicService } from "./anthropic.service";
import { EmailService } from "./email.service";
import { SmsService } from "./sms.service";
import { ToolRegistryService } from "../tools/tool-registry.service";
import { AgentRegistryService } from "../agents/agent-registry.service";
import { SCHEDULER_SERVICE } from "./scheduler.service";

const TABLE_NAME = "test-conversations-table";
const SESSION_ULID = "01CROSSCHSESSN0000000000000";
const ACCOUNT_ULID = "01CROSSCHACCT000000000000000";
const SESSION_PK = `CHAT_SESSION#${SESSION_ULID}`;
const SENDER_EMAIL = "user@example.com";

const mockDatabaseConfig = {
  conversationsTable: TABLE_NAME,
  region: "us-east-1",
};

const mockAnthropicService = {
  sendMessage: jest.fn(),
};

const mockEmailService = {
  send: jest.fn(),
};

const mockSmsService = {
  send: jest.fn(),
};

const mockToolRegistry = {
  getDefinitions: jest.fn().mockReturnValue([]),
  getAll: jest.fn().mockReturnValue([]),
  execute: jest.fn(),
};

const mockAgent = {
  name: "lead_capture",
  displayName: "Lead Capture",
  systemPrompt: "You are a helpful assistant.",
  splash: null,
  allowedToolNames: [],
};

const mockAgentRegistry = {
  getByName: jest.fn().mockReturnValue(mockAgent),
};

function makeEndTurnResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  };
}

describe("ReplyOrchestratorService — cross-channel integration", () => {
  let service: ReplyOrchestratorService;
  let fakeScheduler: SchedulerFakeService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    mockAgentRegistry.getByName.mockReturnValue(mockAgent);
    mockToolRegistry.getDefinitions.mockReturnValue([]);
    mockToolRegistry.getAll.mockReturnValue([]);
    mockEmailService.send.mockResolvedValue({ messageId: "outbound-id" });

    fakeScheduler = new SchedulerFakeService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReplyOrchestratorService,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
        { provide: AnthropicService, useValue: mockAnthropicService },
        { provide: EmailService, useValue: mockEmailService },
        { provide: SmsService, useValue: mockSmsService },
        { provide: ToolRegistryService, useValue: mockToolRegistry },
        { provide: AgentRegistryService, useValue: mockAgentRegistry },
        { provide: SCHEDULER_SERVICE, useValue: fakeScheduler },
      ],
    }).compile();

    service = module.get<ReplyOrchestratorService>(ReplyOrchestratorService);
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: email burst then web reply cancels schedule
  // ---------------------------------------------------------------------------

  describe("Scenario 1: email burst, then web reply cancels pending email schedule", () => {
    it("email schedule is overwritten on second email; web reply cancels schedule; subsequent email schedule fire returns no_op", async () => {
      // --- Step 1: Email 1 arrives ---
      // Simulate appendUserMessage already written to DDB by caller (emailReplyService).
      // The orchestrator reads from DDB; we stub it to show 1 user message.
      const email1FireAt = Date.now() + 90_000;
      await fakeScheduler.createOrResetEmailFlush(SESSION_ULID, email1FireAt);

      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBe(email1FireAt);

      // --- Step 2: Email 2 arrives — schedule is overwritten with later fire time ---
      const email2FireAt = Date.now() + 90_000 + 30_000; // 30s later
      await fakeScheduler.createOrResetEmailFlush(SESSION_ULID, email2FireAt);

      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBe(email2FireAt);

      // --- Step 3: Web message arrives → generateAndSendReply("web") ---
      // History shows 2 email user messages + 1 web user message, no assistant reply yet.
      ddbMock
        .on(GetCommand, { TableName: TABLE_NAME, Key: { PK: SESSION_PK, SK: "METADATA" } })
        .resolves({
          Item: { agent_name: "lead_capture", account_id: `A#${ACCOUNT_ULID}` },
        });

      ddbMock.on(QueryCommand).resolves({
        Items: [
          { PK: SESSION_PK, SK: "MESSAGE#00", role: "user", content: JSON.stringify([{ type: "text", text: "Email 1" }]), channel: "email", _createdAt_: new Date().toISOString() },
          { PK: SESSION_PK, SK: "MESSAGE#01", role: "user", content: JSON.stringify([{ type: "text", text: "Email 2" }]), channel: "email", _createdAt_: new Date().toISOString() },
          { PK: SESSION_PK, SK: "MESSAGE#02", role: "user", content: JSON.stringify([{ type: "text", text: "Web message" }]), channel: "web", _createdAt_: new Date().toISOString() },
        ],
      });

      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Consolidated reply covering all messages."));

      const webResult = await service.generateAndSendReply(SESSION_ULID, "web");

      expect(webResult.outcome).toBe("replied");
      expect(webResult).toHaveProperty("reply", "Consolidated reply covering all messages.");

      // --- Assert: email schedule cancelled ---
      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBeNull();

      // --- Step 4: Simulate email schedule fire after cancellation ---
      // History now has an assistant reply, so no outstanding messages remain.
      ddbMock
        .on(GetCommand, { TableName: TABLE_NAME, Key: { PK: SESSION_PK, SK: "METADATA" } })
        .resolves({
          Item: { agent_name: "lead_capture", account_id: `A#${ACCOUNT_ULID}` },
        });

      ddbMock.on(QueryCommand).resolves({
        Items: [
          // Assistant reply already written — newest-first (ScanIndexForward: false)
          { PK: SESSION_PK, SK: "MESSAGE#03", role: "assistant", content: JSON.stringify([{ type: "text", text: "Consolidated reply covering all messages." }]), _createdAt_: new Date().toISOString() },
          { PK: SESSION_PK, SK: "MESSAGE#02", role: "user", content: JSON.stringify([{ type: "text", text: "Web message" }]), channel: "web", _createdAt_: new Date().toISOString() },
          { PK: SESSION_PK, SK: "MESSAGE#01", role: "user", content: JSON.stringify([{ type: "text", text: "Email 2" }]), channel: "email", _createdAt_: new Date().toISOString() },
          { PK: SESSION_PK, SK: "MESSAGE#00", role: "user", content: JSON.stringify([{ type: "text", text: "Email 1" }]), channel: "email", _createdAt_: new Date().toISOString() },
        ],
      });

      // Simulated schedule fire with channel "email"
      const emailFireResult = await service.generateAndSendReply(SESSION_ULID, "email");

      // No outstanding messages → no-op
      expect(emailFireResult).toEqual({ outcome: "no_op_nothing_outstanding" });
      // emailService.send must NOT be called for the stale fire
      expect(mockEmailService.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: email schedule fires with no prior reply → outstanding messages → email sent
  // ---------------------------------------------------------------------------

  describe("Scenario 2: email schedule fires normally — generates and sends email reply", () => {
    it("when email schedule fires and messages are outstanding, sends email reply and cancels schedule", async () => {
      // Pre-seed the fake scheduler (representing a live schedule)
      await fakeScheduler.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000);

      // History: 2 email user messages, no assistant reply
      ddbMock
        .on(GetCommand, { TableName: TABLE_NAME, Key: { PK: SESSION_PK, SK: "METADATA" } })
        .resolves({
          Item: {
            agent_name: "lead_capture",
            account_id: `A#${ACCOUNT_ULID}`,
            last_inbound_email_message_id: "<thread-123@mail.example.com>",
            last_inbound_email_subject: "Help with my dog",
          },
        });

      ddbMock
        .on(GetCommand, { TableName: TABLE_NAME, Key: { PK: SESSION_PK, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: { email: SENDER_EMAIL } });

      ddbMock.on(QueryCommand).resolves({
        Items: [
          { PK: SESSION_PK, SK: "MESSAGE#00", role: "user", content: JSON.stringify([{ type: "text", text: "Question 1" }]), channel: "email", _createdAt_: new Date().toISOString() },
          { PK: SESSION_PK, SK: "MESSAGE#01", role: "user", content: JSON.stringify([{ type: "text", text: "Question 2" }]), channel: "email", _createdAt_: new Date().toISOString() },
        ],
      });

      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Here is a consolidated answer."));

      const result = await service.generateAndSendReply(SESSION_ULID, "email");

      expect(result.outcome).toBe("replied");
      expect(result).toHaveProperty("reply", "Here is a consolidated answer.");

      // Email was sent with correct threading headers
      expect(mockEmailService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: SENDER_EMAIL,
          subject: "Re: Help with my dog",
          inReplyToMessageId: "<thread-123@mail.example.com>",
          referencesMessageId: "<thread-123@mail.example.com>",
        }),
      );

      // Schedule was cancelled after sending
      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBeNull();
    });
  });
});
