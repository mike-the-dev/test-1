import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { ChatSessionService } from "./chat-session.service";
import { AnthropicService } from "./anthropic.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";

const TABLE_NAME = "test-conversations-table";

const mockDatabaseConfig = {
  conversationsTable: TABLE_NAME,
};

const mockAnthropicService = {
  sendMessage: jest.fn(),
};

describe("ChatSessionService", () => {
  let service: ChatSessionService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

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
      ],
    }).compile();

    service = module.get<ChatSessionService>(ChatSessionService);
  });

  describe("handleMessage", () => {
    it("calls Anthropic with only the user message when history is empty", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue("Hello from assistant");

      await service.handleMessage("01TESTSESSION0000000000000", "Hi there");

      const [calledMessages] = mockAnthropicService.sendMessage.mock.calls[0];

      expect(calledMessages).toHaveLength(1);
      expect(calledMessages[0]).toEqual({ role: "user", content: "Hi there" });
    });

    it("reverses history items and passes them in chronological order to Anthropic", async () => {
      const reversedItems = [
        { PK: "CHAT_SESSION#abc", SK: "MESSAGE#03", role: "assistant", content: "Sure!", createdAt: "2026-01-01T00:00:03.000Z" },
        { PK: "CHAT_SESSION#abc", SK: "MESSAGE#02", role: "user", content: "Can you help?", createdAt: "2026-01-01T00:00:02.000Z" },
        { PK: "CHAT_SESSION#abc", SK: "MESSAGE#01", role: "assistant", content: "Hello!", createdAt: "2026-01-01T00:00:01.000Z" },
      ];

      ddbMock.on(QueryCommand).resolves({ Items: reversedItems });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue("Happy to help");

      await service.handleMessage("01TESTSESSION0000000000000", "Please explain");

      const [calledMessages] = mockAnthropicService.sendMessage.mock.calls[0];

      expect(calledMessages).toHaveLength(4);
      expect(calledMessages[0]).toEqual({ role: "assistant", content: "Hello!" });
      expect(calledMessages[1]).toEqual({ role: "user", content: "Can you help?" });
      expect(calledMessages[2]).toEqual({ role: "assistant", content: "Sure!" });
      expect(calledMessages[3]).toEqual({ role: "user", content: "Please explain" });
    });

    it("writes two PutCommand items — one for user and one for assistant message", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue("Assistant response text");

      await service.handleMessage("01TESTSESSION0000000000000", "Test input");

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls).toHaveLength(2);

      const userPut = putCalls[0].args[0].input;
      const assistantPut = putCalls[1].args[0].input;

      expect(userPut.Item?.role).toBe("user");
      expect(userPut.Item?.content).toBe("Test input");
      expect(userPut.Item?.SK).toMatch(/^MESSAGE#/);

      expect(assistantPut.Item?.role).toBe("assistant");
      expect(assistantPut.Item?.content).toBe("Assistant response text");
      expect(assistantPut.Item?.SK).toMatch(/^MESSAGE#/);
    });

    it("writes the user and assistant message items under the correct PK", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue("Reply");

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

      mockAnthropicService.sendMessage.mockResolvedValue("Response");

      const sessionUlid = "01TESTSESSION0000000000000";

      await service.handleMessage(sessionUlid, "Message");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const updateInput = updateCalls[0].args[0].input;

      expect(updateInput.Key?.PK).toBe(`CHAT_SESSION#${sessionUlid}`);
      expect(updateInput.Key?.SK).toBe("METADATA");
      expect(updateInput.UpdateExpression).toContain("if_not_exists(createdAt");
      expect(updateInput.UpdateExpression).toContain("lastMessageAt");
    });

    it("returns the string from AnthropicService.sendMessage", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const expectedReply = "This is the assistant reply";

      mockAnthropicService.sendMessage.mockResolvedValue(expectedReply);

      const result = await service.handleMessage("01TESTSESSION0000000000000", "Question?");

      expect(result).toBe(expectedReply);
    });

    it("queries with begins_with SK prefix to exclude METADATA items from history", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      mockAnthropicService.sendMessage.mockResolvedValue("OK");

      await service.handleMessage("01TESTSESSION0000000000000", "test");

      const queryCalls = ddbMock.commandCalls(QueryCommand);

      expect(queryCalls).toHaveLength(1);

      const queryInput = queryCalls[0].args[0].input;

      expect(queryInput.KeyConditionExpression).toContain("begins_with");
      expect(queryInput.ExpressionAttributeValues?.[":skPrefix"]).toBe("MESSAGE#");
      expect(queryInput.ScanIndexForward).toBe(false);
      expect(queryInput.Limit).toBe(50);
    });
  });
});
