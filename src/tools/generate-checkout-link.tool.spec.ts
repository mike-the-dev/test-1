import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { GenerateCheckoutLinkTool } from "./generate-checkout-link.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { SlackAlertService } from "../services/slack-alert.service";

const TABLE_NAME = "test-conversations-table";
const ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const SESSION_ULID = "01TESTSESSION0000000000000";
const CART_ULID = "01CARTULID0000000000000000";
const GUEST_ULID = "01GUESTULID000000000000000";
const CUSTOMER_ULID = "01CUSTOMERULID0000000000000";
const CUSTOMER_EMAIL = "test@example.com";

const CHECKOUT_OVERRIDE = "http://localhost:3000";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

const mockSlackAlertService = {
  notifyConversationStarted: jest.fn().mockResolvedValue(undefined),
  notifyCartCreated: jest.fn().mockResolvedValue(undefined),
  notifyCheckoutLinkGenerated: jest.fn().mockResolvedValue(undefined),
};

function makeMetadataItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `CHAT_SESSION#${SESSION_ULID}`,
    SK: "METADATA",
    source: "web_chat",
    cart_id: CART_ULID,
    guest_id: GUEST_ULID,
    customer_id: `C#${CUSTOMER_ULID}`,
    customer_email: CUSTOMER_EMAIL,
    _createdAt_: "2024-01-01T00:00:00.000Z",
    _lastUpdated_: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCartItem(): Record<string, unknown> {
  return {
    PK: `A#${ACCOUNT_ULID}`,
    SK: `G#${GUEST_ULID}C#${CART_ULID}`,
    cart_items: [
      {
        name: "Dog Walking",
        quantity: 2,
        total: 8000,
        price: 4000,
        category: "walking",
        image_url: "",
        service_id: "S#01",
        variant: null,
        variant_label: null,
      },
    ],
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
      GenerateCheckoutLinkTool,
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
      {
        provide: SlackAlertService,
        useValue: mockSlackAlertService,
      },
    ],
  }).compile();
}

