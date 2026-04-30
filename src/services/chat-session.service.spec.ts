import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { ChatSessionService } from "./chat-session.service";
import { AnthropicService } from "./anthropic.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { ToolRegistryService } from "../tools/tool-registry.service";
import { AgentRegistryService } from "../agents/agent-registry.service";

const TABLE_NAME = "test-conversations-table";

const mockDatabaseConfig = {
  conversationsTable: TABLE_NAME,
};

const mockAnthropicService = {
  sendMessage: jest.fn(),
};

const mockToolRegistry = {
  getDefinitions: jest.fn().mockReturnValue([]),
  getAll: jest.fn().mockReturnValue([]),
  execute: jest.fn(),
};

const mockAgentRegistry = {
  getByName: jest.fn(),
};

const STUB_AGENT = {
  name: "lead_capture",
  description: "Test agent",
  systemPrompt: "test prompt",
  allowedToolNames: ["save_user_fact", "collect_contact_info", "send_email"],
};

const END_TURN_RESPONSE = {
  content: [{ type: "text", text: "Hello from assistant" }],
  stop_reason: "end_turn",
};

describe("ChatSessionService", () => {
  let service: ChatSessionService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    mockToolRegistry.getDefinitions.mockReturnValue([]);
    mockToolRegistry.getAll.mockReturnValue([]);
    mockAgentRegistry.getByName.mockReturnValue(STUB_AGENT);

    ddbMock.on(GetCommand).resolves({ Item: { agent_name: "lead_capture", account_id: "01ACCOUNTULID00000000000000" } });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatSessionService,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        {
          provide: DatabaseConfigService,
          useValue: mockDatabaseConfig,
        },
        {
          provide: AnthropicService,
          useValue: mockAnthropicService,
        },
        {
          provide: ToolRegistryService,
          useValue: mockToolRegistry,
        },
        {
          provide: AgentRegistryService,
          useValue: mockAgentRegistry,
        },
      ],
    }).compile();

    service = module.get<ChatSessionService>(ChatSessionService);
  });

  describe("handleMessage", () => {
    it("calls Anthropic with only the user message when history is empty", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hi there");

      const [calledMessages] = mockAnthropicService.sendMessage.mock.calls[0];

      expect(calledMessages).toHaveLength(1);
      expect(calledMessages[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "Hi there" }],
      });
    });

    it("reverses history items and passes them in chronological order to Anthropic", async () => {
      const reversedItems = [
        {
          PK: "CHAT_SESSION#abc",
          SK: "MESSAGE#03",
          role: "assistant",
          content: JSON.stringify([{ type: "text", text: "Sure!" }]),
          _createdAt_: "2026-01-01T00:00:03.000Z",
        },
        {
          PK: "CHAT_SESSION#abc",
          SK: "MESSAGE#02",
          role: "user",
          content: JSON.stringify([{ type: "text", text: "Can you help?" }]),
          _createdAt_: "2026-01-01T00:00:02.000Z",
        },
        {
          PK: "CHAT_SESSION#abc",
          SK: "MESSAGE#01",
          role: "assistant",
          content: JSON.stringify([{ type: "text", text: "Hello!" }]),
          _createdAt_: "2026-01-01T00:00:01.000Z",
        },
      ];

      ddbMock.on(QueryCommand).resolves({ Items: reversedItems });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue({
        content: [{ type: "text", text: "Happy to help" }],
        stop_reason: "end_turn",
      });

      await service.handleMessage("01TESTSESSION0000000000000", "Please explain");

      const [calledMessages] = mockAnthropicService.sendMessage.mock.calls[0];

      expect(calledMessages).toHaveLength(4);
      expect(calledMessages[0]).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      });
      expect(calledMessages[1]).toEqual({
        role: "user",
        content: [{ type: "text", text: "Can you help?" }],
      });
      expect(calledMessages[2]).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "Sure!" }],
      });
      expect(calledMessages[3]).toEqual({
        role: "user",
        content: [{ type: "text", text: "Please explain" }],
      });
    });

    it("gracefully handles legacy plain-string content in history", async () => {
      const legacyItems = [
        {
          PK: "CHAT_SESSION#abc",
          SK: "MESSAGE#01",
          role: "assistant",
          content: "Legacy string content",
          _createdAt_: "2026-01-01T00:00:01.000Z",
        },
      ];

      ddbMock.on(QueryCommand).resolves({ Items: legacyItems });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      const [calledMessages] = mockAnthropicService.sendMessage.mock.calls[0];

      expect(calledMessages[0]).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "Legacy string content" }],
      });
    });

    it("writes PutCommand items for user message and assistant message on end_turn", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue({
        content: [{ type: "text", text: "Assistant response text" }],
        stop_reason: "end_turn",
      });

      await service.handleMessage("01TESTSESSION0000000000000", "Test input");

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls).toHaveLength(2);

      const userPut = putCalls[0].args[0].input;
      const assistantPut = putCalls[1].args[0].input;

      expect(userPut.Item?.role).toBe("user");
      expect(userPut.Item?.SK).toMatch(/^MESSAGE#/);

      expect(assistantPut.Item?.role).toBe("assistant");
      expect(assistantPut.Item?.SK).toMatch(/^MESSAGE#/);
    });

    it("stores content as JSON-serialized block array in DynamoDB", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue({
        content: [{ type: "text", text: "Assistant response text" }],
        stop_reason: "end_turn",
      });

      await service.handleMessage("01TESTSESSION0000000000000", "Test input");

      const putCalls = ddbMock.commandCalls(PutCommand);

      const userContent: string = putCalls[0].args[0].input.Item?.content;
      const assistantContent: string = putCalls[1].args[0].input.Item?.content;

      expect(() => JSON.parse(userContent)).not.toThrow();
      expect(() => JSON.parse(assistantContent)).not.toThrow();

      expect(JSON.parse(userContent)).toEqual([{ type: "text", text: "Test input" }]);
      expect(JSON.parse(assistantContent)).toEqual([{ type: "text", text: "Assistant response text" }]);
    });

    it("writes all message items under the correct PK", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      const sessionUlid = "01TESTSESSION0000000000000";

      await service.handleMessage(sessionUlid, "Hello");

      const putCalls = ddbMock.commandCalls(PutCommand);

      for (const call of putCalls) {
        expect(call.args[0].input.Item?.PK).toBe(`CHAT_SESSION#${sessionUlid}`);
      }
    });

    it("issues an UpdateCommand (not PutCommand) for the metadata record", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      const sessionUlid = "01TESTSESSION0000000000000";

      await service.handleMessage(sessionUlid, "Message");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      const metadataUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.SK === "METADATA",
      );

      expect(metadataUpdate).toBeDefined();

      const updateInput = metadataUpdate!.args[0].input;

      expect(updateInput.Key?.PK).toBe(`CHAT_SESSION#${sessionUlid}`);
      expect(updateInput.Key?.SK).toBe("METADATA");
      expect(updateInput.UpdateExpression).toContain("if_not_exists(#createdAt");
      expect(updateInput.UpdateExpression).toContain("#lastUpdated");
      expect(updateInput.ExpressionAttributeNames?.["#createdAt"]).toBe("_createdAt_");
      expect(updateInput.ExpressionAttributeNames?.["#lastUpdated"]).toBe("_lastUpdated_");
    });

    it("issues a second UpdateCommand on the account-scoped session pointer when metadata has accountUlid", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      const sessionUlid = "01TESTSESSION0000000000000";

      await service.handleMessage(sessionUlid, "Message");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      const pointerUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.PK?.toString().startsWith("A#"),
      );

      expect(pointerUpdate).toBeDefined();

      const input = pointerUpdate!.args[0].input;

      expect(input.Key?.PK).toBe("A#01ACCOUNTULID00000000000000");
      expect(input.Key?.SK).toBe(`CHAT_SESSION#${sessionUlid}`);
      expect(input.UpdateExpression).toContain("#lastUpdated");
      expect(input.ExpressionAttributeNames?.["#lastUpdated"]).toBe("_lastUpdated_");
      expect(input.ConditionExpression).toContain("attribute_exists");
    });

    it("does NOT issue a pointer UpdateCommand when metadata has no accountUlid", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { agent_name: "lead_capture" } });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Message");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      const pointerUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.PK?.toString().startsWith("A#"),
      );

      expect(pointerUpdate).toBeUndefined();
    });

    it("pointer UpdateCommand failure does not break message handling", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});

      const pointerError = Object.assign(new Error("Pointer update blew up"), {
        name: "InternalServerError",
      });

      ddbMock.on(UpdateCommand).callsFake((input: { Key?: { PK?: unknown } }) => {
        const pk = input.Key?.PK?.toString() ?? "";
        if (pk.startsWith("A#")) {
          return Promise.reject(pointerError);
        }
        return Promise.resolve({});
      });

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Message");

      expect(result.reply).toBe("Hello from assistant");
    });

    it("returns the text from the final assistant message", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const expectedReply = "This is the assistant reply";

      mockAnthropicService.sendMessage.mockResolvedValue({
        content: [{ type: "text", text: expectedReply }],
        stop_reason: "end_turn",
      });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Question?");

      expect(result.reply).toBe(expectedReply);
    });

    it("returns text from an earlier assistant message when the final assistant message is empty", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "Contact info saved successfully." });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            { type: "text", text: "Nice to meet you, Michael! Could I get your last name?" },
            {
              type: "tool_use",
              id: "toolu_01",
              name: "collect_contact_info",
              input: { firstName: "Michael" },
            },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [],
          stop_reason: "end_turn",
        });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Sure its Michael");

      expect(result.reply).toBe("Nice to meet you, Michael! Could I get your last name?");
    });

    it("concatenates text from multiple assistant messages across a tool loop into a single reply", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "ok" });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            { type: "text", text: "Let me check that for you." },
            { type: "tool_use", id: "toolu_01", name: "save_user_fact", input: { key: "k", value: "v" } },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "All set!" }],
          stop_reason: "end_turn",
        });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      expect(result.reply).toBe("Let me check that for you.\n\nAll set!");
    });

    it("queries with begins_with SK prefix to exclude METADATA items from history", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "test");

      const queryCalls = ddbMock.commandCalls(QueryCommand);

      expect(queryCalls).toHaveLength(1);

      const queryInput = queryCalls[0].args[0].input;

      expect(queryInput.KeyConditionExpression).toContain("begins_with");
      expect(queryInput.ExpressionAttributeValues?.[":skPrefix"]).toBe("MESSAGE#");
      expect(queryInput.ScanIndexForward).toBe(false);
      expect(queryInput.Limit).toBe(50);
    });

    it("performs exactly one Anthropic call when stop_reason is end_turn on first response", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      expect(mockAnthropicService.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("performs two Anthropic calls when stop_reason is tool_use on first response", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "Fact saved successfully." });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "save_user_fact",
              input: { key: "employer", value: "Acme Corp" },
            },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Got it, I have saved that you work at Acme Corp." }],
          stop_reason: "end_turn",
        });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "I work at Acme Corp");

      expect(mockAnthropicService.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockToolRegistry.execute).toHaveBeenCalledTimes(1);
      expect(mockToolRegistry.execute).toHaveBeenCalledWith(
        "save_user_fact",
        { key: "employer", value: "Acme Corp" },
        { sessionUlid: "01TESTSESSION0000000000000", accountUlid: "01ACCOUNTULID00000000000000" },
      );
      expect(result.reply).toBe("Got it, I have saved that you work at Acme Corp.");
    });

    it("sends all tool_result blocks in a single user message when multiple tool_use blocks appear", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "Fact saved successfully." });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "toolu_01", name: "save_user_fact", input: { key: "employer", value: "Acme" } },
            { type: "tool_use", id: "toolu_02", name: "save_user_fact", input: { key: "city", value: "Austin" } },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Saved both facts." }],
          stop_reason: "end_turn",
        });

      await service.handleMessage("01TESTSESSION0000000000000", "I live in Austin and work at Acme");

      const secondCallMessages = mockAnthropicService.sendMessage.mock.calls[1][0];

      const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];

      expect(toolResultMessage.role).toBe("user");
      expect(toolResultMessage.content).toHaveLength(2);
      expect(toolResultMessage.content[0].type).toBe("tool_result");
      expect(toolResultMessage.content[0].tool_use_id).toBe("toolu_01");
      expect(toolResultMessage.content[1].type).toBe("tool_result");
      expect(toolResultMessage.content[1].tool_use_id).toBe("toolu_02");
    });

    it("passes accountUlid from session metadata to ToolRegistry.execute context", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "done" });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "save_user_fact",
              input: { key: "k", value: "v" },
            },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        });

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      expect(mockToolRegistry.execute).toHaveBeenCalledWith(
        "save_user_fact",
        { key: "k", value: "v" },
        { sessionUlid: "01TESTSESSION0000000000000", accountUlid: "01ACCOUNTULID00000000000000" },
      );
    });

    it("passes undefined accountUlid when metadata has no accountUlid attribute", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { agent_name: "lead_capture" } });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "done" });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "save_user_fact",
              input: { key: "k", value: "v" },
            },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        });

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      expect(mockToolRegistry.execute).toHaveBeenCalledWith(
        "save_user_fact",
        { key: "k", value: "v" },
        { sessionUlid: "01TESTSESSION0000000000000", accountUlid: undefined },
      );
    });

    it("exits the tool loop after MAX_TOOL_LOOP_ITERATIONS and logs a warning", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "done" });

      mockAnthropicService.sendMessage.mockResolvedValue({
        content: [
          { type: "tool_use", id: "toolu_01", name: "save_user_fact", input: { key: "k", value: "v" } },
        ],
        stop_reason: "tool_use",
      });

      await service.handleMessage("01TESTSESSION0000000000000", "Trigger infinite loop");

      expect(mockAnthropicService.sendMessage).toHaveBeenCalledTimes(10);
    });

    it("passes tool definitions from ToolRegistry to each Anthropic call", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const fakeDefs = [{ name: "save_user_fact", description: "desc", input_schema: {} }];

      mockToolRegistry.getDefinitions.mockReturnValue(fakeDefs);
      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      const [, calledTools] = mockAnthropicService.sendMessage.mock.calls[0];

      expect(calledTools).toEqual(fakeDefs);
    });

    it("returns an empty toolOutputs array when no tools fire during the turn", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      expect(result.toolOutputs).toEqual([]);
    });

    it("returns toolOutputs pairing each tool_result with its tool_use name (generic across any agent/tool)", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "FACT_SAVED_PAYLOAD" });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "toolu_01", name: "save_user_fact", input: { key: "k", value: "v" } },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      expect(result.toolOutputs).toEqual([
        { call_id: "toolu_01", tool_name: "save_user_fact", content: "FACT_SAVED_PAYLOAD" },
      ]);
    });

    it("includes is_error on a toolOutput entry when the tool result was flagged as an error", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "Tool exploded", isError: true });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "toolu_01", name: "save_user_fact", input: { key: "k", value: "v" } },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Apologies." }],
          stop_reason: "end_turn",
        });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      expect(result.toolOutputs).toEqual([
        { call_id: "toolu_01", tool_name: "save_user_fact", content: "Tool exploded", is_error: true },
      ]);
    });

    it("returns multiple toolOutputs when multiple tools fire in the same turn", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockToolRegistry.execute.mockResolvedValue({ result: "ok" });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "toolu_01", name: "save_user_fact", input: { key: "a", value: "1" } },
            { type: "tool_use", id: "toolu_02", name: "save_user_fact", input: { key: "b", value: "2" } },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Saved." }],
          stop_reason: "end_turn",
        });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      expect(result.toolOutputs).toHaveLength(2);
      expect(result.toolOutputs[0]).toEqual({ call_id: "toolu_01", tool_name: "save_user_fact", content: "ok" });
      expect(result.toolOutputs[1]).toEqual({ call_id: "toolu_02", tool_name: "save_user_fact", content: "ok" });
    });

    it("dedupes tool outputs for tools with emitLatestOnly=true, keeping only the latest per tool_name", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      // Stub a tool with emitLatestOnly + a parallel tool without it in one turn.
      mockToolRegistry.getAll.mockReturnValue([
        { name: "preview_cart", emitLatestOnly: true },
        { name: "save_user_fact" },
      ]);

      mockToolRegistry.execute.mockImplementation((toolName: string) => {
        if (toolName === "preview_cart") {
          return Promise.resolve({ result: JSON.stringify({ which: "call" }) });
        }
        return Promise.resolve({ result: "fact-ok" });
      });

      mockAnthropicService.sendMessage
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "toolu_cart_1", name: "preview_cart", input: { items: [] } },
            { type: "tool_use", id: "toolu_cart_2", name: "preview_cart", input: { items: [] } },
            { type: "tool_use", id: "toolu_fact_1", name: "save_user_fact", input: { key: "a", value: "1" } },
          ],
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        });

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      expect(result.toolOutputs).toHaveLength(2);

      const cartOutputs = result.toolOutputs.filter((output) => output.tool_name === "preview_cart");
      expect(cartOutputs).toHaveLength(1);
      expect(cartOutputs[0].call_id).toBe("toolu_cart_2");

      const factOutputs = result.toolOutputs.filter((output) => output.tool_name === "save_user_fact");
      expect(factOutputs).toHaveLength(1);
    });

    it("passes a dynamic system context with budget when budget_cents is set on METADATA", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { agent_name: "lead_capture", account_id: "01ACCOUNTULID00000000000000", budget_cents: 100_000 },
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      const call = mockAnthropicService.sendMessage.mock.calls[0];
      expect(call[3]).toBe("User context: shopping budget is approximately $1000.");
    });

    it("omits the dynamic system context when budget_cents is not set", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hi");

      const call = mockAnthropicService.sendMessage.mock.calls[0];
      expect(call[3]).toBeUndefined();
    });

    it("stamps kickoff_completed_at on first successful kickoff turn", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { agent_name: "lead_capture", account_id: "01ACCOUNTULID00000000000000" } });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "__SESSION_KICKOFF__");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const stampUpdate = updateCalls.find(
        (call) => call.args[0].input.UpdateExpression?.includes("kickoff_completed_at"),
      );

      expect(stampUpdate).toBeDefined();
      expect(stampUpdate!.args[0].input.UpdateExpression).toBe(
        "SET kickoff_completed_at = if_not_exists(kickoff_completed_at, :now)",
      );
      expect(typeof stampUpdate!.args[0].input.ExpressionAttributeValues?.[":now"]).toBe("string");
      expect(stampUpdate!.args[0].input.ExpressionAttributeValues?.[":now"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("does not stamp kickoff_completed_at on non-kickoff messages", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const stampUpdate = updateCalls.find(
        (call) => call.args[0].input.UpdateExpression?.includes("kickoff_completed_at"),
      );

      expect(stampUpdate).toBeUndefined();
    });

    it("short-circuits on repeat kickoff, returns stored welcome without calling Anthropic", async () => {
      const sessionUlid = "01TESTSESSION0000000000000";

      ddbMock.on(GetCommand).resolves({
        Item: {
          agent_name: "lead_capture",
          account_id: "01ACCOUNTULID00000000000000",
          kickoff_completed_at: "2026-04-20T22:00:00.000Z",
        },
      });

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: `CHAT_SESSION#${sessionUlid}`,
            SK: "MESSAGE#01KICKOFF0000000000000000",
            role: "user",
            content: JSON.stringify([{ type: "text", text: "__SESSION_KICKOFF__" }]),
            _createdAt_: "2026-04-20T22:00:00.000Z",
          },
          {
            PK: `CHAT_SESSION#${sessionUlid}`,
            SK: "MESSAGE#01WELCOME0000000000000000",
            role: "assistant",
            content: JSON.stringify([{ type: "text", text: "Welcome, Mike!" }]),
            _createdAt_: "2026-04-20T22:00:01.000Z",
          },
        ],
      });

      const result = await service.handleMessage(sessionUlid, "__SESSION_KICKOFF__");

      expect(mockAnthropicService.sendMessage).not.toHaveBeenCalled();
      expect(result.reply).toBe("Welcome, Mike!");
      expect(result.toolOutputs).toEqual([]);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it("short-circuit returns empty reply and logs warning when no stored welcome exists", async () => {
      const sessionUlid = "01TESTSESSION0000000000000";

      ddbMock.on(GetCommand).resolves({
        Item: {
          agent_name: "lead_capture",
          kickoff_completed_at: "2026-04-20T22:00:00.000Z",
        },
      });

      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await service.handleMessage(sessionUlid, "__SESSION_KICKOFF__");

      expect(mockAnthropicService.sendMessage).not.toHaveBeenCalled();
      expect(result).toEqual({ reply: "", toolOutputs: [] });
    });

    it("latest_session_id guard — UpdateCommand fires on Customer record when customer_id is non-null", async () => {
      const CUSTOMER_ID = "C#01CUSTOMERULID0000000000000";

      ddbMock.on(GetCommand).resolves({
        Item: {
          agent_name: "lead_capture",
          account_id: "01ACCOUNTULID00000000000000",
          customer_id: CUSTOMER_ID,
        },
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const customerUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.PK === CUSTOMER_ID,
      );
      expect(customerUpdate).toBeDefined();
      expect(customerUpdate!.args[0].input.Key?.PK).toBe("C#01CUSTOMERULID0000000000000");
      expect(customerUpdate!.args[0].input.Key?.SK).toBe("C#01CUSTOMERULID0000000000000");
      expect(customerUpdate!.args[0].input.ExpressionAttributeValues?.[":sessionUlid"]).toBe(
        "01TESTSESSION0000000000000",
      );
    });

    it("latest_session_id guard — normalizes bare-ULID customer_id to C# prefix in UpdateCommand Key", async () => {
      const BARE_CUSTOMER_ID = "01CUSTOMERULID0000000000000";

      ddbMock.on(GetCommand).resolves({
        Item: {
          agent_name: "lead_capture",
          account_id: "01ACCOUNTULID00000000000000",
          customer_id: BARE_CUSTOMER_ID,
        },
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const customerUpdate = updateCalls.find(
        (call) => call.args[0].input.Key?.PK === `C#${BARE_CUSTOMER_ID}`,
      );
      expect(customerUpdate).toBeDefined();
      expect(customerUpdate!.args[0].input.Key?.PK).toBe("C#01CUSTOMERULID0000000000000");
      expect(customerUpdate!.args[0].input.Key?.SK).toBe("C#01CUSTOMERULID0000000000000");
      expect(customerUpdate!.args[0].input.ExpressionAttributeValues?.[":sessionUlid"]).toBe(
        "01TESTSESSION0000000000000",
      );
    });

    it("latest_session_id guard — prefixed customer_id is not double-prefixed in UpdateCommand Key", async () => {
      const PREFIXED_CUSTOMER_ID = "C#01CUSTOMERULID0000000000000";

      ddbMock.on(GetCommand).resolves({
        Item: {
          agent_name: "lead_capture",
          account_id: "01ACCOUNTULID00000000000000",
          customer_id: PREFIXED_CUSTOMER_ID,
        },
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const customerUpdate = updateCalls.find(
        (call) => String(call.args[0].input.Key?.PK ?? "").startsWith("C#"),
      );
      expect(customerUpdate).toBeDefined();
      // Must be exactly "C#..." not "C#C#..."
      expect(customerUpdate!.args[0].input.Key?.PK).toBe("C#01CUSTOMERULID0000000000000");
      expect(customerUpdate!.args[0].input.Key?.SK).toBe("C#01CUSTOMERULID0000000000000");
    });

    it("latest_session_id guard — UpdateCommand does NOT fire on Customer record when customer_id is null", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          agent_name: "lead_capture",
          account_id: "01ACCOUNTULID00000000000000",
          customer_id: null,
        },
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const customerUpdate = updateCalls.find(
        (call) => String(call.args[0].input.Key?.PK ?? "").startsWith("C#"),
      );
      expect(customerUpdate).toBeUndefined();
    });

    it("latest_session_id guard — update failure does not propagate; handleMessage resolves normally", async () => {
      const CUSTOMER_ID = "C#01CUSTOMERULID0000000000000";

      ddbMock.on(GetCommand).resolves({
        Item: {
          agent_name: "lead_capture",
          account_id: "01ACCOUNTULID00000000000000",
          customer_id: CUSTOMER_ID,
        },
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});

      // Make the Customer UpdateCommand reject; other UpdateCommands succeed
      ddbMock.on(UpdateCommand).callsFake((input: { Key?: { PK?: unknown } }) => {
        const pk = String(input.Key?.PK ?? "");
        if (pk.startsWith("C#")) {
          return Promise.reject(Object.assign(new Error("Customer update failed"), { name: "InternalServerError" }));
        }
        return Promise.resolve({});
      });

      mockAnthropicService.sendMessage.mockResolvedValue(END_TURN_RESPONSE);

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Hello");

      expect(result.reply).toBe("Hello from assistant");
    });
  });

  describe("getHistoryForClient", () => {
    const SESSION_ULID = "01HISTSESSION0000000000000";

    it("filters out user records whose content is only tool_result blocks and assistant records with no text", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01TEXTUSER00000000000000000",
            role: "user",
            content: JSON.stringify([{ type: "text", text: "Hi" }]),
            _createdAt_: "2026-04-19T20:00:00.000Z",
          },
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01TOOLRESULT00000000000000",
            role: "user",
            content: JSON.stringify([{ type: "tool_result", tool_use_id: "x", content: "{}" }]),
            _createdAt_: "2026-04-19T20:00:01.000Z",
          },
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01ASSISTANT00000000000000",
            role: "assistant",
            content: JSON.stringify([
              { type: "text", text: "Hello!" },
              { type: "tool_use", id: "x", name: "foo", input: {} },
            ]),
            _createdAt_: "2026-04-19T20:00:02.000Z",
          },
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01ASSISTANTNOTEXT000000000",
            role: "assistant",
            content: JSON.stringify([{ type: "tool_use", id: "y", name: "foo", input: {} }]),
            _createdAt_: "2026-04-19T20:00:03.000Z",
          },
        ],
      });

      const history = await service.getHistoryForClient(SESSION_ULID);

      expect(history).toEqual([
        { id: "01TEXTUSER00000000000000000", role: "user", content: "Hi", timestamp: "2026-04-19T20:00:00.000Z" },
        { id: "01ASSISTANT00000000000000", role: "assistant", content: "Hello!", timestamp: "2026-04-19T20:00:02.000Z" },
      ]);
    });

    it("returns an empty array when no messages exist", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const history = await service.getHistoryForClient(SESSION_ULID);

      expect(history).toEqual([]);
    });

    it("queries messages in ascending chronological order", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.getHistoryForClient(SESSION_ULID);

      const call = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(call.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :skPrefix)");
      expect(call.ExpressionAttributeValues?.[":pk"]).toBe(`CHAT_SESSION#${SESSION_ULID}`);
      expect(call.ExpressionAttributeValues?.[":skPrefix"]).toBe("MESSAGE#");
      expect(call.ScanIndexForward).toBe(true);
    });

    it("filters out the session-kickoff marker so it never appears in hydrated history", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01KICKOFF0000000000000000",
            role: "user",
            content: JSON.stringify([{ type: "text", text: "__SESSION_KICKOFF__" }]),
            _createdAt_: "2026-04-20T21:00:00.000Z",
          },
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01ASSISTANTWELCOME000000000",
            role: "assistant",
            content: JSON.stringify([{ type: "text", text: "Welcome, Mike!" }]),
            _createdAt_: "2026-04-20T21:00:01.000Z",
          },
        ],
      });

      const history = await service.getHistoryForClient(SESSION_ULID);

      expect(history).toEqual([
        {
          id: "01ASSISTANTWELCOME000000000",
          role: "assistant",
          content: "Welcome, Mike!",
          timestamp: "2026-04-20T21:00:01.000Z",
        },
      ]);
    });

    it("handles legacy plain-string content by returning it as the text payload", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01LEGACY0000000000000000000",
            role: "assistant",
            content: "Legacy plain text",
            _createdAt_: "2026-04-19T20:00:00.000Z",
          },
        ],
      });

      const history = await service.getHistoryForClient(SESSION_ULID);

      expect(history).toEqual([
        { id: "01LEGACY0000000000000000000", role: "assistant", content: "Legacy plain text", timestamp: "2026-04-19T20:00:00.000Z" },
      ]);
    });
  });
});
