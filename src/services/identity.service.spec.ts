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

      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            PK: "IDENTITY#web#123456789",
            SK: "IDENTITY#web#123456789",
            session_id: existingSessionUlid,
            _createdAt_: "2026-01-01T00:00:00.000Z",
          },
        })
        .resolvesOnce({
          Item: {
            PK: `CHAT_SESSION#${existingSessionUlid}`,
            SK: "METADATA",
            onboarding_completed_at: "2026-04-19T20:00:00.000Z",
            budget_cents: 100_000,
          },
        });

      const result = await service.lookupOrCreateSession("web", "123456789", "lead_capture");

      expect(result).toEqual({
        sessionUlid: existingSessionUlid,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        kickoffCompletedAt: null,
        budgetCents: 100_000,
        wasCreated: false,
      });
    });

    it("returns null onboarding fields when METADATA record lacks them", async () => {
      const existingSessionUlid = "01EXISTING00000000000000000";

      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            PK: "IDENTITY#web#123456789",
            SK: "IDENTITY#web#123456789",
            session_id: existingSessionUlid,
            _createdAt_: "2026-01-01T00:00:00.000Z",
          },
        })
        .resolvesOnce({
          Item: {
            PK: `CHAT_SESSION#${existingSessionUlid}`,
            SK: "METADATA",
          },
        });

      const result = await service.lookupOrCreateSession("web", "123456789", "lead_capture");

      expect(result).toEqual({
        sessionUlid: existingSessionUlid,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        budgetCents: null,
        wasCreated: false,
      });
    });

    it("echoes kickoff_completed_at from METADATA when the session already has a kickoff stamp", async () => {
      const existingSessionUlid = "01EXISTING00000000000000000";

      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            PK: "IDENTITY#web#123456789",
            SK: "IDENTITY#web#123456789",
            session_id: existingSessionUlid,
            _createdAt_: "2026-01-01T00:00:00.000Z",
          },
        })
        .resolvesOnce({
          Item: {
            PK: `CHAT_SESSION#${existingSessionUlid}`,
            SK: "METADATA",
            kickoff_completed_at: "2026-04-20T22:00:00.000Z",
          },
        });

      const result = await service.lookupOrCreateSession("web", "123456789", "lead_capture");

      expect(result.kickoffCompletedAt).toBe("2026-04-20T22:00:00.000Z");
    });

    it("does not issue a PutCommand on a cache hit", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: "IDENTITY#web#123456789",
          SK: "IDENTITY#web#123456789",
          session_id: "01EXISTING00000000000000000",
          _createdAt_: "2026-01-01T00:00:00.000Z",
        },
      });

      await service.lookupOrCreateSession("web", "123456789", "lead_capture");

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls).toHaveLength(0);
    });

    it("generates a new ULID and writes identity record on a cache miss", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", "987654321", "lead_capture");

      expect(result.sessionUlid).toMatch(/^[0-9A-Z]{26}$/);
      expect(result.onboardingCompletedAt).toBeNull();
      expect(result.kickoffCompletedAt).toBeNull();
      expect(result.budgetCents).toBeNull();
      expect(result.wasCreated).toBe(true);

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls.length).toBeGreaterThanOrEqual(1);

      const identityPut = putCalls[0].args[0].input;

      expect(identityPut.Item?.PK).toBe("IDENTITY#web#987654321");
      expect(identityPut.Item?.session_id).toBe(result.sessionUlid);
      expect(identityPut.ConditionExpression).toBe("attribute_not_exists(PK)");
    });

    it("formats the PK correctly for the given source and externalId", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      await service.lookupOrCreateSession("web", "123456789", "lead_capture");

      const getCalls = ddbMock.commandCalls(GetCommand);

      expect(getCalls[0].args[0].input.Key?.PK).toBe("IDENTITY#web#123456789");
      expect(getCalls[0].args[0].input.Key?.SK).toBe("IDENTITY#web#123456789");
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
            PK: "IDENTITY#web#111111111",
            SK: "IDENTITY#web#111111111",
            session_id: winnerSessionUlid,
            _createdAt_: "2026-01-01T00:00:00.000Z",
          },
        });

      ddbMock.on(PutCommand).rejects(conditionalError);

      const result = await service.lookupOrCreateSession("web", "111111111", "lead_capture");

      expect(result).toEqual({
        sessionUlid: winnerSessionUlid,
        onboardingCompletedAt: null,
        kickoffCompletedAt: null,
        budgetCents: null,
        wasCreated: false,
      });
    });

    it("writes the initial METADATA record with source on a cache miss", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", "555555555", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.Key?.PK).toBe(`CHAT_SESSION#${result.sessionUlid}`);
      expect(metadataUpdate.Key?.SK).toBe("METADATA");
      expect(metadataUpdate.ExpressionAttributeValues?.[":source"]).toBe("web");
      expect(metadataUpdate.ExpressionAttributeNames?.["#src"]).toBe("source");
    });

    it("writes agentName to the METADATA UpdateCommand on a cache miss", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", "777777777", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.ExpressionAttributeValues?.[":agentName"]).toBe("lead_capture");
      expect(metadataUpdate.UpdateExpression).toContain("agent_name");
    });

    it("schema-default — METADATA UpdateCommand initialises customer_id to null on new session creation", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", "888888888", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.ExpressionAttributeValues?.[":customerIdNull"]).toBeNull();
      expect(metadataUpdate.UpdateExpression).toContain("customer_id");
    });

    it("schema-default — METADATA UpdateCommand initialises continuation_from_session_id to null on new session creation", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", "888888889", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.ExpressionAttributeValues?.[":contFromNull"]).toBeNull();
      expect(metadataUpdate.UpdateExpression).toContain("continuation_from_session_id");
    });

    it("schema-default — METADATA UpdateCommand initialises continuation_loaded_at to null on new session creation", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", "888888890", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.ExpressionAttributeValues?.[":contAtNull"]).toBeNull();
      expect(metadataUpdate.UpdateExpression).toContain("continuation_loaded_at");
    });

    it("does not issue an UpdateCommand on a cache hit", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: "IDENTITY#web#123456789",
          SK: "IDENTITY#web#123456789",
          session_id: "01EXISTING00000000000000000",
          _createdAt_: "2026-01-01T00:00:00.000Z",
        },
      });

      await service.lookupOrCreateSession("web", "123456789", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(0);
    });

    it("re-throws errors that are not ConditionalCheckFailedException", async () => {
      const networkError = Object.assign(new Error("Network failure"), {
        name: "NetworkingError",
      });

      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).rejects(networkError);

      await expect(service.lookupOrCreateSession("web", "999999999", "lead_capture")).rejects.toThrow(
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

      expect(metadataUpdate.ExpressionAttributeValues?.[":accountId"]).toBe("01ACCOUNTULID00000000000000");
      expect(metadataUpdate.UpdateExpression).toContain("account_id");
    });

    it("does not write accountUlid to METADATA UpdateCommand when the parameter is omitted", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", "guest-222", "lead_capture");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(updateCalls).toHaveLength(1);

      const metadataUpdate = updateCalls[0].args[0].input;

      expect(metadataUpdate.UpdateExpression).not.toContain("account_id");
      expect(metadataUpdate.ExpressionAttributeValues).not.toHaveProperty(":accountId");
    });

    it("writes the session pointer record when accountUlid is provided on new session creation", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.lookupOrCreateSession(
        "web",
        "guest-333",
        "shopping_assistant",
        "01ACCOUNTULID00000000000000",
      );

      const putCalls = ddbMock.commandCalls(PutCommand);

      // First put is the identity record, second put is the account-scoped pointer.
      expect(putCalls).toHaveLength(2);

      const pointerPut = putCalls[1].args[0].input;

      expect(pointerPut.Item?.PK).toBe("A#01ACCOUNTULID00000000000000");
      expect(pointerPut.Item?.SK).toBe(`CHAT_SESSION#${result.sessionUlid}`);
      expect(pointerPut.Item?.entity).toBe("CHAT_SESSION");
      expect(pointerPut.Item?.session_id).toBe(result.sessionUlid);
      expect(pointerPut.Item?.agent_name).toBe("shopping_assistant");
      expect(pointerPut.Item?.source).toBe("web");
      expect(typeof pointerPut.Item?._createdAt_).toBe("string");
      expect(typeof pointerPut.Item?._lastUpdated_).toBe("string");
    });

    it("does not write the session pointer record when accountUlid is omitted", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", "guest-444", "lead_capture");

      const putCalls = ddbMock.commandCalls(PutCommand);

      expect(putCalls).toHaveLength(1);

      const onlyPut = putCalls[0].args[0].input;

      expect(String(onlyPut.Item?.PK)).toMatch(/^IDENTITY#/);
    });

    it("returns the new sessionUlid even when the pointer put fails", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(UpdateCommand).resolves({});

      const pointerError = Object.assign(new Error("Pointer write failed"), {
        name: "InternalServerError",
      });

      ddbMock
        .on(PutCommand)
        .resolvesOnce({})
        .rejects(pointerError);

      const result = await service.lookupOrCreateSession(
        "web",
        "guest-555",
        "shopping_assistant",
        "01ACCOUNTULID00000000000000",
      );

      expect(result.sessionUlid).toMatch(/^[0-9A-Z]{26}$/);
    });

    it("returns wasCreated: true when a new session is created", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", "new-guest-111", "shopping_assistant", "01ACCOUNTULID00000000000000");

      expect(result.wasCreated).toBe(true);
    });

    it("returns wasCreated: false when an existing session is resumed", async () => {
      ddbMock
        .on(GetCommand)
        .resolvesOnce({
          Item: {
            PK: "IDENTITY#web#existing-guest-222",
            SK: "IDENTITY#web#existing-guest-222",
            session_id: "01EXISTING00000000000000000",
            _createdAt_: "2026-01-01T00:00:00.000Z",
          },
        })
        .resolvesOnce({ Item: { PK: "CHAT_SESSION#01EXISTING00000000000000000", SK: "METADATA" } });

      const result = await service.lookupOrCreateSession("web", "existing-guest-222", "shopping_assistant", "01ACCOUNTULID00000000000000");

      expect(result.wasCreated).toBe(false);
    });

    it("returns wasCreated: false on the race-condition recovery path", async () => {
      const winnerSessionUlid = "01WINNER0000000000000000001";

      const conditionalError = Object.assign(new Error("Conditional check failed"), {
        name: "ConditionalCheckFailedException",
      });

      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: undefined })
        .resolvesOnce({
          Item: {
            PK: "IDENTITY#web#race-guest-333",
            SK: "IDENTITY#web#race-guest-333",
            session_id: winnerSessionUlid,
            _createdAt_: "2026-01-01T00:00:00.000Z",
          },
        });

      ddbMock.on(PutCommand).rejects(conditionalError);

      const result = await service.lookupOrCreateSession("web", "race-guest-333", "shopping_assistant", "01ACCOUNTULID00000000000000");

      expect(result.wasCreated).toBe(false);
      expect(result.sessionUlid).toBe(winnerSessionUlid);
    });

    it("existing session lookup with accountUlid passed — no UpdateCommand call at all", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          PK: "IDENTITY#web#existing-guest",
          SK: "IDENTITY#web#existing-guest",
          session_id: "01EXISTING00000000000000000",
          _createdAt_: "2026-01-01T00:00:00.000Z",
        },
      });

      await service.lookupOrCreateSession("web", "existing-guest", "shopping_assistant", "01ACCOUNTULID00000000000000");

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
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
