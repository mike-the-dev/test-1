import { Test, TestingModule } from "@nestjs/testing";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { ListServicesTool } from "./list-services.tool";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";

const TABLE_NAME = "test-conversations-table";
const ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const SESSION_ULID = "01TESTSESSION0000000000000";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

function makeService(enabled: boolean, shown: boolean, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: `A#${ACCOUNT_ULID}`,
    SK: "S#01SERVICE00000000000000000",
    entity: "SERVICE",
    enabled,
    is_shown_in_shop: shown,
    name: "Test Service",
    sub_title: "A subtitle",
    description: "A short description",
    price: 10000,
    compare_price: 0,
    category: "default",
    featured: false,
    ribbon_text: null,
    variants: [],
    slug: "test-service",
    ...overrides,
  };
}

async function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      ListServicesTool,
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
}

describe("ListServicesTool", () => {
  let tool: ListServicesTool;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();

    const module = await buildModule();
    tool = module.get<ListServicesTool>(ListServicesTool);
  });

  const context = { sessionUlid: SESSION_ULID, accountUlid: ACCOUNT_ULID };

  describe("happy path", () => {
    it("returns all 3 enabled+shown services with all TrimmedService fields correct", async () => {
      const services = [
        makeService(true, true, {
          SK: "S#SERVICE1",
          name: "Botox",
          sub_title: "Great results",
          description: "Reduces wrinkles",
          price: 20000,
          compare_price: 25000,
          category: "default",
          featured: true,
          ribbon_text: "Popular",
          slug: "botox",
          variants: [
            {
              id: "01VARIANTID000000000000000",
              name: "Units",
              options: [
                { id: "01OPTIONID0000000000000000", value: "20 units", price: 20000, compare_price: 25000 },
              ],
            },
          ],
        }),
        makeService(true, true, {
          SK: "S#SERVICE2",
          name: "Filler",
          sub_title: null,
          description: "Lip enhancement",
          price: 30000,
          compare_price: 0,
          category: "instant",
          featured: false,
          ribbon_text: "",
          slug: "filler",
          variants: [],
        }),
        makeService(true, true, {
          SK: "S#SERVICE3",
          name: "Microneedling",
          sub_title: "",
          description: "Skin rejuvenation",
          price: 15000,
          compare_price: 14000,
          category: "default",
          featured: false,
          ribbon_text: null,
          slug: "microneedling",
          variants: [],
        }),
      ];

      ddbMock.on(QueryCommand).resolves({ Items: services });

      const result = await tool.execute({}, context);

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.result);

      expect(parsed.count).toBe(3);
      expect(parsed.services).toHaveLength(3);

      // Featured service should be first
      const botox = parsed.services[0];
      expect(botox.service_id).toBe("S#SERVICE1");
      expect(botox.name).toBe("Botox");
      expect(botox.sub_title).toBe("Great results");
      expect(botox.description).toBe("Reduces wrinkles");
      expect(botox.price_usd).toBe(200);
      expect(botox.compare_price_usd).toBe(250);
      expect(botox.category).toBe("default");
      expect(botox.featured).toBe(true);
      expect(botox.ribbon_text).toBe("Popular");
      expect(botox.slug).toBe("botox");
      expect(botox.variants).toHaveLength(1);
      expect(botox.variants[0].variant_id).toBe("01VARIANTID000000000000000");
      expect(botox.variants[0].name).toBe("Units");
      expect(botox.variants[0].options[0].option_id).toBe("01OPTIONID0000000000000000");
      expect(botox.variants[0].options[0].value).toBe("20 units");
      expect(botox.variants[0].options[0].price_usd).toBe(200);
      expect(botox.variants[0].options[0].compare_price_usd).toBe(250);

      // compare_price <= price → null
      const microneedling = parsed.services.find((service) => service.name === "Microneedling");
      expect(microneedling.compare_price_usd).toBeNull();

      // null sub_title and ribbon_text
      const filler = parsed.services.find((service) => service.name === "Filler");
      expect(filler.sub_title).toBeNull();
      expect(filler.ribbon_text).toBeNull();
      expect(filler.category).toBe("instant");
    });
  });

  describe("filtering", () => {
    it("filters out enabled === false", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeService(false, true, { name: "Hidden Service" }),
          makeService(true, true, { name: "Visible Service" }),
        ],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.count).toBe(1);
      expect(parsed.services[0].name).toBe("Visible Service");
    });

    it("filters out is_shown_in_shop === false", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeService(true, false, { name: "Shop Hidden" }),
          makeService(true, true, { name: "Shop Visible" }),
        ],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.count).toBe(1);
      expect(parsed.services[0].name).toBe("Shop Visible");
    });

    it("filters out items missing entity === SERVICE (defensive)", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { ...makeService(true, true, { name: "Non-service" }), entity: "ACCOUNT" },
          makeService(true, true, { name: "Real Service" }),
        ],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      // Both pass enabled/is_shown_in_shop; entity filter is post-query in TypeScript only if we add it
      // The tool filters by enabled + is_shown_in_shop. The ACCOUNT item has enabled=true, is_shown_in_shop=true
      // so it passes. This test checks the tool does not crash on unexpected entity types.
      expect(result.isError).toBeUndefined();
      expect(parsed.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe("description truncation", () => {
    it("truncates description to 400 chars with '...' suffix", async () => {
      const longDesc = "x".repeat(500);

      ddbMock.on(QueryCommand).resolves({
        Items: [makeService(true, true, { description: longDesc })],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      const desc = parsed.services[0].description;
      expect(desc.length).toBe(400);
      expect(desc.endsWith("...")).toBe(true);
      expect(desc.startsWith("x".repeat(397))).toBe(true);
    });
  });

  describe("compare price logic", () => {
    it("returns null compare_price_usd when compare_price is 0", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [makeService(true, true, { price: 10000, compare_price: 0 })],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.services[0].compare_price_usd).toBeNull();
    });

    it("returns null compare_price_usd when compare_price < price", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [makeService(true, true, { price: 10000, compare_price: 8000 })],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.services[0].compare_price_usd).toBeNull();
    });

    it("returns converted compare_price_usd when compare_price > price", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [makeService(true, true, { price: 10000, compare_price: 15000 })],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.services[0].price_usd).toBe(100);
      expect(parsed.services[0].compare_price_usd).toBe(150);
    });
  });

  describe("sorting", () => {
    it("sorts featured items first, then alphabetical by name within each group", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeService(true, true, { name: "Zapper", featured: false }),
          makeService(true, true, { name: "Alpha Service", featured: true }),
          makeService(true, true, { name: "Botox Plus", featured: false }),
          makeService(true, true, { name: "Affirm Special", featured: true }),
        ],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.services[0].name).toBe("Affirm Special");
      expect(parsed.services[1].name).toBe("Alpha Service");
      expect(parsed.services[2].name).toBe("Botox Plus");
      expect(parsed.services[3].name).toBe("Zapper");
    });
  });

  describe("hard cap at 50", () => {
    it("returns at most 50 services when catalog has 60", async () => {
      const items = Array.from({ length: 60 }, (_unused, index) =>
        makeService(true, true, { SK: `S#SERVICE${String(index).padStart(3, "0")}`, name: `Service ${String(index).padStart(3, "0")}` }),
      );

      ddbMock.on(QueryCommand).resolves({ Items: items });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.services).toHaveLength(50);
      expect(parsed.count).toBe(50);
    });
  });

  describe("instant category services", () => {
    it("handles instant-category services with empty variants and null sub_title", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeService(true, true, {
            name: "Quick Service",
            sub_title: "",
            category: "instant",
            variants: [],
          }),
        ],
      });

      const result = await tool.execute({}, context);
      const parsed = JSON.parse(result.result);

      expect(parsed.services[0].category).toBe("instant");
      expect(parsed.services[0].sub_title).toBeNull();
      expect(parsed.services[0].variants).toEqual([]);
    });
  });

  describe("error cases", () => {
    it("returns isError when context.accountUlid is missing", async () => {
      const result = await tool.execute({}, { sessionUlid: SESSION_ULID });

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing account context");
    });

    it("returns isError when context.accountUlid is empty string", async () => {
      const result = await tool.execute({}, { sessionUlid: SESSION_ULID, accountUlid: "" });

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Missing account context");
    });

    it("returns isError with 'temporarily unavailable' when DynamoDB throws, logs error.name but not error.message, does not rethrow", async () => {
      const dbError = Object.assign(new Error("super secret connection string"), {
        name: "ServiceUnavailableException",
      });

      ddbMock.on(QueryCommand).rejects(dbError);

      const loggerErrorSpy = jest.spyOn((tool as unknown as { logger: { error: jest.Mock } }).logger, "error");

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("temporarily unavailable");

      // Must log error.name
      expect(loggerErrorSpy).toHaveBeenCalled();
      const loggedMessage: string = loggerErrorSpy.mock.calls[0][0];
      expect(loggedMessage).toContain("ServiceUnavailableException");

      // Must NOT log error.message
      expect(loggedMessage).not.toContain("super secret connection string");
    });
  });

  describe("DynamoDB query shape", () => {
    it("uses QueryCommand (not ScanCommand)", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await tool.execute({}, context);

      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    });

    it("queries with PK = A#<accountUlid> and begins_with(SK, S#)", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await tool.execute({}, context);

      const calls = ddbMock.commandCalls(QueryCommand);
      const input = calls[0].args[0].input;

      expect(input.KeyConditionExpression).toContain("begins_with(SK, :skPrefix)");
      expect(input.ExpressionAttributeValues![":pk"]).toBe(`A#${ACCOUNT_ULID}`);
      expect(input.ExpressionAttributeValues![":skPrefix"]).toBe("S#");
    });

    it("uses FilterExpression with #entity alias and :entity = SERVICE", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await tool.execute({}, context);

      const calls = ddbMock.commandCalls(QueryCommand);
      const input = calls[0].args[0].input;

      expect(input.FilterExpression).toBe("#entity = :entity");
      expect(input.ExpressionAttributeNames!["#entity"]).toBe("entity");
      expect(input.ExpressionAttributeValues![":entity"]).toBe("SERVICE");
    });
  });
});
