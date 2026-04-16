import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { CreateGuestCartTool } from "./create-guest-cart.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";

jest.mock("ulid", () => ({
  ulid: jest.fn(),
}));

import { ulid } from "ulid";

const TABLE_NAME = "test-conversations-table";
const ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const SESSION_ULID = "01TESTSESSION0000000000000";
const CUSTOMER_ULID = "01CUSTOMERULID0000000000000";
const GUEST_ULID = "01GUESTULID000000000000000";
const CART_ULID = "01CARTULID0000000000000000";
const SERVICE_ULID = "01SERVICEID000000000000000";
const SERVICE_SK = `S#${SERVICE_ULID}`;
const VARIANT_ID = "01VARIANTID000000000000000";
const OPTION_ID = "01OPTIONID0000000000000000";

const CHECKOUT_OVERRIDE = "http://localhost:3000";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

function makeContactInfoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "USER_CONTACT_INFO",
    email: "test@example.com",
    first_name: "Jane",
    last_name: "Doe",
    phone: "555-0100",
    ...overrides,
  };
}

function makeServiceItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `A#${ACCOUNT_ULID}`,
    SK: SERVICE_SK,
    entity: "SERVICE",
    name: "Test Service",
    category: "default",
    price: 10000,
    images: ["https://example.com/image.jpg"],
    variants: [],
    ...overrides,
  };
}

function makeServiceWithVariants(): Record<string, unknown> {
  return makeServiceItem({
    variants: [
      {
        id: VARIANT_ID,
        name: "Size",
        options: [
          { id: OPTION_ID, value: "Large", price: 15000, compare_price: 0 },
        ],
      },
    ],
  });
}

function makeCustomerItem(customerUlid: string): Record<string, unknown> {
  return {
    PK: `C#${customerUlid}`,
    SK: `C#${customerUlid}`,
    entity: "CUSTOMER",
    "GSI1-PK": `ACCOUNT#${ACCOUNT_ULID}`,
    "GSI1-SK": "EMAIL#test@example.com",
    email: "test@example.com",
    first_name: "Jane",
    last_name: "Doe",
    phone: "555-0100",
    billing_address: null,
    is_email_subscribed: false,
    abandoned_carts: [],
    total_abandoned_carts: 0,
    total_orders: 0,
    total_spent: 0,
    _createdAt_: "2024-01-01T00:00:00.000Z",
    _lastUpdated_: "2024-01-01T00:00:00.000Z",
  };
}

async function buildModule(checkoutOverride?: string): Promise<TestingModule> {
  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === "webChat.checkoutBaseUrlOverride") return checkoutOverride ?? CHECKOUT_OVERRIDE;
      if (key === "webChat.domainGsiName") return "GSI1";
      return undefined;
    }),
  };

  return Test.createTestingModule({
    providers: [
      CreateGuestCartTool,
      {
        provide: DYNAMO_DB_CLIENT,
        useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
      },
      {
        provide: DatabaseConfigService,
        useValue: mockDatabaseConfig,
      },
      {
        provide: ConfigService,
        useValue: mockConfigService,
      },
    ],
  }).compile();
}

