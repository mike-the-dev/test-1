import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { IdentityService } from "./identity.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";

const TABLE_NAME = "test-conversations-table";

const mockDatabaseConfig = {
  conversationsTable: TABLE_NAME,
};

describe("IdentityService", () => {
  let service: IdentityService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityService,
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

    service = module.get<IdentityService>(IdentityService);
  });

  describe("lookupOrCreateSession", () => {
    it("returns existing sessionUlid when identity record is found", async () => {
      const existingSessionUlid = "01EXISTING00000000000000000";

      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: "IDENTITY#discord#123456789",
          SK: "IDENTITY#discord#123456789",
          sessionUlid: existingSessionUlid,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const result = await service.lookupOrCreateSession("discord", "123456789", "lead_capture");

      expect(result).toBe(existingSessionUlid);
    });

    it("does not issue a PutCommand on a cache hit", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: "IDENTITY#discord#123456789",
          SK: "IDENTITY#discord#123456789",
          sessionUlid: "01EXISTING00000000000000000",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      await service.lookupOrCreateSession("discord", "123456789", "lead_capture");

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls).toHaveLength(0);
    });

    it("generates a new ULID and writes identity record on a cache miss", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      const result = await service.lookupOrCreateSession("discord", "987654321", "lead_capture");

      expect(result).toMatch(/^[0-9A-Z]{26}$/);

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls.length).toBeGreaterThanOrEqual(1);

      const identityPut = putCalls[0].args[0].input;

      expect(identityPut.Item?.PK).toBe("IDENTITY#discord#987654321");
      expect(identityPut.Item?.sessionUlid).toBe(result);
      expect(identityPut.ConditionExpression).toBe("attribute_not_exists(PK)");
    });

    it("formats the PK correctly for the given source and externalId", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      await service.lookupOrCreateSession("discord", "123456789", "lead_capture");

      const getCalls = ddbMock.commandCalls(GetCommand);

      expect(getCalls[0].args[0].input.Key?.PK).toBe("IDENTITY#discord#123456789");
      expect(getCalls[0].args[0].input.Key?.SK).toBe("IDENTITY#discord#123456789");
    });

    it("re-fetches and returns the winning sessionUlid on ConditionalCheckFailedException", async () => {
      const winnerSessionUlid = "01WINNER0000000000000000000";

      const conditionalError = Object.assign(new Error("Conditional check failed"), {
        name: "ConditionalCheckFailedException",
      });

      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: undefined })
        .resolvesOnce({
          Item: {
            PK: "IDENTITY#discord#111111111",
            SK: "IDENTITY#discord#111111111",
            sessionUlid: winnerSessionUlid,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });

      ddbMock.on(PutCommand).rejects(conditionalError);

      const result = await service.lookupOrCreateSession("discord", "111111111", "lead_capture");

      expect(result).toBe(winnerSessionUlid);
    });

    it("writes the initial METADATA record with source on a cache miss", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.lookupOrCreateSession("discord", "555555555", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.Key?.PK).toBe(`CHAT_SESSION#${result}`);
      expect(metadataUpdate.Key?.SK).toBe("METADATA");
      expect(metadataUpdate.ExpressionAttributeValues?.[":source"]).toBe("discord");
      expect(metadataUpdate.ExpressionAttributeNames?.["#src"]).toBe("source");
    });

    it("writes agentName to the METADATA UpdateCommand on a cache miss", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("discord", "777777777", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.ExpressionAttributeValues?.[":agentName"]).toBe("lead_capture");
      expect(metadataUpdate.UpdateExpression).toContain("agentName");
    });

    it("does not issue an UpdateCommand on a cache hit", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: "IDENTITY#discord#123456789",
          SK: "IDENTITY#discord#123456789",
          sessionUlid: "01EXISTING00000000000000000",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      await service.lookupOrCreateSession("discord", "123456789", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(0);
    });

    it("re-throws errors that are not ConditionalCheckFailedException", async () => {
      const networkError = Object.assign(new Error("Network failure"), {
        name: "NetworkingError",
      });

      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).rejects(networkError);

      await expect(service.lookupOrCreateSession("discord", "999999999", "lead_capture")).rejects.toThrow(
        "Network failure",
      );
    });

    it("writes accountUlid to METADATA UpdateCommand when provided on session creation", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", "guest-111", "shopping_assistant", "01ACCOUNTULID00000000000000");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.ExpressionAttributeValues?.[":accountUlid"]).toBe("01ACCOUNTULID00000000000000");
      expect(metadataUpdate.UpdateExpression).toContain("accountUlid");
    });

    it("does not write accountUlid to METADATA UpdateCommand when the parameter is omitted", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("discord", "guest-222", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.UpdateExpression).not.toContain("accountUlid");
      expect(metadataUpdate.ExpressionAttributeValues).not.toHaveProperty(":accountUlid");
    });

    it("existing session lookup with accountUlid passed — no UpdateCommand call at all", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: "IDENTITY#web#existing-guest",
          SK: "IDENTITY#web#existing-guest",
          sessionUlid: "01EXISTING00000000000000000",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      await service.lookupOrCreateSession("web", "existing-guest", "shopping_assistant", "01ACCOUNTULID00000000000000");

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });
});