describe("GenerateCheckoutLinkTool", () => {
  let tool: GenerateCheckoutLinkTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  const context = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

  beforeEach(async () => {
    jest.clearAllMocks();
    ddbMock.reset();

    const module = await buildModule();
    tool = module.get<GenerateCheckoutLinkTool>(GenerateCheckoutLinkTool);
  });

  describe("1. Happy path — METADATA has all 4 IDs, override set, full URL with all 5 query params", () => {
    it("returns checkout URL with all required query params", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });

      const result = await tool.execute({}, context);

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.result);
      expect(parsed.cart_id).toBe(CART_ULID);

      const url = new URL(parsed.checkout_url);
      expect(url.searchParams.get("email")).toBe(CUSTOMER_EMAIL);
      // Strip-prefix: METADATA stores C#<ulid> but URL must contain bare ULID
      expect(url.searchParams.get("customerId")).toBe(CUSTOMER_ULID);
      expect(url.searchParams.get("guestId")).toBe(GUEST_ULID);
      expect(url.searchParams.get("cartId")).toBe(CART_ULID);
      expect(url.searchParams.get("aiSessionId")).toBe(SESSION_ULID);
      expect(parsed.checkout_url).toContain(CHECKOUT_OVERRIDE);
      // Negative assertion: C# prefix must NOT appear in the URL
      expect(parsed.checkout_url).not.toContain("C#");
      expect(parsed.checkout_url).not.toContain("C%23");

      // Tool makes exactly 2 GetCommand calls: METADATA + cart record
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
    });
  });

  describe("2. Attribution regression guard — aiSessionId comes from context, not METADATA", () => {
    it("aiSessionId in URL is sourced from context.sessionUlid, not METADATA (proven by two calls with different session contexts)", async () => {
      const SESSION_ULID_A = "01SESSIONA0000000000000000";
      const SESSION_ULID_B = "01SESSIONB0000000000000000";

      // METADATA is identical for both calls — same cart/guest/customer IDs.
      // Only context.sessionUlid differs between the two executions.
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID_A}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID_B}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      // Cart record mock — Step 5b issues a GetCommand for the cart; without this
      // mock the command would throw and Step 5b's catch would silently absorb it.
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });

      const resultA = await tool.execute({}, { sessionUlid: SESSION_ULID_A, accountUlid: ACCOUNT_ULID });
      const resultB = await tool.execute({}, { sessionUlid: SESSION_ULID_B, accountUlid: ACCOUNT_ULID });

      expect(resultA.isError).toBeUndefined();
      expect(resultB.isError).toBeUndefined();

      const urlA = new URL(JSON.parse(resultA.result).checkout_url);
      const urlB = new URL(JSON.parse(resultB.result).checkout_url);

      // Each URL's aiSessionId must track its own context.sessionUlid.
      expect(urlA.searchParams.get("aiSessionId")).toBe(SESSION_ULID_A);
      expect(urlB.searchParams.get("aiSessionId")).toBe(SESSION_ULID_B);
    });
  });

  describe("3. URL deterministic — two calls produce identical URL", () => {
    it("returns the same checkout URL on repeated calls", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });

      const result1 = await tool.execute({}, context);
      const result2 = await tool.execute({}, context);

      const parsed1 = JSON.parse(result1.result);
      const parsed2 = JSON.parse(result2.result);

      expect(parsed1.checkout_url).toBe(parsed2.checkout_url);
    });
  });

  describe("4. METADATA item missing entirely — isError, message references preview_cart", () => {
    it("returns isError when METADATA item is undefined", async () => {
      ddbMock.on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } }).resolves({
        Item: undefined,
      });

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("preview_cart");
    });
  });

  describe("5. METADATA exists, cart_id missing — isError", () => {
    it("returns isError when cart_id is absent from METADATA", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: makeMetadataItem({ cart_id: undefined }),
      });

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("preview_cart");
    });
  });

  describe("6. METADATA exists, guest_id missing — isError", () => {
    it("returns isError when guest_id is absent from METADATA", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: makeMetadataItem({ guest_id: undefined }),
      });

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("preview_cart");
    });
  });

  describe("7. METADATA exists, customer_id missing — isError", () => {
    it("returns isError when customer_id is absent from METADATA", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: makeMetadataItem({ customer_id: undefined }),
      });

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("preview_cart");
    });
  });

  describe("8. METADATA exists, customer_email missing — isError", () => {
    it("returns isError when customer_email is absent from METADATA", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: makeMetadataItem({ customer_email: undefined }),
      });

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("preview_cart");
    });
  });

  describe("9. Checkout base via account domain (no override) — URL prefix uses account domain", () => {
    it("constructs https:// URL from account record GSI1-PK when override is absent", async () => {
      const mockConfigNoOverride = {
        get: jest.fn((key: string) => {
          if (key === "webChat.checkoutBaseUrlOverride") return undefined;
          if (key === "webChat.domainGsiName") return "GSI1";
          return undefined;
        }),
      };

      const module = await Test.createTestingModule({
        providers: [
          GenerateCheckoutLinkTool,
          { provide: DYNAMO_DB_CLIENT, useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })) },
          { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
          { provide: ConfigService, useValue: mockConfigNoOverride },
          { provide: SlackAlertService, useValue: mockSlackAlertService },
        ],
      }).compile();

      const toolNoOverride = module.get<GenerateCheckoutLinkTool>(GenerateCheckoutLinkTool);

      // METADATA get
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });

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

      const result = await toolNoOverride.execute({}, context);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.checkout_url).toContain("https://shop.example.instapaytient.com/checkout");
    });
  });

  describe("10. Account record malformed (no override) — isError", () => {
    it("returns isError when account record has no DOMAIN# GSI1-PK", async () => {
      const mockConfigNoOverride = {
        get: jest.fn((key: string) => {
          if (key === "webChat.checkoutBaseUrlOverride") return undefined;
          if (key === "webChat.domainGsiName") return "GSI1";
          return undefined;
        }),
      };

      const module = await Test.createTestingModule({
        providers: [
          GenerateCheckoutLinkTool,
          { provide: DYNAMO_DB_CLIENT, useValue: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })) },
          { provide: DatabaseConfigService, useValue: mockDatabaseConfig },
          { provide: ConfigService, useValue: mockConfigNoOverride },
          { provide: SlackAlertService, useValue: mockSlackAlertService },
        ],
      }).compile();

      const toolNoOverride = module.get<GenerateCheckoutLinkTool>(GenerateCheckoutLinkTool);

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });

      // Account record missing GSI1-PK
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `A#${ACCOUNT_ULID}` } })
        .resolves({
          Item: {
            PK: `A#${ACCOUNT_ULID}`,
            SK: `A#${ACCOUNT_ULID}`,
            entity: "ACCOUNT",
          },
        });

      const result = await toolNoOverride.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("problem generating the checkout link");
    });
  });

  describe("11. Missing accountUlid — isError, zero DynamoDB calls", () => {
    it("returns isError with no DynamoDB calls", async () => {
      const result = await tool.execute({}, { sessionUlid: SESSION_ULID });

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing account context");
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });
  });

  describe("12. Email URL-encoding — special characters encoded correctly", () => {
    it("encodes + and @ in email query param", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem({ customer_email: "user+tag@example.com" }) });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });

      const result = await tool.execute({}, context);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.checkout_url).toContain("email=user%2Btag%40example.com");
    });
  });

  describe("13. Slack alert — notifyCheckoutLinkGenerated", () => {
    it("calls notifyCheckoutLinkGenerated with accountId, sessionUlid, and checkoutUrl on success", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });

      await tool.execute({}, context);

      expect(mockSlackAlertService.notifyCheckoutLinkGenerated).toHaveBeenCalledTimes(1);
      const [callArgs] = mockSlackAlertService.notifyCheckoutLinkGenerated.mock.calls[0];
      expect(callArgs.accountId).toBe(ACCOUNT_ULID);
      expect(callArgs.sessionUlid).toBe(SESSION_ULID);
      expect(typeof callArgs.checkoutUrl).toBe("string");
      expect(callArgs.checkoutUrl).toContain("checkout");
    });

    it("calls notifyCheckoutLinkGenerated with guestCartId and items when cart record is present", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });

      await tool.execute({}, context);

      expect(mockSlackAlertService.notifyCheckoutLinkGenerated).toHaveBeenCalledTimes(1);
      const [callArgs] = mockSlackAlertService.notifyCheckoutLinkGenerated.mock.calls[0];
      expect(callArgs.guestCartId).toBe(CART_ULID);
      expect(callArgs.items).toHaveLength(1);
      expect(callArgs.items[0]).toEqual(
        expect.objectContaining({ name: "Dog Walking", quantity: 2, subtotalCents: 8000 }),
      );
      expect(callArgs.cartTotalCents).toBe(8000);
    });

    it("calls notifyCheckoutLinkGenerated with empty items when cart record GetCommand throws (non-fatal)", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .rejects(new Error("DDB error"));

      const result = await tool.execute({}, context);

      // Tool still returns a valid checkout URL
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(typeof parsed.checkout_url).toBe("string");
      expect(parsed.checkout_url).toContain("checkout");

      // Alert still fires with degraded payload (empty items, $0.00 total)
      expect(mockSlackAlertService.notifyCheckoutLinkGenerated).toHaveBeenCalledTimes(1);
      const [callArgs] = mockSlackAlertService.notifyCheckoutLinkGenerated.mock.calls[0];
      expect(callArgs.items).toEqual([]);
      expect(callArgs.cartTotalCents).toBe(0);
      expect(callArgs.guestCartId).toBe(CART_ULID);
    });

    it("does NOT call notifyCheckoutLinkGenerated when the tool returns an error (missing METADATA)", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      await tool.execute({}, context);

      expect(mockSlackAlertService.notifyCheckoutLinkGenerated).not.toHaveBeenCalled();
    });

    it("returns the checkout result regardless of slackAlertService behavior", async () => {
      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem() });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });
      mockSlackAlertService.notifyCheckoutLinkGenerated.mockRejectedValue(new Error("Slack down"));

      const result = await tool.execute({}, context);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(typeof parsed.checkout_url).toBe("string");
    });
  });

  describe("14. Strip-prefix — C# prefix on customer_id is removed from checkout URL", () => {
    it("with metadata.customer_id = 'C#<ulid>', URL contains customerId=<ulid> (bare) and NOT C# or C%23", async () => {
      const PREFIXED_CUSTOMER = `C#${CUSTOMER_ULID}`;

      ddbMock
        .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
        .resolves({ Item: makeMetadataItem({ customer_id: PREFIXED_CUSTOMER }) });
      ddbMock
        .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
        .resolves({ Item: makeCartItem() });

      const result = await tool.execute({}, context);

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.result);
      const url = new URL(parsed.checkout_url);

      // Must contain bare ULID (no prefix)
      expect(url.searchParams.get("customerId")).toBe(CUSTOMER_ULID);

      // Must NOT contain the C# prefix in any form
      expect(parsed.checkout_url).not.toContain("C#");
      expect(parsed.checkout_url).not.toContain("C%23");
    });
  });
});
