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
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";

const TABLE_NAME = "test-conversations-table";

const mockDatabaseConfig = {
  conversationsTable: TABLE_NAME,
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
      ],
    }).compile();

    service = module.get<ChatSessionService>(ChatSessionService);
  });

  describe("appendUserMessage", () => {
    const SESSION_ULID = "01APPENDSESSION000000000000";

    it("writes a user message row with correct fields for a web channel message", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "web", "Hello from web");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const item = putCalls[0].args[0].input.Item;
      expect(item?.PK).toBe(`CHAT_SESSION#${SESSION_ULID}`);
      expect(item?.SK).toMatch(/^MESSAGE#/);
      expect(item?.role).toBe("user");
      expect(JSON.parse(item?.content as string)).toEqual([{ type: "text", text: "Hello from web" }]);
      expect(item?.channel).toBe("web");
      expect(item?._createdAt_).toBeDefined();
    });

    it("writes a user message row with channel=sms for sms messages", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "sms", "Hello from SMS");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls[0].args[0].input.Item?.channel).toBe("sms");
    });

    it("writes a user message row with channel=email for email messages", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "email", "Hello from email");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls[0].args[0].input.Item?.channel).toBe("email");
    });

    it("updates METADATA with _lastUpdated_ for non-email channels", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "web", "Hello");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.Key).toEqual({ PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" });
      expect(input.UpdateExpression).toContain("#lastUpdated");
      expect(input.UpdateExpression).not.toContain("last_inbound_email_message_id");
    });

    it("sets last_inbound_email_message_id, last_inbound_email_subject, reply_domain, and from_name on METADATA when emailContext is provided", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "email", "Hello from email", {
        messageId: "<abc123@mail.example.com>",
        subject: "Help needed",
        replyDomain: "reply.example.com",
        fromName: "Test Concierge",
      });

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.UpdateExpression).toContain("last_inbound_email_message_id");
      expect(input.UpdateExpression).toContain("last_inbound_email_subject");
      expect(input.UpdateExpression).toContain("reply_domain");
      expect(input.UpdateExpression).toContain("from_name");
      expect(input.ExpressionAttributeValues?.[":mid"]).toBe("<abc123@mail.example.com>");
      expect(input.ExpressionAttributeValues?.[":sub"]).toBe("Help needed");
      expect(input.ExpressionAttributeValues?.[":rd"]).toBe("reply.example.com");
      expect(input.ExpressionAttributeValues?.[":fn"]).toBe("Test Concierge");
    });

    it("issues exactly one PutCommand and one UpdateCommand when emailContext is provided", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "email", "Email text", {
        messageId: "<id@example.com>",
        subject: "Subject line",
        replyDomain: "reply.example.com",
        fromName: "Test Concierge",
      });

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    });

    it("issues exactly one PutCommand and one UpdateCommand when no emailContext", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "web", "Web text");

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    });

    it("uses if_not_exists on _createdAt_ to avoid overwriting existing session creation time", async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.appendUserMessage(SESSION_ULID, "web", "Hello");

      const updateInput = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(updateInput.UpdateExpression).toContain("if_not_exists(#createdAt");
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
