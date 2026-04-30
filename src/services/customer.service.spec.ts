import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { CustomerService } from "./customer.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";

const TABLE_NAME = "test-conversations-table";
const ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const CUSTOMER_ULID = "01CUSTOMERULID0000000000000";

const mockConfigService = {
  get: jest.fn((key: string) => {
    if (key === "webChat.domainGsiName") return "GSI1";
    return undefined;
  }),
};

describe("CustomerService", () => {
  let service: CustomerService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerService,
        {
          provide: DYNAMO_DB_CLIENT,
          useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<CustomerService>(CustomerService);
  });

  describe("queryCustomerIdByEmail", () => {
    it("returns { customerUlid, latestSessionId: null } when GSI match found and no latest_session_id", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}`, entity: "CUSTOMER" }],
      });

      const result = await service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "test@example.com");

      expect(result).toEqual({ customerUlid: CUSTOMER_ULID, latestSessionId: null });

      const queryCalls = ddbMock.commandCalls(QueryCommand);
      expect(queryCalls).toHaveLength(1);

      const queryInput = queryCalls[0].args[0].input;
      expect(queryInput.IndexName).toBe("GSI1");
      expect(queryInput.ExpressionAttributeValues?.[":pk"]).toBe(`ACCOUNT#${ACCOUNT_ULID}`);
      expect(queryInput.ExpressionAttributeValues?.[":sk"]).toBe("EMAIL#test@example.com");
    });

    it("returns null when GSI returns empty items", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "unknown@example.com");

      expect(result).toBeNull();
    });

    it("returns null when item PK does not start with C#", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `BAD#${CUSTOMER_ULID}`, SK: "BAD#something", entity: "CUSTOMER" }],
      });

      const result = await service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "test@example.com");

      expect(result).toBeNull();
    });

    it("propagates DDB errors — does not swallow", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("DynamoDB unavailable"));

      await expect(
        service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "test@example.com"),
      ).rejects.toThrow("DynamoDB unavailable");
    });
  });

  describe("queryCustomerIdByEmail — latestSessionId", () => {
    it("1 — returns non-null latestSessionId when Customer record has the field", async () => {
      const PRIOR_SESSION = "01PRIORSESSION00000000000";

      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}`, entity: "CUSTOMER", latest_session_id: PRIOR_SESSION }],
      });

      const result = await service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "test@example.com");

      expect(result).toEqual({ customerUlid: CUSTOMER_ULID, latestSessionId: PRIOR_SESSION });
    });

    it("2 — returns null latestSessionId when item has no latest_session_id attribute", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}`, entity: "CUSTOMER" }],
      });

      const result = await service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "test@example.com");

      expect(result).toEqual({ customerUlid: CUSTOMER_ULID, latestSessionId: null });
    });

    it("3 — returns null latestSessionId when latest_session_id is null", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}`, entity: "CUSTOMER", latest_session_id: null }],
      });

      const result = await service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "test@example.com");

      expect(result).toEqual({ customerUlid: CUSTOMER_ULID, latestSessionId: null });
    });

    it("4 — lookupOrCreateCustomer still resolves correct customerUlid after refactor", async () => {
      const PRIOR_SESSION = "01PRIORSESSION";

      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}`, entity: "CUSTOMER", latest_session_id: PRIOR_SESSION }],
      });

      const result = await service.lookupOrCreateCustomer({
        tableName: TABLE_NAME,
        accountUlid: ACCOUNT_ULID,
        email: "test@example.com",
        firstName: "Jane",
        lastName: "Doe",
        phone: null,
      });

      expect(result).toEqual({ isError: false, customerUlid: CUSTOMER_ULID, created: false });
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("lookupOrCreateCustomer", () => {
    const baseInput = {
      tableName: TABLE_NAME,
      accountUlid: ACCOUNT_ULID,
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
      phone: "555-0100",
    };

    it("1 — hit: existing customer found by email → returns { customerUlid, created: false }; no PutCommand called", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}`, entity: "CUSTOMER" }],
      });

      const result = await service.lookupOrCreateCustomer(baseInput);

      expect(result).toEqual({ isError: false, customerUlid: CUSTOMER_ULID, created: false });
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it("2 — miss: no existing customer, create succeeds → returns { customerUlid, created: true }; PutCommand with attribute_not_exists(PK); record has non-null first_name, last_name, latest_session_id: null", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});

      const result = await service.lookupOrCreateCustomer(baseInput);

      expect(result.isError).toBe(false);
      if (result.isError) return;

      expect(result.created).toBe(true);
      expect(typeof result.customerUlid).toBe("string");
      expect(result.customerUlid.length).toBeGreaterThan(0);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const putInput = putCalls[0].args[0].input;
      expect(putInput.ConditionExpression).toBe("attribute_not_exists(PK)");
      expect(putInput.Item?.first_name).toBe("Jane");
      expect(putInput.Item?.last_name).toBe("Doe");
      expect(putInput.Item?.latest_session_id).toBeNull();
      expect(putInput.Item?.entity).toBe("CUSTOMER");
    });

    it("3 — race-on-create: PutCommand throws ConditionalCheckFailedException, re-query succeeds → returns { customerUlid: recovered, created: false }; QueryCommand called twice", async () => {
      const RECOVERED_ULID = "01RECOVEREDCUSTOMER00000000";

      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [{ PK: `C#${RECOVERED_ULID}`, SK: `C#${RECOVERED_ULID}`, entity: "CUSTOMER" }] });

      ddbMock
        .on(PutCommand)
        .rejects(Object.assign(new Error("Conditional check failed"), { name: "ConditionalCheckFailedException" }));

      const result = await service.lookupOrCreateCustomer(baseInput);

      expect(result).toEqual({ isError: false, customerUlid: RECOVERED_ULID, created: false });
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
    });

    it("4 — generic DDB error: QueryCommand throws → returns { error: string }", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("DynamoDB unavailable"));

      const result = await service.lookupOrCreateCustomer(baseInput);

      expect(result.isError).toBe(true);
      if (!result.isError) return;
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    });

    it("5 — PutCommand throws non-ConditionalCheck error → returns { error: string }", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock
        .on(PutCommand)
        .rejects(Object.assign(new Error("InternalServerError"), { name: "InternalServerError" }));

      const result = await service.lookupOrCreateCustomer(baseInput);

      expect(result.isError).toBe(true);
    });

    it("6 — race-on-create where re-query also returns empty → returns { error: string }", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock
        .on(PutCommand)
        .rejects(Object.assign(new Error("Conditional check failed"), { name: "ConditionalCheckFailedException" }));

      const result = await service.lookupOrCreateCustomer(baseInput);

      expect(result.isError).toBe(true);
    });
  });
});
