import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { SaveUserFactTool } from "./save-user-fact.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";

const TABLE_NAME = "test-conversations-table";

const mockDatabaseConfig = {
  conversationsTable: TABLE_NAME,
};

const TEST_CONTEXT = { sessionUlid: "01TESTSESSION0000000000000" };

describe("SaveUserFactTool", () => {
  let tool: SaveUserFactTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SaveUserFactTool,
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

    tool = module.get<SaveUserFactTool>(SaveUserFactTool);
  });

  describe("execute", () => {
    it("returns isError result when key is missing", async () => {
      const result = await tool.execute({ value: "Acme Corp" }, TEST_CONTEXT);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Invalid input");
    });

    it("returns isError result when value is an empty string", async () => {
      const result = await tool.execute({ key: "employer", value: "" }, TEST_CONTEXT);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Invalid input");
    });

    it("returns isError result when input is not an object", async () => {
      const result = await tool.execute("not-an-object", TEST_CONTEXT);

      expect(result.isError).toBe(true);
    });

    it("writes a PutCommand with the correct PK, SK, value, and updatedAt", async () => {
      ddbMock.on(PutCommand).resolves({});

      await tool.execute({ key: "employer", value: "Acme Corp" }, TEST_CONTEXT);

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls).toHaveLength(1);

      const item = putCalls[0].args[0].input.Item;

      expect(item?.PK).toBe("CHAT_SESSION#01TESTSESSION0000000000000");
      expect(item?.SK).toBe("USER_FACT#employer");
      expect(item?.value).toBe("Acme Corp");
      expect(item?.updatedAt).toBeDefined();
    });

    it("returns success result on a successful DynamoDB write", async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute({ key: "employer", value: "Acme Corp" }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      expect(result.result).toBe("Fact saved successfully.");
    });

    it("returns isError result and does NOT throw when DynamoDB rejects", async () => {
      ddbMock.on(PutCommand).rejects(new Error("DynamoDB unavailable"));

      const result = await tool.execute({ key: "employer", value: "Acme Corp" }, TEST_CONTEXT);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Failed to save fact");
    });

    it("overwrites an existing fact when the same key is re-saved (idempotent PutCommand)", async () => {
      ddbMock.on(PutCommand).resolves({});

      await tool.execute({ key: "employer", value: "Acme Corp" }, TEST_CONTEXT);
      await tool.execute({ key: "employer", value: "New Corp" }, TEST_CONTEXT);

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls).toHaveLength(2);
      expect(putCalls[1].args[0].input.Item?.value).toBe("New Corp");
    });
  });
});
