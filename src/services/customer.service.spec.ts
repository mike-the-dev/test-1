import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
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
    it("returns bare customerUlid when GSI match found", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ PK: `C#${CUSTOMER_ULID}`, SK: `C#${CUSTOMER_ULID}`, entity: "CUSTOMER" }],
      });

      const result = await service.queryCustomerIdByEmail(TABLE_NAME, ACCOUNT_ULID, "test@example.com");

      expect(result).toBe(CUSTOMER_ULID);

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
});
