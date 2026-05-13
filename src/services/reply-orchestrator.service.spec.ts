import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { ReplyOrchestratorService } from "./reply-orchestrator.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { AnthropicService } from "./anthropic.service";
import { EmailService } from "./email.service";
import { SmsService } from "./sms.service";
import { ToolRegistryService } from "../tools/tool-registry.service";
import { AgentRegistryService } from "../agents/agent-registry.service";
import { SchedulerFakeService } from "./scheduler-fake.service";
import { SCHEDULER_SERVICE } from "./scheduler.service";

const TABLE_NAME = "test-conversations-table";
const SESSION_ULID = "01ORCHSESSN0000000000000000";
const ACCOUNT_ULID = "01ORCHACCT00000000000000000";

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

const SESSION_PK = `CHAT_SESSION#${SESSION_ULID}`;

/** Returns a standard anthropic end_turn response with a text block. */
function makeEndTurnResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  };
}

describe("ReplyOrchestratorService", () => {
  let service: ReplyOrchestratorService;
  let fakeScheduler: SchedulerFakeService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    // Reset agent registry to default happy mock
    mockAgentRegistry.getByName.mockReturnValue(mockAgent);
    mockToolRegistry.getDefinitions.mockReturnValue([]);
    mockToolRegistry.getAll.mockReturnValue([]);

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
  // Helpers — DDB stubs
  // ---------------------------------------------------------------------------

  function stubSessionWithMessages(
    messages: Array<{ role: string; content: string; channel?: string }>,
    metadataOverrides: Record<string, unknown> = {},
  ): void {
    ddbMock
      .on(GetCommand, {
        TableName: TABLE_NAME,
        Key: { PK: SESSION_PK, SK: "METADATA" },
      })
      .resolves({
        Item: {
          agent_name: "lead_capture",
          account_id: `A#${ACCOUNT_ULID}`,
          ...metadataOverrides,
        },
      });

    ddbMock.on(QueryCommand).resolves({
      Items: messages.map((msg, i) => ({
        PK: SESSION_PK,
        SK: `MESSAGE#0000000000000000000${i}`,
        role: msg.role,
        content: JSON.stringify([{ type: "text", text: msg.content }]),
        channel: msg.channel ?? "web",
        _createdAt_: new Date().toISOString(),
      })),
    });

    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
  }

  function stubContactInfo(email: string): void {
    ddbMock
      .on(GetCommand, {
        TableName: TABLE_NAME,
        Key: { PK: SESSION_PK, SK: "USER_CONTACT_INFO" },
      })
      .resolves({ Item: { email } });
  }

  // ---------------------------------------------------------------------------
  // Happy path — web channel
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — web channel happy path", () => {
    it("returns { outcome: 'replied', reply, toolOutputs: [] } and calls cancelEmailFlush", async () => {
      stubSessionWithMessages([{ role: "user", content: "Hello!" }]);
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Hi there!"));

      // Pre-seed a schedule to confirm it gets cancelled
      await fakeScheduler.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000);

      const result = await service.generateAndSendReply(SESSION_ULID, "web");

      expect(result).toEqual({ outcome: "replied", reply: "Hi there!", toolOutputs: [] });
      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBeNull();
    });

    it("does not call emailService.send or smsService.send for web channel", async () => {
      stubSessionWithMessages([{ role: "user", content: "Hello!" }]);
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Hi!"));

      await service.generateAndSendReply(SESSION_ULID, "web");

      expect(mockEmailService.send).not.toHaveBeenCalled();
      expect(mockSmsService.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path — SMS channel
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — sms channel", () => {
    it("calls smsService.send with correct args and cancels the email schedule", async () => {
      stubSessionWithMessages([{ role: "user", content: "Text me back.", channel: "sms" }]);
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("On it!"));
      mockSmsService.send.mockResolvedValue({ messageSid: "SMxxx" });

      await fakeScheduler.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000);

      const result = await service.generateAndSendReply(SESSION_ULID, "sms", {
        sms: { to: "+15551234567", from: "+18885550000" },
      });

      expect(result).toEqual({ outcome: "replied", reply: "On it!", toolOutputs: [] });
      expect(mockSmsService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "+15551234567",
          from: "+18885550000",
          body: "On it!",
          sessionUlid: SESSION_ULID,
        }),
      );
      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path — email channel with null sendContext (schedule-fire path)
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — email channel (schedule-fire path)", () => {
    it("reads USER_CONTACT_INFO and calls emailService.send with correct threading headers and branding", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Help me please.", channel: "email" }],
        {
          last_inbound_email_message_id: "<abc123@mail.example.com>",
          last_inbound_email_subject: "Help request",
          reply_domain: "reply.example.com",
          from_name: "Test Concierge",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Here to help!"));
      mockEmailService.send.mockResolvedValue({ messageId: "outbound-id" });

      const result = await service.generateAndSendReply(SESSION_ULID, "email");

      expect(result).toEqual({ outcome: "replied", reply: "Here to help!", toolOutputs: [] });
      expect(mockEmailService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: "Re: Help request",
          inReplyToMessageId: "<abc123@mail.example.com>",
          referencesMessageId: "<abc123@mail.example.com>",
          sessionUlid: SESSION_ULID,
          replyDomain: "reply.example.com",
          fromName: "Test Concierge",
        }),
      );
    });

    it("uses subject as-is when it already starts with 'Re:'", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Follow-up.", channel: "email" }],
        {
          last_inbound_email_message_id: "<xyz@mail.example.com>",
          last_inbound_email_subject: "Re: Help request",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Got it!"));
      mockEmailService.send.mockResolvedValue({});

      await service.generateAndSendReply(SESSION_ULID, "email");

      const sendCall = mockEmailService.send.mock.calls[0][0];
      expect(sendCall.subject).toBe("Re: Help request");
    });

    it("prefixes 'Re: ' when subject does not already start with 'Re:'", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Question.", channel: "email" }],
        {
          last_inbound_email_message_id: "<xyz@mail.example.com>",
          last_inbound_email_subject: "My original subject",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Answer!"));
      mockEmailService.send.mockResolvedValue({});

      await service.generateAndSendReply(SESSION_ULID, "email");

      const sendCall = mockEmailService.send.mock.calls[0][0];
      expect(sendCall.subject).toBe("Re: My original subject");
    });
  });

  // ---------------------------------------------------------------------------
  // Email threading — message-id threading headers
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — email threading (ADDENDUM)", () => {
    it("passes last_inbound_email_message_id as both inReplyToMessageId and referencesMessageId", async () => {
      const msgId = "<thread-id-123@mail.example.com>";

      stubSessionWithMessages(
        [{ role: "user", content: "Thread me.", channel: "email" }],
        {
          last_inbound_email_message_id: msgId,
          last_inbound_email_subject: "Thread subject",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Threaded reply!"));
      mockEmailService.send.mockResolvedValue({});

      await service.generateAndSendReply(SESSION_ULID, "email");

      const sendCall = mockEmailService.send.mock.calls[0][0];
      expect(sendCall.inReplyToMessageId).toBe(msgId);
      expect(sendCall.referencesMessageId).toBe(msgId);
    });

    it("logs email_flush_missing_threading_context and falls back to 'Re: your message' when last_inbound_email_message_id is absent", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "No metadata here.", channel: "email" }],
        {
          // last_inbound_email_message_id intentionally absent
          last_inbound_email_subject: "Some subject",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Fallback reply!"));
      mockEmailService.send.mockResolvedValue({});

      const errorSpy = jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);

      await service.generateAndSendReply(SESSION_ULID, "email");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("email_flush_missing_threading_context"),
      );

      const sendCall = mockEmailService.send.mock.calls[0][0];
      expect(sendCall.subject).toBe("Re: your message");
      expect(sendCall.inReplyToMessageId).toBeUndefined();
      expect(sendCall.referencesMessageId).toBeUndefined();

      errorSpy.mockRestore();
    });

    it("falls back to 'Re: your message' when last_inbound_email_subject is absent", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Missing subject.", channel: "email" }],
        {
          last_inbound_email_message_id: "<id@example.com>",
          // last_inbound_email_subject intentionally absent
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Fallback reply!"));
      mockEmailService.send.mockResolvedValue({});

      const errorSpy = jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);

      await service.generateAndSendReply(SESSION_ULID, "email");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("email_flush_missing_threading_context"),
      );

      const sendCall = mockEmailService.send.mock.calls[0][0];
      expect(sendCall.subject).toBe("Re: your message");

      errorSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // No-op when nothing outstanding
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — no-op when nothing outstanding", () => {
    it("returns { outcome: 'no_op_nothing_outstanding' } when history has only assistant messages", async () => {
      stubSessionWithMessages([{ role: "assistant", content: "I already replied." }]);

      const result = await service.generateAndSendReply(SESSION_ULID, "web");

      expect(result).toEqual({ outcome: "no_op_nothing_outstanding" });
      expect(mockAnthropicService.sendMessage).not.toHaveBeenCalled();
    });

    it("returns no_op when history is empty", async () => {
      stubSessionWithMessages([]);

      const result = await service.generateAndSendReply(SESSION_ULID, "web");

      expect(result).toEqual({ outcome: "no_op_nothing_outstanding" });
    });

    it("calls cancelEmailFlush even when returning no_op", async () => {
      await fakeScheduler.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000);

      stubSessionWithMessages([{ role: "assistant", content: "Already replied." }]);

      const cancelSpy = jest.spyOn(fakeScheduler, "cancelEmailFlush");

      await service.generateAndSendReply(SESSION_ULID, "email");

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith(SESSION_ULID);
      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBeNull();

      cancelSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // cancelEmailFlush fires even when LLM throws (try/finally verification)
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — cancelEmailFlush fires even on LLM error", () => {
    it("rethrows the LLM error AND calls cancelEmailFlush via the finally block", async () => {
      stubSessionWithMessages([{ role: "user", content: "Hello!" }]);
      mockAnthropicService.sendMessage.mockRejectedValue(new Error("Anthropic API failure"));

      await fakeScheduler.createOrResetEmailFlush(SESSION_ULID, Date.now() + 90_000);

      const cancelSpy = jest.spyOn(fakeScheduler, "cancelEmailFlush");

      await expect(service.generateAndSendReply(SESSION_ULID, "web")).rejects.toThrow("Anthropic API failure");

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith(SESSION_ULID);
      expect(await fakeScheduler.getEmailFlushFireTime(SESSION_ULID)).toBeNull();

      cancelSpy.mockRestore();
    });

    it("propagates the original LLM error even when cancelEmailFlush also throws", async () => {
      stubSessionWithMessages([{ role: "user", content: "Hello!" }]);

      const originalError = new Error("Anthropic API failure");
      mockAnthropicService.sendMessage.mockRejectedValue(originalError);

      const cancelError = new Error("SchedulerCancelError");
      jest.spyOn(fakeScheduler, "cancelEmailFlush").mockRejectedValue(cancelError);

      const errorSpy = jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);

      await expect(service.generateAndSendReply(SESSION_ULID, "web")).rejects.toThrow("Anthropic API failure");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("reply_orchestrator_cancel_failed"),
      );

      errorSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // channel field on persisted message rows
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — channel written onto assistant rows only", () => {
    it("sets channel: 'email' on the assistant PutCommand item", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Hello via email.", channel: "email" }],
        {
          last_inbound_email_message_id: "<id@mail.example.com>",
          last_inbound_email_subject: "Subject",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Email reply!"));
      mockEmailService.send.mockResolvedValue({});

      await service.generateAndSendReply(SESSION_ULID, "email");

      const putCalls = ddbMock.commandCalls(PutCommand);
      const assistantPut = putCalls.find((call) => call.args[0].input.Item?.role === "assistant");
      expect(assistantPut).toBeDefined();
      expect(assistantPut!.args[0].input.Item?.channel).toBe("email");
    });

    it("sets channel: 'web' on the assistant PutCommand item", async () => {
      stubSessionWithMessages([{ role: "user", content: "Hello via web." }]);
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Web reply!"));

      await service.generateAndSendReply(SESSION_ULID, "web");

      const putCalls = ddbMock.commandCalls(PutCommand);
      const assistantPut = putCalls.find((call) => call.args[0].input.Item?.role === "assistant");
      expect(assistantPut).toBeDefined();
      expect(assistantPut!.args[0].input.Item?.channel).toBe("web");
    });

    it("sets channel: 'sms' on the assistant PutCommand item", async () => {
      stubSessionWithMessages([{ role: "user", content: "Hello via sms.", channel: "sms" }]);
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("SMS reply!"));
      mockSmsService.send.mockResolvedValue({ messageSid: "SMxxx" });

      await service.generateAndSendReply(SESSION_ULID, "sms", {
        sms: { to: "+15551234567", from: "+18885550000" },
      });

      const putCalls = ddbMock.commandCalls(PutCommand);
      const assistantPut = putCalls.find((call) => call.args[0].input.Item?.role === "assistant");
      expect(assistantPut).toBeDefined();
      expect(assistantPut!.args[0].input.Item?.channel).toBe("sms");
    });

    it("does NOT set channel on tool_result (user-role) PutCommand items", async () => {
      const toolUseResponse = {
        content: [
          { type: "text", text: "Calling the tool." },
          { type: "tool_use", id: "tool_01", name: "some_tool", input: { q: "x" } },
        ],
        stop_reason: "tool_use",
      };
      const endTurnResponse = makeEndTurnResponse("Done.");

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce(toolUseResponse)
        .mockResolvedValueOnce(endTurnResponse);

      mockToolRegistry.getDefinitions.mockReturnValue([{ name: "some_tool" }]);
      mockToolRegistry.getAll.mockReturnValue([{ name: "some_tool", emitLatestOnly: false }]);
      const agentWithTool = { ...mockAgent, allowedToolNames: ["some_tool"] };
      mockAgentRegistry.getByName.mockReturnValue(agentWithTool);
      mockToolRegistry.execute.mockResolvedValue({ result: "ok", isError: false });

      stubSessionWithMessages([{ role: "user", content: "Run it." }]);

      await service.generateAndSendReply(SESSION_ULID, "web");

      const putCalls = ddbMock.commandCalls(PutCommand);
      const toolResultPut = putCalls.find((call) => call.args[0].input.Item?.role === "user");
      expect(toolResultPut).toBeDefined();
      expect(toolResultPut!.args[0].input.Item?.channel).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tool-use loop
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — tool-use loop", () => {
    it("calls LLM again with tool results when stop_reason is tool_use", async () => {
      const toolUseResponse = {
        content: [
          { type: "text", text: "Let me look that up." },
          { type: "tool_use", id: "tool_01", name: "some_tool", input: { query: "test" } },
        ],
        stop_reason: "tool_use",
      };
      const endTurnResponse = makeEndTurnResponse("Here is the result.");

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce(toolUseResponse)
        .mockResolvedValueOnce(endTurnResponse);

      mockToolRegistry.getDefinitions.mockReturnValue([{ name: "some_tool" }]);
      mockToolRegistry.getAll.mockReturnValue([{ name: "some_tool", emitLatestOnly: false }]);

      const agentWithTool = { ...mockAgent, allowedToolNames: ["some_tool"] };
      mockAgentRegistry.getByName.mockReturnValue(agentWithTool);

      mockToolRegistry.execute.mockResolvedValue({ result: '{"value":42}', isError: false });

      stubSessionWithMessages([{ role: "user", content: "Run the tool." }]);

      const result = await service.generateAndSendReply(SESSION_ULID, "web");

      expect(result.outcome).toBe("replied");
      expect(mockAnthropicService.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockToolRegistry.execute).toHaveBeenCalledWith(
        "some_tool",
        { query: "test" },
        expect.objectContaining({ sessionUlid: SESSION_ULID }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Channel format rules injected into LLM system context
  // ---------------------------------------------------------------------------

  describe("generateAndSendReply — channel format rules in LLM system context", () => {
    it("passes email channel format rules to anthropicService.sendMessage", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Hello via email.", channel: "email" }],
        {
          last_inbound_email_message_id: "<id@mail.example.com>",
          last_inbound_email_subject: "Subject",
          from_name: "Happy Paws",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Email reply!"));
      mockEmailService.send.mockResolvedValue({});

      await service.generateAndSendReply(SESSION_ULID, "email");

      const [, , , dynamicSystemContext] = mockAnthropicService.sendMessage.mock.calls[0];
      expect(dynamicSystemContext).toContain("replying via the email channel");
    });

    it("includes the practice name in the email signoff instruction when from_name is set", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Hello via email.", channel: "email" }],
        {
          last_inbound_email_message_id: "<id@mail.example.com>",
          last_inbound_email_subject: "Subject",
          from_name: "Happy Paws",
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Email reply!"));
      mockEmailService.send.mockResolvedValue({});

      await service.generateAndSendReply(SESSION_ULID, "email");

      const [, , , dynamicSystemContext] = mockAnthropicService.sendMessage.mock.calls[0];
      expect(dynamicSystemContext).toContain("Happy Paws team");
    });

    it("falls back to 'The team' in the email signoff instruction when from_name is absent", async () => {
      stubSessionWithMessages(
        [{ role: "user", content: "Hello via email.", channel: "email" }],
        {
          last_inbound_email_message_id: "<id@mail.example.com>",
          last_inbound_email_subject: "Subject",
          // from_name intentionally absent
        },
      );
      stubContactInfo("user@example.com");
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Email reply!"));
      mockEmailService.send.mockResolvedValue({});

      await service.generateAndSendReply(SESSION_ULID, "email");

      const [, , , dynamicSystemContext] = mockAnthropicService.sendMessage.mock.calls[0];
      expect(dynamicSystemContext).toContain("The team");
    });

    it("passes SMS channel format rules to anthropicService.sendMessage", async () => {
      stubSessionWithMessages([{ role: "user", content: "Text me.", channel: "sms" }]);
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("SMS reply!"));
      mockSmsService.send.mockResolvedValue({ messageSid: "SMxxx" });

      await service.generateAndSendReply(SESSION_ULID, "sms", {
        sms: { to: "+15551234567", from: "+18885550000" },
      });

      const [, , , dynamicSystemContext] = mockAnthropicService.sendMessage.mock.calls[0];
      expect(dynamicSystemContext).toContain("replying via the SMS channel");
    });

    it("passes web channel format rules to anthropicService.sendMessage", async () => {
      stubSessionWithMessages([{ role: "user", content: "Hello!" }]);
      mockAnthropicService.sendMessage.mockResolvedValue(makeEndTurnResponse("Web reply!"));

      await service.generateAndSendReply(SESSION_ULID, "web");

      const [, , , dynamicSystemContext] = mockAnthropicService.sendMessage.mock.calls[0];
      expect(dynamicSystemContext).toContain("replying via the web chat channel");
    });
  });
});
