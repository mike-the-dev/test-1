import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "crypto";

import { VerifyCodeTool } from "./verify-code.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { CustomerService } from "../services/customer.service";

const TABLE_NAME = "test-conversations-table";
const SESSION_ULID = "01TESTSESSION0000000000000";
const ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const CUSTOMER_ULID = "01CUSTOMERULID0000000000000";

const VALID_CODE = "042007";
const VALID_CODE_HASH = createHash("sha256").update(VALID_CODE).digest("hex");

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const mockCustomerService = {
  queryCustomerIdByEmail: jest.fn(),
};

const TEST_CONTEXT = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

function makeVerificationCodeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "VERIFICATION_CODE",
    entity: "VERIFICATION_CODE",
    code_hash: VALID_CODE_HASH,
    email: "visitor@example.com",
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    attempts: 0,
    request_count_in_window: 1,
    request_window_start_at: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + 600,
    _createdAt_: new Date().toISOString(),
    _lastUpdated_: new Date().toISOString(),
    ...overrides,
  };
}

describe("VerifyCodeTool", () => {
  let tool: VerifyCodeTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({ customerUlid: CUSTOMER_ULID, latestSessionId: "01PRIORSESSIONULID000000000" });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerifyCodeTool,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        {
          provide: DatabaseConfigService,
          useValue: mockDatabaseConfig,
        },
        {
          provide: CustomerService,
          useValue: mockCustomerService,
        },
      ],
    }).compile();

    tool = module.get<VerifyCodeTool>(VerifyCodeTool);
  });

  describe("execute", () => {
    it("1 — happy path: correct code returns { verified: true, customerId }, writes to METADATA and Customer, deletes record", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem() });

      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const result = await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(true);
      expect(parsed.customerId).toBe(`C#${CUSTOMER_ULID}`);

      // METADATA UpdateCommand called with customer_id and continuation_from_session_id
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find((call) =>
        (call.args[0].input.Key as Record<string, string>).SK === "METADATA",
      );
      expect(metadataUpdate).toBeDefined();
      expect(metadataUpdate!.args[0].input.ExpressionAttributeValues?.[":customerId"]).toBe(`C#${CUSTOMER_ULID}`);
      expect(metadataUpdate!.args[0].input.UpdateExpression).toContain("continuation_from_session_id");
      expect(metadataUpdate!.args[0].input.ExpressionAttributeValues?.[":contFromSessionId"]).toBe("01PRIORSESSIONULID000000000");

      // Customer UpdateCommand called with latest_session_id
      const customerUpdate = updateCalls.find((call) =>
        (call.args[0].input.Key as Record<string, string>).PK === `C#${CUSTOMER_ULID}`,
      );
      expect(customerUpdate).toBeDefined();
      expect(customerUpdate!.args[0].input.ExpressionAttributeValues?.[":sessionUlid"]).toBe(SESSION_ULID);

      // DeleteCommand called on VERIFICATION_CODE
      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls).toHaveLength(1);
      expect((deleteCalls[0].args[0].input.Key as Record<string, string>).PK).toBe(`CHAT_SESSION#${SESSION_ULID}`);
      expect((deleteCalls[0].args[0].input.Key as Record<string, string>).SK).toBe("VERIFICATION_CODE");
    });

    it("2 — wrong code: returns { verified: false, reason: 'wrong_code' }, increments attempts", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem({ attempts: 0 }) });

      ddbMock.on(UpdateCommand).resolves({});

      const result = await tool.execute({ code: "999999" }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toBe("wrong_code");

      // UpdateCommand called to increment attempts (not customer update)
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const attemptsUpdate = updateCalls.find((call) =>
        (call.args[0].input.Key as Record<string, string>).SK === "VERIFICATION_CODE",
      );
      expect(attemptsUpdate).toBeDefined();
      expect(attemptsUpdate!.args[0].input.ExpressionAttributeValues?.[":one"]).toBe(1);

      // No customer_id written; no delete
      const metadataUpdate = updateCalls.find((call) =>
        (call.args[0].input.Key as Record<string, string>).SK === "METADATA",
      );
      expect(metadataUpdate).toBeUndefined();
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it("3 — expired code: returns { verified: false, reason: 'expired' }, no attempts increment", async () => {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem({ expires_at: oneMinuteAgo }) });

      const result = await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toBe("expired");

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it("4 — max attempts reached: returns { verified: false, reason: 'max_attempts' }, no writes", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem({ attempts: 5 }) });

      const result = await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toBe("max_attempts");

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it("5 — no pending code: returns { verified: false, reason: 'no_pending_code' }", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: undefined });

      const result = await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toBe("no_pending_code");
    });

    it("6 — customer not found by email: returns { verified: false, reason: 'no_pending_code' }, no customer_id written", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem() });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(null);  // null whole result = no customer

      const result = await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toBe("no_pending_code");

      // No customer_id written to METADATA
      const metadataUpdate = ddbMock.commandCalls(UpdateCommand).find((call) =>
        (call.args[0].input.Key as Record<string, string>).SK === "METADATA",
      );
      expect(metadataUpdate).toBeUndefined();
    });

    it("7 — attempts checked BEFORE hash: with attempts=5, no UpdateCommand issued (code never compared)", async () => {
      // Behavioral proxy: Jest cannot spy on a destructured named import (`import { createHash } from "crypto"`).
      // Instead, we verify the check-before-hash invariant indirectly: the attempts-increment UpdateCommand
      // fires only AFTER a hash comparison fails. If hashing were attempted first, a wrong code submitted
      // here (attempts=5) would still trigger an UpdateCommand. No UpdateCommand proves the code was never hashed.
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem({ attempts: 5 }) });

      const result = await tool.execute({ code: "000000" }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toBe("max_attempts");

      // No UpdateCommand at all — proves the code was never hashed nor compared
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it("8 — authority email used: CustomerService called with record email, not live contact-info email", async () => {
      const RECORD_EMAIL = "record@example.com";
      const LIVE_EMAIL = "live@example.com";

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({
          Item: makeVerificationCodeItem({ email: RECORD_EMAIL }),
        });

      // Simulate a different live email in USER_CONTACT_INFO (should NOT be read)
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({
          Item: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO", email: LIVE_EMAIL },
        });

      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      // CustomerService must have been called with the RECORD email, not the live email
      expect(mockCustomerService.queryCustomerIdByEmail).toHaveBeenCalledWith(
        TABLE_NAME,
        ACCOUNT_ULID,
        RECORD_EMAIL,
      );
      expect(mockCustomerService.queryCustomerIdByEmail).not.toHaveBeenCalledWith(
        TABLE_NAME,
        ACCOUNT_ULID,
        LIVE_EMAIL,
      );
    });

    it("9 — Write A sets continuation_from_session_id to null when customer has no prior session", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem() });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({ customerUlid: CUSTOMER_ULID, latestSessionId: null });

      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const result = await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(true);

      const metadataUpdate = ddbMock.commandCalls(UpdateCommand).find((call) =>
        call.args[0].input.Key?.SK === "METADATA",
      );
      expect(metadataUpdate).toBeDefined();
      expect(metadataUpdate!.args[0].input.ExpressionAttributeValues?.[":contFromSessionId"]).toBeNull();
    });

    it("10 — Write A sets continuation_from_session_id to the prior session ULID (explicit check)", async () => {
      const PRIOR_SESSION = "01PRIORSESSIONULID000000000";

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem() });

      mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({ customerUlid: CUSTOMER_ULID, latestSessionId: PRIOR_SESSION });

      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      await tool.execute({ code: VALID_CODE }, TEST_CONTEXT);

      const metadataUpdate = ddbMock.commandCalls(UpdateCommand).find((call) =>
        call.args[0].input.Key?.SK === "METADATA",
      );
      expect(metadataUpdate).toBeDefined();
      expect(metadataUpdate!.args[0].input.ExpressionAttributeValues?.[":contFromSessionId"]).toBe(PRIOR_SESSION);
    });

    it("11 — verify_code failure path: continuation_from_session_id is NOT written when code is wrong", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "VERIFICATION_CODE" } })
        .resolves({ Item: makeVerificationCodeItem({ attempts: 0 }) });

      ddbMock.on(UpdateCommand).resolves({});

      const result = await tool.execute({ code: "999999" }, TEST_CONTEXT);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.verified).toBe(false);
      expect(parsed.reason).toBe("wrong_code");

      // Only the attempts increment UpdateCommand fires; no METADATA UpdateCommand with continuation_from_session_id
      const metadataUpdate = ddbMock.commandCalls(UpdateCommand).find((call) =>
        call.args[0].input.Key?.SK === "METADATA",
      );
      expect(metadataUpdate).toBeUndefined();
    });
  });
});
