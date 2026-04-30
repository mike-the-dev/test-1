import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { PreviewCartTool } from "./preview-cart.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { SlackAlertService } from "../services/slack-alert.service";

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
const LINE_ULID_1 = "01LINEID10000000000000000";
const SERVICE_ULID = "01SERVICEID000000000000000";
const SERVICE_SK = `S#${SERVICE_ULID}`;
const VARIANT_ID = "01VARIANTID000000000000000";
const OPTION_ID = "01OPTIONID0000000000000000";

const CHECKOUT_OVERRIDE = "http://localhost:3000";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const mockSlackAlertService = {
  notifyConversationStarted: jest.fn().mockResolvedValue(undefined),
  notifyCartCreated: jest.fn().mockResolvedValue(undefined),
  notifyCheckoutLinkGenerated: jest.fn().mockResolvedValue(undefined),
};

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

function makeMetadataItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "METADATA",
    source: "web_chat",
    _createdAt_: "2024-01-01T00:00:00.000Z",
    _lastUpdated_: "2024-01-01T00:00:00.000Z",
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
      PreviewCartTool,
      {
        provide: DYNAMO_DB_CLIENT,
        useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
      },
      {
        provide: DatabaseConfigService,
        useValue: mockDatabaseConfig,
      },
      {
        provide: SlackAlertService,
        useValue: mockSlackAlertService,
      },
    ],
  }).compile();
}

