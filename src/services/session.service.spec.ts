import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { SessionService } from "./session.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";

const TABLE_NAME = "test-conversations-table";

const VALID_ACCOUNT_ULID = "01BXACCNTACCT0000000000000";
const VALID_SESSION_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STALE_SESSION_ULID = "01ARYZ3NDEKTSV4RRFFQ69G5FA";
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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

  describe("lookupOrCreateSession", () => {
    it("(a) sessionId provided + METADATA exists → resumes existing session without writing DDB", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          onboarding_completed_at: "2026-04-19T20:00:00.000Z",
          kickoff_completed_at: null,
          budget_cents: 50_000,
        },
      });

      const result = await service.lookupOrCreateSession("web", VALID_SESSION_ULID, "shopping_assistant", VALID_ACCOUNT_ULID);

      expect(result.sessionUlid).toBe(VALID_SESSION_ULID);
      expect(result.wasCreated).toBe(false);
      expect(result.onboardingCompletedAt).toBe("2026-04-19T20:00:00.000Z");
      expect(result.budgetCents).toBe(50_000);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it("(b) sessionId provided + METADATA not found → mints new session with different ULID", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", STALE_SESSION_ULID, "shopping_assistant", VALID_ACCOUNT_ULID);

      expect(result.wasCreated).toBe(true);
      expect(result.sessionUlid).not.toBe(STALE_SESSION_ULID);
      expect(result.sessionUlid).toMatch(ULID_REGEX);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    it("(c) sessionId is null → mints immediately without issuing a GetCommand", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", null, "shopping_assistant", VALID_ACCOUNT_ULID);

      expect(result.wasCreated).toBe(true);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it("issues an UpdateCommand with correct PK, source, agentName, and null defaults", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", null, "shopping_assistant");

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.Key?.PK).toBe(`CHAT_SESSION#${result.sessionUlid}`);
      expect(input.Key?.SK).toBe("METADATA");
      expect(input.ExpressionAttributeValues?.[":source"]).toBe("web");
      expect(input.ExpressionAttributeNames?.["#src"]).toBe("source");
      expect(input.ExpressionAttributeValues?.[":customerIdNull"]).toBeNull();
      expect(input.ExpressionAttributeValues?.[":contFromNull"]).toBeNull();
      expect(input.ExpressionAttributeValues?.[":contAtNull"]).toBeNull();
      expect(input.ExpressionAttributeValues?.[":agentName"]).toBe("shopping_assistant");
      expect(input.UpdateExpression).toContain("agent_name");
    });

    it("issues a PutCommand for the pointer record with agentName when accountUlid is provided", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", null, "shopping_assistant", VALID_ACCOUNT_ULID);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const pointerPut = putCalls[0].args[0].input;
      expect(pointerPut.Item?.PK).toBe(`A#${VALID_ACCOUNT_ULID}`);
      expect(pointerPut.Item?.SK).toBe(`CHAT_SESSION#${result.sessionUlid}`);
      expect(pointerPut.Item?.entity).toBe("CHAT_SESSION");
      expect(pointerPut.Item?.session_id).toBe(result.sessionUlid);
      expect(pointerPut.Item?.source).toBe("web");
      expect(pointerPut.Item?.agent_name).toBe("shopping_assistant");
      expect(typeof pointerPut.Item?._createdAt_).toBe("string");
      expect(typeof pointerPut.Item?._lastUpdated_).toBe("string");
    });

    it("does not issue a PutCommand when accountUlid is omitted", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("email", null, "lead_capture");

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(0);
    });

    it("catches pointer write failure and logs without re-throwing — result still returned", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const pointerError = Object.assign(new Error("Pointer write failed"), {
        name: "InternalServerError",
      });

      ddbMock.on(PutCommand).rejects(pointerError);

      const result = await service.lookupOrCreateSession("web", null, "lead_capture", VALID_ACCOUNT_ULID);

      expect(result.sessionUlid).toMatch(ULID_REGEX);
      expect(result.wasCreated).toBe(true);
    });

    it("returns wasCreated: true and a ULID string in sessionUlid", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await service.lookupOrCreateSession("web", null, "lead_capture");

      expect(result.wasCreated).toBe(true);
      expect(typeof result.sessionUlid).toBe("string");
      expect(result.sessionUlid).toMatch(ULID_REGEX);
    });

    it("writes accountUlid to the UpdateCommand when provided", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      await service.lookupOrCreateSession("web", null, "lead_capture", VALID_ACCOUNT_ULID);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.ExpressionAttributeValues?.[":accountId"]).toBe(VALID_ACCOUNT_ULID);
      expect(input.UpdateExpression).toContain("account_id");
    });

    it("does not write accountUlid to the UpdateCommand when omitted", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await service.lookupOrCreateSession("web", null, "lead_capture");

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
