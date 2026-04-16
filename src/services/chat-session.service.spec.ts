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

      const reply = await service.handleMessage("01TESTSESSION0000000000000", "Message");

      expect(reply).toBe("Hello from assistant");
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

      expect(result).toBe(expectedReply);
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

      expect(result).toBe("Nice to meet you, Michael! Could I get your last name?");
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

      expect(result).toBe("Let me check that for you.\n\nAll set!");
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
      expect(result).toBe("Got it, I have saved that you work at Acme Corp.");
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
  });
});