describe("PreviewCartTool", () => {
  let tool: PreviewCartTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const mockedUlid = jest.mocked(ulid);

  const context = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

  beforeEach(async () => {
    jest.clearAllMocks();
    ddbMock.reset();
    mockedUlid.mockReset();

    // Default ulid sequence: guest, cart, then one per line
    mockedUlid
      .mockReturnValueOnce(GUEST_ULID)
      .mockReturnValueOnce(CART_ULID)
      .mockReturnValue(LINE_ULID_1);

    const module = await buildModule();
    tool = module.get<PreviewCartTool>(PreviewCartTool);
  });

  describe("1. First call happy path — no variants, customer_id from METADATA, full payload shape", () => {
    it("returns structured CartPreviewPayload with correct shape", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });

      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });

      ddbMock.on(UpdateCommand).resolves({});

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBeUndefined();

      const payload = JSON.parse(result.result) as {
        cart_id: string;
        item_count: number;
        currency: string;
        cart_total: number;
        lines: Array<{
          line_id: string;
          service_id: string;
          name: string;
          category: string;
          image_url: string;
          variant: string | null;
          variant_label: string | null;
          quantity: number;
          price: number;
          total: number;
        }>;
      };

      expect(payload.cart_id).toBe(CART_ULID);
      expect(payload.item_count).toBe(1);
      expect(payload.currency).toBe("usd");
      expect(payload.cart_total).toBe(10000);
      expect(payload.lines).toHaveLength(1);

      const line = payload.lines[0];
      expect(typeof line.line_id).toBe("string");
      expect(line.service_id).toBe(SERVICE_SK);
      expect(line.name).toBe("Test Service");
      expect(line.category).toBe("default");
      expect(line.image_url).toBe("https://example.com/image.jpg");
      expect(line.variant).toBeNull();
      expect(line.variant_label).toBeNull();
      expect(line.quantity).toBe(1);
      expect(line.price).toBe(10000);
      expect(line.total).toBe(10000);
    });
  });

  describe("2. Second call — METADATA has all 4 IDs, items replaced, IDs reused", () => {
    it("reuses cart/guest IDs from METADATA and does NOT mint new ULIDs for them", async () => {
      const EXISTING_CART_ULID = "01EXISTINGCART000000000000";
      const EXISTING_GUEST_ULID = "01EXISTINGGUEST00000000000";

      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({
          cart_id: EXISTING_CART_ULID,
          guest_id: EXISTING_GUEST_ULID,
          customer_id: `C#${CUSTOMER_ULID}`,
          customer_email: "test@example.com",
        }),
      });

      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 2 }] },
        context,
      );

      expect(result.isError).toBeUndefined();

      // Cart UpdateCommand should use SK with existing IDs
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const cartUpdateCall = updateCalls.find((call) =>
        (call.args[0].input.Key as Record<string, string>).SK?.startsWith("G#"),
      );
      expect(cartUpdateCall).toBeDefined();
      expect((cartUpdateCall!.args[0].input.Key as Record<string, string>).SK).toBe(
        `G#${EXISTING_GUEST_ULID}C#${EXISTING_CART_ULID}`,
      );

      const payload = JSON.parse(result.result) as { cart_id: string };
      expect(payload.cart_id).toBe(EXISTING_CART_ULID);
    });
  });

  describe("3. Service with variants — variant and variant_label set correctly", () => {
    it("resolves variant and option correctly in preview lines", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceWithVariants()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, variant_id: VARIANT_ID, option_id: OPTION_ID, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBeUndefined();

      const payload = JSON.parse(result.result) as {
        lines: Array<{ variant: string | null; variant_label: string | null; price: number }>;
      };

      expect(payload.lines[0].variant).toBe(`${VARIANT_ID}:${OPTION_ID}`);
      expect(payload.lines[0].variant_label).toBe("Large");
      expect(payload.lines[0].price).toBe(15000);
    });
  });

  describe("4. Multiple items — item_count and cart_total aggregates", () => {
    it("sums quantity for item_count and sums totals for cart_total", async () => {
      const service2Sk = "S#01SERVICE2000000000000000";
      const service2 = makeServiceItem({ SK: service2Sk, price: 20000, name: "Service 2" });

      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem(), service2] },
        UnprocessedKeys: {},
      });
      ddbMock.on(UpdateCommand).resolves({});

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

      const payload = JSON.parse(result.result) as {
        item_count: number;
        cart_total: number;
        lines: unknown[];
      };

      // item_count = sum of quantities = 2 + 1 = 3
      expect(payload.item_count).toBe(3);
      // cart_total = (10000 * 2) + (20000 * 1) = 40000
      expect(payload.cart_total).toBe(40000);
      expect(payload.lines).toHaveLength(2);
    });
  });

  describe("5. Unknown service rejected", () => {
    it("returns isError when service is absent from batch response", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("could not be found in the catalog");
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("6. Service has variants but no selection provided — error", () => {
    it("returns isError requiring variant choice", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceWithVariants()] },
        UnprocessedKeys: {},
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("requires a variant choice");
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("7. Missing accountUlid — structured error, zero DynamoDB calls", () => {
    it("returns isError with no DynamoDB calls", async () => {
      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        { sessionUlid: SESSION_ULID },
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing account context");
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("8. Missing USER_CONTACT_INFO record — structured error", () => {
    it("returns isError when contact info item is missing", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: undefined,
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing visitor contact info");
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("9. DynamoDB error on cart UpdateCommand — structured error", () => {
    it("returns isError without rethrowing", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });

      // First UpdateCommand (cart write) throws; second (METADATA write) would succeed
      ddbMock
        .on(UpdateCommand)
        .rejectsOnce(Object.assign(new Error("cart write failed"), { name: "InternalServerError" }))
        .resolves({});

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem creating the cart");
    });
  });

  describe("10. DynamoDB error on METADATA UpdateCommand — structured error", () => {
    it("returns isError without rethrowing", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });

      // First UpdateCommand (cart) succeeds; second (METADATA) throws
      ddbMock
        .on(UpdateCommand)
        .resolvesOnce({})
        .rejectsOnce(Object.assign(new Error("metadata write failed"), { name: "InternalServerError" }));

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem creating the cart");
    });
  });

  describe("11. Preview payload shape — every field present and correct type", () => {
    it("all CartPreviewPayload fields are present with correct types", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBeUndefined();

      const payload = JSON.parse(result.result) as Record<string, unknown>;

      // Top-level fields
      expect(typeof payload.cart_id).toBe("string");
      expect(typeof payload.item_count).toBe("number");
      expect(payload.currency).toBe("usd");
      expect(typeof payload.cart_total).toBe("number");
      expect(Array.isArray(payload.lines)).toBe(true);

      // Line fields
      const lines = payload.lines as Record<string, unknown>[];
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(typeof line.line_id).toBe("string");
      expect(typeof line.service_id).toBe("string");
      expect(typeof line.name).toBe("string");
      expect(typeof line.category).toBe("string");
      expect(typeof line.image_url).toBe("string");
      expect(line.variant === null || typeof line.variant === "string").toBe(true);
      expect(line.variant_label === null || typeof line.variant_label === "string").toBe(true);
      expect(typeof line.quantity).toBe("number");
      expect(typeof line.price).toBe("number");
      expect(typeof line.total).toBe("number");
    });

    it("METADATA UpdateCommand uses if_not_exists on cart_id, guest_id, and customer_email (NOT customer_id)", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(UpdateCommand).resolves({});

      await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 1 }] },
        context,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metadataUpdate = updateCalls.find((call) =>
        (call.args[0].input.Key as Record<string, string>).SK === "METADATA",
      );

      expect(metadataUpdate).toBeDefined();
      const expr = metadataUpdate!.args[0].input.UpdateExpression as string;

      expect(expr).toContain("if_not_exists(#cart_id");
      expect(expr).toContain("if_not_exists(#guest_id");
      expect(expr).toContain("if_not_exists(#customer_email");
      // customer_id is no longer written by preview_cart
      expect(expr).not.toContain("if_not_exists(#customer_id");
    });
  });

  describe("12. Slack alert — notifyCartCreated", () => {
    function setupHappyPath(): void {
      mockedUlid
        .mockReturnValueOnce(GUEST_ULID)
        .mockReturnValueOnce(CART_ULID)
        .mockReturnValue(LINE_ULID_1);

      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({ Item: makeContactInfoItem() });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(UpdateCommand).resolves({});
    }

    it("calls notifyCartCreated with accountId, sessionUlid, itemCount, cartTotalCents, guestCartId, and items when itemCount > 0", async () => {
      setupHappyPath();

      await tool.execute({ items: [{ service_id: SERVICE_SK, quantity: 2 }] }, context);

      expect(mockSlackAlertService.notifyCartCreated).toHaveBeenCalledTimes(1);
      const [callArgs] = mockSlackAlertService.notifyCartCreated.mock.calls[0];
      expect(callArgs.accountId).toBe(ACCOUNT_ULID);
      expect(callArgs.sessionUlid).toBe(SESSION_ULID);
      expect(callArgs.itemCount).toBe(2);
      expect(typeof callArgs.cartTotalCents).toBe("number");
      expect(callArgs.guestCartId).toBe(CART_ULID);
      expect(callArgs.items).toHaveLength(1);
      expect(callArgs.items[0]).toEqual(
        expect.objectContaining({ name: "Test Service", quantity: 2, subtotalCents: 20000 }),
      );
    });

    it("does NOT call notifyCartCreated when the tool returns an error", async () => {
      // Missing accountUlid triggers early return before any Slack call
      await tool.execute({ items: [{ service_id: SERVICE_SK, quantity: 1 }] }, { sessionUlid: SESSION_ULID, accountUlid: undefined });

      expect(mockSlackAlertService.notifyCartCreated).not.toHaveBeenCalled();
    });

    it("returns the cart payload regardless of slackAlertService behavior", async () => {
      setupHappyPath();
      mockSlackAlertService.notifyCartCreated.mockRejectedValue(new Error("Slack down"));

      const result = await tool.execute({ items: [{ service_id: SERVICE_SK, quantity: 1 }] }, context);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.result)).toHaveProperty("cart_id");
    });
  });

  describe("13. Missing customer_id in METADATA — hard requirement error", () => {
    it("returns isError with locked message; no UpdateCommand called; logger.error called with event=preview_cart_no_customer_id", async () => {
      const loggerErrorSpy = jest.spyOn(tool["logger"], "error");

      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      // makeMetadataItem() default has no customer_id
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem(),
      });

      const result = await tool.execute(
        { items: [{ service_id: SERVICE_SK, quantity: 1 }] },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toBe(
        "This action requires a customer profile. Please collect the visitor's email first.",
      );
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("event=preview_cart_no_customer_id"),
      );

      loggerErrorSpy.mockRestore();
    });
  });

  describe("14. cart record customer_id field uses C# prefix", () => {
    it("writes C#<customerUlid> to cart record customer_id — strips prefix from METADATA value then re-prefixes", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "USER_CONTACT_INFO" } }).resolves({
        Item: makeContactInfoItem(),
      });
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: makeMetadataItem({ customer_id: `C#${CUSTOMER_ULID}` }),
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [makeServiceItem()] },
        UnprocessedKeys: {},
      });
      ddbMock.on(UpdateCommand).resolves({});

      await tool.execute({ items: [{ service_id: SERVICE_SK, quantity: 1 }] }, context);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const cartUpdate = updateCalls.find((call) =>
        (call.args[0].input.Key as Record<string, string>).SK?.startsWith("G#"),
      );
      expect(cartUpdate).toBeDefined();
      expect(cartUpdate!.args[0].input.ExpressionAttributeValues?.[":customer_id"]).toBe(
        `C#${CUSTOMER_ULID}`,
      );
    });
  });
});
