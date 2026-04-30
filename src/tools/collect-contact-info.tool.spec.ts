import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { CollectContactInfoTool } from "./collect-contact-info.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { CustomerService } from "../services/customer.service";

const TABLE_NAME = "test-conversations-table";
const SESSION_ULID = "01TESTSESSION0000000000000";
const ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const CUSTOMER_ULID = "01CUSTOMERULID0000000000000";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const mockCustomerService = {
  lookupOrCreateCustomer: jest.fn(),
};

const TEST_CONTEXT = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

function makeContactInfoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "USER_CONTACT_INFO",
    ...overrides,
  };
}

function makeMetadataItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "METADATA",
    ...overrides,
  };
}

describe("CollectContactInfoTool", () => {
  let tool: CollectContactInfoTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectContactInfoTool,
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

    tool = module.get<CollectContactInfoTool>(CollectContactInfoTool);
  });

  describe("execute", () => {
    describe("1 — save firstName only (no email) — trio incomplete, no customer side-effect", () => {
      it("returns { saved: true } without customerFound; CustomerService NOT called", async () => {
        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({ Item: makeContactInfoItem({ first_name: "Jane" }) });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ firstName: "Jane" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBeUndefined();
        expect(mockCustomerService.lookupOrCreateCustomer).not.toHaveBeenCalled();
      });
    });

    describe("2 — save email only; first/last NOT in USER_CONTACT_INFO — trio incomplete", () => {
      it("returns { saved: true } without customerFound; CustomerService NOT called", async () => {
        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({ Item: makeContactInfoItem({ email: "j@x.com" }) });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ email: "j@x.com" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBeUndefined();
        expect(mockCustomerService.lookupOrCreateCustomer).not.toHaveBeenCalled();
      });
    });

    describe("3 — save firstName + lastName together, no email yet — trio incomplete", () => {
      it("returns { saved: true } without customerFound; CustomerService NOT called", async () => {
        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({ Item: makeContactInfoItem({ first_name: "Jane", last_name: "Doe" }) });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ firstName: "Jane", lastName: "Doe" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBeUndefined();
        expect(mockCustomerService.lookupOrCreateCustomer).not.toHaveBeenCalled();
      });
    });

    describe("4 — trio completes on email-save; prior first+last in USER_CONTACT_INFO — customer HIT", () => {
      it("returns { saved: true, customerFound: true }; CustomerService called with correct args; METADATA UpdateCommand fires with if_not_exists and C# prefixed customer_id", async () => {
        mockCustomerService.lookupOrCreateCustomer.mockResolvedValue({
          isError: false,
          customerUlid: CUSTOMER_ULID,
          created: false,
        });

        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ email: "j@x.com" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBe(true);

        expect(mockCustomerService.lookupOrCreateCustomer).toHaveBeenCalledWith(
          expect.objectContaining({
            accountUlid: ACCOUNT_ULID,
            email: "j@x.com",
            firstName: "Jane",
            lastName: "Doe",
          }),
        );

        // METADATA UpdateCommand fires with if_not_exists and C#-prefixed customer_id
        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        const metadataUpdate = updateCalls.find(
          (call) => (call.args[0].input.Key as Record<string, string>).SK === "METADATA",
        );
        expect(metadataUpdate).toBeDefined();
        const expr = metadataUpdate!.args[0].input.UpdateExpression as string;
        expect(expr).toContain("if_not_exists(#customer_id");
        expect(metadataUpdate!.args[0].input.ExpressionAttributeValues?.[":customer_id"]).toBe(
          `C#${CUSTOMER_ULID}`,
        );
      });
    });

    describe("5 — trio completes on email-save — customer MISS (new record created)", () => {
      it("returns { saved: true, customerFound: false }", async () => {
        mockCustomerService.lookupOrCreateCustomer.mockResolvedValue({
          isError: false,
          customerUlid: CUSTOMER_ULID,
          created: true,
        });

        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ email: "j@x.com" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBe(false);
      });
    });

    describe("6 — trio completes on firstName-save; prior email + lastName in USER_CONTACT_INFO — customer HIT", () => {
      it("returns { saved: true, customerFound: true }; CustomerService called", async () => {
        mockCustomerService.lookupOrCreateCustomer.mockResolvedValue({
          isError: false,
          customerUlid: CUSTOMER_ULID,
          created: false,
        });

        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ firstName: "Jane" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBe(true);
        expect(mockCustomerService.lookupOrCreateCustomer).toHaveBeenCalled();
      });
    });

    describe("7 — trio completes on lastName-save; prior email + firstName in USER_CONTACT_INFO — customer MISS (new)", () => {
      it("returns { saved: true, customerFound: false }; CustomerService called", async () => {
        mockCustomerService.lookupOrCreateCustomer.mockResolvedValue({
          isError: false,
          customerUlid: CUSTOMER_ULID,
          created: true,
        });

        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ lastName: "Doe" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBe(false);
        expect(mockCustomerService.lookupOrCreateCustomer).toHaveBeenCalled();
      });
    });

    describe("8 — all three saved in one call (trio completes immediately)", () => {
      it("CustomerService called with correct non-null firstName and lastName; returns { saved: true, customerFound: ... }", async () => {
        mockCustomerService.lookupOrCreateCustomer.mockResolvedValue({
          isError: false,
          customerUlid: CUSTOMER_ULID,
          created: false,
        });

        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute(
          { email: "j@x.com", firstName: "Jane", lastName: "Doe" },
          TEST_CONTEXT,
        );

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(typeof parsed.customerFound).toBe("boolean");

        expect(mockCustomerService.lookupOrCreateCustomer).toHaveBeenCalledWith(
          expect.objectContaining({
            email: "j@x.com",
            firstName: "Jane",
            lastName: "Doe",
          }),
        );
      });
    });

    describe("9 — save AGAIN after trio complete and customer_id already set — gate short-circuits", () => {
      it("returns { saved: true } without customerFound; CustomerService NOT called; METADATA UpdateCommand NOT called", async () => {
        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({
            Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
          });

        const result = await tool.execute({ email: "j@x.com" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBeUndefined();

        expect(mockCustomerService.lookupOrCreateCustomer).not.toHaveBeenCalled();

        // Only 1 UpdateCommand (the USER_CONTACT_INFO write) — METADATA UpdateCommand NOT called
        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        const metadataUpdate = updateCalls.find(
          (call) => (call.args[0].input.Key as Record<string, string>).SK === "METADATA",
        );
        expect(metadataUpdate).toBeUndefined();
      });
    });

    describe("10 — save phone only — trio not complete (no email/firstName/lastName)", () => {
      it("returns { saved: true } without customerFound; CustomerService NOT called", async () => {
        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({ Item: makeContactInfoItem({ phone: "555-0100" }) });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ phone: "555-0100" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBeUndefined();
        expect(mockCustomerService.lookupOrCreateCustomer).not.toHaveBeenCalled();
      });
    });

    describe("11 — CustomerService.lookupOrCreateCustomer returns error — best-effort", () => {
      it("returns { saved: true } without customerFound; METADATA UpdateCommand NOT called; no isError", async () => {
        mockCustomerService.lookupOrCreateCustomer.mockResolvedValue({
          isError: true,
          error: "An unexpected error occurred. Please try again.",
        });

        ddbMock.on(UpdateCommand).resolves({});
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ email: "j@x.com" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBeUndefined();

        // METADATA UpdateCommand NOT called
        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        const metadataUpdate = updateCalls.find(
          (call) => (call.args[0].input.Key as Record<string, string>).SK === "METADATA",
        );
        expect(metadataUpdate).toBeUndefined();
      });
    });

    describe("12 — METADATA UpdateCommand fails — best-effort degradation", () => {
      it("returns { saved: true } without customerFound; no isError", async () => {
        mockCustomerService.lookupOrCreateCustomer.mockResolvedValue({
          isError: false,
          customerUlid: CUSTOMER_ULID,
          created: false,
        });

        // First UpdateCommand (USER_CONTACT_INFO write) succeeds; METADATA UpdateCommand rejects
        ddbMock
          .on(UpdateCommand)
          .resolvesOnce({})
          .rejectsOnce(Object.assign(new Error("DDB error"), { name: "InternalServerError" }));

        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
          .resolves({
            Item: makeContactInfoItem({ email: "j@x.com", first_name: "Jane", last_name: "Doe" }),
          });
        ddbMock
          .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
          .resolves({ Item: makeMetadataItem() });

        const result = await tool.execute({ email: "j@x.com" }, TEST_CONTEXT);

        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed.saved).toBe(true);
        expect(parsed.customerFound).toBeUndefined();
      });
    });

    describe("13 — Invalid input — schema rejects empty object (refine requires at least one field)", () => {
      it("returns isError: true and result containing 'Invalid input' when no fields are provided", async () => {
        const result = await tool.execute({}, TEST_CONTEXT);

        expect(result.isError).toBe(true);
        expect(result.result).toContain("Invalid input");
      });
    });

    describe("14 — DDB failure on UpdateCommand (USER_CONTACT_INFO write) — returns isError", () => {
      it("returns isError when the USER_CONTACT_INFO UpdateCommand fails", async () => {
        ddbMock
          .on(UpdateCommand)
          .rejects(Object.assign(new Error("DDB error"), { name: "InternalServerError" }));

        const result = await tool.execute({ firstName: "Jane" }, TEST_CONTEXT);

        expect(result.isError).toBe(true);
        expect(result.result).toContain("Failed to save contact info");
        expect(mockCustomerService.lookupOrCreateCustomer).not.toHaveBeenCalled();
      });
    });
  });
});