describe("CreateGuestCartTool", () => {
  let tool: CreateGuestCartTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const mockedUlid = jest.mocked(ulid);

  const context = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

  beforeEach(async () => {
    ddbMock.reset();
    mockedUlid.mockReset();

    // Default ulid sequence: customer, guest, cart
    mockedUlid
      .mockReturnValueOnce(CUSTOMER_ULID)
      .mockReturnValueOnce(GUEST_ULID)
      .mockReturnValueOnce(CART_ULID);

    const module = await buildModule();
    tool = module.get<CreateGuestCartTool>(CreateGuestCartTool);
  });

  describe("1. Happy path — single service, no variants; customer created; URL from override", () => {
    it("returns correct shape with checkout URL from override", async () => {
      // Contact info
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });

      // GSI query — no existing customer
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      // Customer put — success
      ddbMock.on(PutCommand).resolves({});

      // Batch get services
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {
          [TABLE_NAME]: [makeServiceItem()],
        },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.result) as {
        checkoutUrl: string;
        customerId: string;
        cartUlid: string;
        guestUlid: string;
        itemCount: number;
      };

      expect(parsed.itemCount).toBe(1);
      expect(parsed.cartUlid).toBe(CART_ULID);
      expect(parsed.guestUlid).toBe(GUEST_ULID);
      expect(parsed.customerId).toBe(CUSTOMER_ULID);
      expect(parsed.checkoutUrl).toContain("/checkout?email=");
      expect(parsed.checkoutUrl).toContain(`customerId=${CUSTOMER_ULID}`);
      expect(parsed.checkoutUrl).toContain(CHECKOUT_OVERRIDE);
    });
  });

  describe("2. Happy path — service with variants; option resolved correctly", () => {
    it("resolves variant and option; variant and variant_label set", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceWithVariants()] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, variant_id: VARIANT_ID, option_id: OPTION_ID, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBeUndefined();

      // Extract the PutCommand call for the cart
      const putCalls = ddbMock.commandCalls(PutCommand);
      // putCalls[0] = customer, putCalls[1] = cart
      const cartPut = putCalls[1];
      const cartItem = cartPut.args[0].input.Item as Record<string, unknown>;
      const cartItems = cartItem.cart_items as Record<string, unknown>[];

      expect(cartItems[0].variant).toBe(`${VARIANT_ID}:${OPTION_ID}`);
      expect(cartItems[0].variant_label).toBe("Large");
      expect(cartItems[0].price).toBe(15000);
    });
  });

  describe("3. Multiple items — per-item attribution; totals correct", () => {
    it("builds correct totals for each item", async () => {
      const service2Sk = "S#01SERVICE2000000000000000";
      const service2 = makeServiceItem({ SK: service2Sk, price: 20000, name: "Service 2" });

      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem(), service2] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        {
          items: [
            { service_id: SERVICE_SK, quantity: 2 },
            { service_id: service2Sk, quantity: 1 },
          ],
        },
        context,
      );

      expect(result.isError).toBeUndefined();

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cartItem = putCalls[1].args[0].input.Item as Record<string, unknown>;
      const items = cartItem.cart_items as Record<string, unknown>[];

      expect(items).toHaveLength(2);
      expect(items[0].total).toBe(20000); // 10000 * 2
      expect(items[1].total).toBe(20000); // 20000 * 1
      expect(items[0].quantity).toBe(2);
      expect(items[1].quantity).toBe(1);
    });
  });

  describe("4. Returning visitor — GSI query returns existing customer", () => {
    it("reuses existing customer ULID and does NOT call PutCommand for customer", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      // Cart put only
      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        context,
      );

      expect(result.isError).toBeUndefined();

      const putCalls = ddbMock.commandCalls(PutCommand);
      // Only one PutCommand — the cart write; no customer put
      expect(putCalls).toHaveLength(1);

      const parsed = JSON.parse(result.result) as { customerId: string };
      expect(parsed.customerId).toBe(CUSTOMER_ULID);
    });
  });

  describe("5. New visitor — GSI returns zero; customer PutCommand issued with condition", () => {
    it("issues customer put with attribute_not_exists(PK) and correct record shape", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });

      await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      const putCalls = ddbMock.commandCalls(PutCommand);
      // First put = customer
      const customerPutInput = putCalls[0].args[0].input;

      expect(customerPutInput.ConditionExpression).toBe("attribute_not_exists(PK)");

      const item = customerPutInput.Item as Record<string, unknown>;
      expect(item.PK).toBe(`C#${CUSTOMER_ULID}`);
      expect(item.SK).toBe(`C#${CUSTOMER_ULID}`);
      expect(item.entity).toBe("CUSTOMER");
      expect(item["GSI1-PK"]).toBe(`ACCOUNT#${ACCOUNT_ULID}`);
      expect(item["GSI1-SK"]).toBe("EMAIL#test@example.com");
      expect(item.email).toBe("test@example.com");
      expect(item.first_name).toBe("Jane");
      expect(item.last_name).toBe("Doe");
      expect(item.is_email_subscribed).toBe(false);
      expect(item.abandoned_carts).toEqual([]);
      expect(item.total_orders).toBe(0);
      expect(item.total_spent).toBe(0);
      expect(item.billing_address).toBeNull();
    });
  });

  describe("6. Race recovery — conditional put throws ConditionalCheckFailedException", () => {
    it("re-queries GSI and uses winner ULID without a second put attempt", async () => {
      const raceCustomerUlid = "01RACEWINNERULID000000000";

      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });

      // First GSI query — no customer (triggers creation attempt)
      // Second GSI query (race recovery) — winner exists
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [makeCustomerItem(raceCustomerUlid)] });

      // Customer put throws conditional check
      const conditionalError = Object.assign(new Error("conditional"), {
        name: "ConditionalCheckFailedException",
      });
      ddbMock.on(PutCommand).rejectsOnce(conditionalError).resolves({});

      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.result) as { customerId: string };
      expect(parsed.customerId).toBe(raceCustomerUlid);

      // Only one PutCommand call (the customer put that failed) — no second put
      const putCalls = ddbMock.commandCalls(PutCommand);
      const customerPutCalls = putCalls.filter(
        (call) => {
          const item = call.args[0].input.Item as Record<string, unknown> | undefined;
          return item?.entity === "CUSTOMER";
        },
      );
      expect(customerPutCalls).toHaveLength(1);
    });
  });

  describe("7. Missing accountUlid in context — structured error, zero DynamoDB calls", () => {
    it("returns isError with no DynamoDB calls", async () => {
      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        { sessionUlid: SESSION_ULID },
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing account context");
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("8. Missing USER_CONTACT_INFO record — structured error, no cart write", () => {
    it("returns isError when contact info item is missing", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing visitor contact info");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("9. Email missing from contact info record — structured error, no cart write", () => {
    it("returns isError when email is missing", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: makeContactInfoItem({ email: "" }),
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing visitor contact info");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("10. Service not found in BatchGetItem response — structured error, no cart write", () => {
    it("returns isError when service is absent from batch response", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] }, // missing
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("could not be found in the catalog");

      // Only the customer (returning visitor) path — no cart put
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("11. Service has variants but item has no variant selection — structured error", () => {
    it("returns isError requiring variant choice", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceWithVariants()] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] }, // no variant_id/option_id
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("requires a variant choice");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("12. variant_id / option_id does not match catalog — structured error", () => {
    it("returns isError when variant_id is not in catalog", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceWithVariants()] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        {
          items: [
            {
              service_id: SERVICE_SK,
              variant_id: "NONEXISTENT_VARIANT",
              option_id: OPTION_ID,
            },
          ],
        },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Variant selection did not match");
    });

    it("returns isError when option_id is not in catalog", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceWithVariants()] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        {
          items: [
            {
              service_id: SERVICE_SK,
              variant_id: VARIANT_ID,
              option_id: "NONEXISTENT_OPTION",
            },
          ],
        },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Variant selection did not match");
    });
  });

  describe("13. Checkout URL: override set — uses override base, strips trailing slash", () => {
    it("uses override base URL with trailing slash stripped", async () => {
      // Rebuild tool with trailing-slash override
      const mockConfigService = {
        get: jest.fn((key: string) => {
          if (key === "webChat.checkoutBaseUrlOverride") return "http://localhost:3000/";
          if (key === "webChat.domainGsiName") return "GSI1";
          return undefined;
        }),
      };

      const module = await Test.createTestingModule({
        providers: [
          CreateGuestCartTool,
          { provide: DYNAMO_DB_CLIENT, useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })) },
          { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const toolWithOverride = module.get<CreateGuestCartTool>(CreateGuestCartTool);

      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(PutCommand).resolves({});

      const result = await toolWithOverride.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result) as { checkoutUrl: string };
      expect(parsed.checkoutUrl).toContain("http://localhost:3000/checkout");
      expect(parsed.checkoutUrl).not.toContain("//checkout");
    });
  });

  describe("14. Checkout URL: override NOT set — uses account domain from GSI1-PK", () => {
    it("constructs https:// URL from account record GSI1-PK", async () => {
      const mockConfigNoOverride = {
        get: jest.fn((key: string) => {
          if (key === "webChat.checkoutBaseUrlOverride") return undefined;
          if (key === "webChat.domainGsiName") return "GSI1";
          return undefined;
        }),
      };

      const module = await Test.createTestingModule({
        providers: [
          CreateGuestCartTool,
          { provide: DYNAMO_DB_CLIENT, useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })) },
          { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
          { provide: ConfigService, useValue: mockConfigNoOverride },
        ],
      }).compile();

      const toolNoOverride = module.get<CreateGuestCartTool>(CreateGuestCartTool);

      // Contact info get
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } })
        .resolves({ Item: makeContactInfoItem() });

      // Account record get
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `A#${ACCOUNT_ULID}` } })
        .resolves({
          Item: {
            PK: `A#${ACCOUNT_ULID}`,
            SK: `A#${ACCOUNT_ULID}`,
            entity: "ACCOUNT",
            "GSI1-PK": "DOMAIN#shop.example.instapaytient.com",
          },
        });

      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(PutCommand).resolves({});

      const result = await toolNoOverride.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result) as { checkoutUrl: string };
      expect(parsed.checkoutUrl).toContain("https://shop.example.instapaytient.com/checkout");
    });
  });

  describe("15. Email + tag URL-encoding", () => {
    it("encodes + and @ characters in email query param", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: makeContactInfoItem({ email: "user+tag@example.com" }),
      });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result) as { checkoutUrl: string };
      expect(parsed.checkoutUrl).toContain("email=user%2Btag%40example.com");
    });
  });

  describe("16. customer_id in cart has C# prefix; URL customerId does NOT", () => {
    it("cart record customer_id starts with C# and URL param is bare ULID", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBeUndefined();

      // Check cart record's customer_id
      const putCalls = ddbMock.commandCalls(PutCommand);
      const cartPut = putCalls[0]; // returning visitor — only one put (cart)
      const cartItem = cartPut.args[0].input.Item as Record<string, unknown>;
      expect(String(cartItem.customer_id)).toMatch(/^C#/);

      // Check URL param
      const parsed = JSON.parse(result.result) as { checkoutUrl: string };
      const url = new URL(parsed.checkoutUrl);
      const customerId = url.searchParams.get("customerId");
      expect(customerId).not.toBeNull();
      expect(customerId).not.toContain("C#");
      expect(customerId).not.toContain("C%23");
      expect(customerId).toBe(CUSTOMER_ULID);
    });
  });

  describe("16b. Checkout URL includes guestId and cartId query params matching the returned values", () => {
    it("URL params match the returned guestUlid and cartUlid exactly", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(PutCommand).resolves({});

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.result) as {
        checkoutUrl: string;
        guestUlid: string;
        cartUlid: string;
      };

      const url = new URL(parsed.checkoutUrl);

      expect(url.searchParams.get("guestId")).toBe(parsed.guestUlid);
      expect(url.searchParams.get("cartId")).toBe(parsed.cartUlid);
      expect(url.searchParams.get("guestId")).not.toBeNull();
      expect(url.searchParams.get("cartId")).not.toBeNull();
    });
  });

  describe("17. Guest cart record does NOT contain an entity attribute", () => {
    it("cart Item written to DynamoDB has no entity property", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });

      await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      const putCalls = ddbMock.commandCalls(PutCommand);
      // putCalls[0] = customer (new visitor), putCalls[1] = cart
      const cartPut = putCalls[1];
      const item = cartPut.args[0].input.Item as Record<string, unknown>;
      expect(item).not.toHaveProperty("entity");
    });
  });

  describe("18. DynamoDB throws on contact-info GetCommand — structured error", () => {
    it("returns isError without rethrowing", async () => {
      const dbError = Object.assign(new Error("connection failed"), {
        name: "ServiceUnavailableException",
      });
      ddbMock.on(GetCommand).rejects(dbError);

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem creating the cart");
    });
  });

  describe("19. DynamoDB throws on GSI QueryCommand — structured error", () => {
    it("returns isError without rethrowing", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).rejects(
        Object.assign(new Error("query failed"), { name: "InternalServerError" }),
      );

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem creating the cart");
    });
  });

  describe("20. DynamoDB throws on customer PutCommand (non-conditional error) — structured error", () => {
    it("returns isError without rethrowing", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).rejects(
        Object.assign(new Error("throughput exceeded"), { name: "ProvisionedThroughputExceededException" }),
      );

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem creating the cart");
    });
  });

  describe("21. DynamoDB throws on service BatchGetCommand — structured error", () => {
    it("returns isError without rethrowing", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).rejects(
        Object.assign(new Error("batch failed"), { name: "InternalServerError" }),
      );

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem creating the cart");
    });
  });

  describe("22. DynamoDB throws on cart PutCommand — structured error", () => {
    it("returns isError without rethrowing", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(PutCommand).rejects(
        Object.assign(new Error("cart write failed"), { name: "InternalServerError" }),
      );

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem creating the cart");
    });
  });

  describe("23. Quantity defaults to 1 when absent from input", () => {
    it("written cart item has quantity 1 when quantity not provided", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });

      // No quantity provided
      await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cartPut = putCalls[0];
      const cartItem = putCalls[0].args[0].input.Item as Record<string, unknown>;

      // Verify we got the cart put (not customer)
      void cartPut;

      const items = cartItem.cart_items as Record<string, unknown>[];
      expect(items[0].quantity).toBe(1);
    });
  });

  describe("24. UnprocessedKeys non-empty on first BatchGetCommand — retry resolves it", () => {
    it("retries unprocessed keys and writes cart successfully", async () => {
      ddbMock.on(GetCommand).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(QueryCommand).resolves({ Items: [makeCustomerItem(CUSTOMER_ULID)] });
      ddbMock.on(PutCommand).resolves({});

      // First batch — returns unprocessed key
      ddbMock
        .on(BatchGetCommand)
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [] },
          UnprocessedKeys: {
            [TABLE_NAME]: {
              Keys: [{ PK: `A#${ACCOUNT_ULID}`, SK: SERVICE_SK }],
            },
          },
        })
        // Retry — resolves the unprocessed item
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [makeServiceItem()] },
          UnprocessedKeys: {},
        });

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK }] }, context);

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.result) as { itemCount: number };
      expect(parsed.itemCount).toBe(1);

      expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(2);
    });
  });
});
