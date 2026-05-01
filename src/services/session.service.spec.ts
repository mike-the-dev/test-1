import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { SessionService } from "./session.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";

const TABLE_NAME = "test-conversations-table";

const mockDatabaseConfig = {
  conversationsTable: TABLE_NAME,
};

describe("SessionService", () => {
  let service: SessionService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
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

    service = module.get<SessionService>(SessionService);
  });

  describe("createSession", () => {
    it("issues an UpdateCommand with correct PK, source, and null defaults", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.createSession("web");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.Key?.PK).toBe(`CHAT_SESSION#${result}`);
      expect(input.Key?.SK).toBe("METADATA");
      expect(input.ExpressionAttributeValues?.[":source"]).toBe("web");
      expect(input.ExpressionAttributeNames?.["#src"]).toBe("source");
      expect(input.ExpressionAttributeValues?.[":customerIdNull"]).toBeNull();
      expect(input.ExpressionAttributeValues?.[":contFromNull"]).toBeNull();
      expect(input.ExpressionAttributeValues?.[":contAtNull"]).toBeNull();
    });

    it("issues a PutCommand for the pointer record when accountUlid is provided", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const result = await service.createSession("web", "01ACCOUNTULID00000000000000");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const pointerPut = putCalls[0].args[0].input;
      expect(pointerPut.Item?.PK).toBe("A#01ACCOUNTULID00000000000000");
      expect(pointerPut.Item?.SK).toBe(`CHAT_SESSION#${result}`);
      expect(pointerPut.Item?.entity).toBe("CHAT_SESSION");
      expect(pointerPut.Item?.session_id).toBe(result);
      expect(pointerPut.Item?.source).toBe("web");
      expect(typeof pointerPut.Item?._createdAt_).toBe("string");
      expect(typeof pointerPut.Item?._lastUpdated_).toBe("string");
    });

    it("does not issue a PutCommand when accountUlid is omitted", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await service.createSession("email");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(0);
    });

    it("catches pointer write failure and logs without re-throwing — return value still present", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const pointerError = Object.assign(new Error("Pointer write failed"), {
        name: "InternalServerError",
      });

      ddbMock.on(PutCommand).rejects(pointerError);

      const result = await service.createSession("web", "01ACCOUNTULID00000000000000");

      expect(result).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it("returns the new session ULID as a string", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.createSession("web");

      expect(typeof result).toBe("string");
      expect(result).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it("writes accountUlid to the UpdateCommand when provided", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      await service.createSession("web", "01ACCOUNTULID00000000000000");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.ExpressionAttributeValues?.[":accountId"]).toBe("01ACCOUNTULID00000000000000");
      expect(input.UpdateExpression).toContain("account_id");
    });

    it("does not write accountUlid to the UpdateCommand when omitted", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await service.createSession("web");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.UpdateExpression).not.toContain("account_id");
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":accountId");
    });
  });

  describe("updateOnboarding", () => {
    const SESSION_ULID = "01TESTSESSION0000000000000";

    it("writes onboarding_completed_at and budget_cents to the METADATA record", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await service.updateOnboarding(SESSION_ULID, 100_000);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.Key?.PK).toBe(`CHAT_SESSION#${SESSION_ULID}`);
      expect(input.Key?.SK).toBe("METADATA");
      expect(input.UpdateExpression).toContain("onboarding_completed_at = :now");
      expect(input.UpdateExpression).toContain("budget_cents = :cents");
      expect(input.ExpressionAttributeValues?.[":cents"]).toBe(100_000);
      expect(input.ConditionExpression).toBe("attribute_exists(PK)");

      const metadataGets = ddbMock
        .commandCalls(GetCommand)
        .filter((call) => call.args[0].input.Key?.SK === "METADATA");
      expect(metadataGets).toHaveLength(1);

      expect(result.sessionUlid).toBe(SESSION_ULID);
      expect(result.budgetCents).toBe(100_000);
      expect(typeof result.onboardingCompletedAt).toBe("string");
      expect(result.onboardingCompletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.kickoffCompletedAt).toBeNull();
    });

    it("echoes kickoff_completed_at from METADATA read-back when stamp exists", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: `CHAT_SESSION#${SESSION_ULID}`,
          SK: "METADATA",
          kickoff_completed_at: "2026-04-20T22:00:00.000Z",
        },
      });

      const result = await service.updateOnboarding(SESSION_ULID, 100_000);

      const getCalls = ddbMock.commandCalls(GetCommand);
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0].args[0].input.Key?.PK).toBe(`CHAT_SESSION#${SESSION_ULID}`);
      expect(getCalls[0].args[0].input.Key?.SK).toBe("METADATA");

      expect(result.kickoffCompletedAt).toBe("2026-04-20T22:00:00.000Z");
    });

    it("propagates ConditionalCheckFailedException so the controller can map it to 404", async () => {
      const conditionalError = Object.assign(new Error("Condition failed"), {
        name: "ConditionalCheckFailedException",
      });

      ddbMock.on(UpdateCommand).rejects(conditionalError);

      await expect(service.updateOnboarding(SESSION_ULID, 50_000)).rejects.toMatchObject({
        name: "ConditionalCheckFailedException",
      });
    });
  });
});
