import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { OriginAllowlistService } from "./origin-allowlist.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";

const TABLE_NAME = "test-table";
const ACCOUNT_ULID = "01KDNMGKTP23M8TJ0FRW70WYRT";

const mockDatabaseConfig = { conversationsTable: TABLE_NAME };

function buildMockConfigService(domainGsiName: string): Partial<ConfigService> {
  return {
    get: jest.fn().mockReturnValue(domainGsiName),
  };
}

async function buildModule(domainGsiName: string): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      OriginAllowlistService,
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
        useValue: buildMockConfigService(domainGsiName),
      },
    ],
  }).compile();
}

describe("OriginAllowlistService", () => {
  let service: OriginAllowlistService;
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(async () => {
    ddbMock.reset();
    jest.clearAllMocks();
    jest.restoreAllMocks();

    const module = await buildModule("GSI1");
    service = module.get<OriginAllowlistService>(OriginAllowlistService);
  });

  describe("active / inactive / missing status cases (locked)", () => {
    it("returns accountUlid for active account and caches with positive TTL", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true }, PK: `A#${ACCOUNT_ULID}` }],
      });

      const dateSpy = jest.spyOn(Date, "now");
      const now = 1_000_000;
      dateSpy.mockReturnValue(now);

      const result = await service.resolveAccountForOrigin("https://example.com");

      expect(result).toBe(ACCOUNT_ULID);

      // Second call must not hit DynamoDB (cache hit)
      ddbMock.reset();
      const result2 = await service.resolveAccountForOrigin("https://example.com");
      expect(result2).toBe(ACCOUNT_ULID);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("returns null for inactive account and caches with negative TTL", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: false }, PK: `A#${ACCOUNT_ULID}` }],
      });

      const result = await service.resolveAccountForOrigin("https://inactive.example.com");

      expect(result).toBeNull();

      // Second call must not hit DynamoDB (cache hit)
      ddbMock.reset();
      const result2 = await service.resolveAccountForOrigin("https://inactive.example.com");
      expect(result2).toBeNull();
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("returns null when account is found but status field is missing entirely", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", PK: `A#${ACCOUNT_ULID}` }],
      });

      const result = await service.resolveAccountForOrigin("https://nostatus.example.com");

      expect(result).toBeNull();
    });

    it("returns null when non-account entity returned (defensive — FilterExpression should prevent this)", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "SESSION", PK: "S#something" }],
      });

      const result = await service.resolveAccountForOrigin("https://session.example.com");

      expect(result).toBeNull();
    });

    it("returns null and caches with negative TTL when zero items returned", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await service.resolveAccountForOrigin("https://zero.example.com");

      expect(result).toBeNull();

      // Second call must not hit DynamoDB (cache hit)
      ddbMock.reset();
      const result2 = await service.resolveAccountForOrigin("https://zero.example.com");
      expect(result2).toBeNull();
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("returns null and does NOT write to cache when DynamoDB throws", async () => {
      const dbError = Object.assign(new Error("Service unavailable"), { name: "ServiceUnavailableException" });
      ddbMock.on(QueryCommand).rejects(dbError);

      const result = await service.resolveAccountForOrigin("https://error.example.com");

      expect(result).toBeNull();

      // Next request must retry DynamoDB (no cache entry written)
      ddbMock.reset();
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      await service.resolveAccountForOrigin("https://error.example.com");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it("extracts ULID by stripping the A# prefix from PK", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true }, PK: `A#${ACCOUNT_ULID}` }],
      });

      const result = await service.resolveAccountForOrigin("https://strip-prefix.example.com");

      expect(result).toBe(ACCOUNT_ULID);
    });

    it("returns null and logs a warning when PK is missing the A# prefix", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true }, PK: "BROKEN_NO_PREFIX" }],
      });

      const warnSpy = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, "warn");

      const result = await service.resolveAccountForOrigin("https://broken-prefix.example.com");

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("accepts a bare hostname without a scheme (treats it as https for parsing)", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true }, PK: `A#${ACCOUNT_ULID}` }],
      });

      const result = await service.resolveAccountForOrigin("shop.example.com");

      expect(result).toBe(ACCOUNT_ULID);

      const queryCalls = ddbMock.commandCalls(QueryCommand);
      const lastCall = queryCalls[queryCalls.length - 1].args[0].input;

      expect(lastCall.ExpressionAttributeValues?.[":pk"]).toBe("DOMAIN#shop.example.com");
    });

    it("accepts a bare hostname like 'localhost' as used by widget hostDomain lookups", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true }, PK: `A#${ACCOUNT_ULID}` }],
      });

      const result = await service.resolveAccountForOrigin("localhost");

      expect(result).toBe(ACCOUNT_ULID);

      const queryCalls = ddbMock.commandCalls(QueryCommand);
      const lastCall = queryCalls[queryCalls.length - 1].args[0].input;

      expect(lastCall.ExpressionAttributeValues?.[":pk"]).toBe("DOMAIN#localhost");
    });
  });

  describe("cache TTL behavior", () => {
    it("treats a positive cache entry as a hit before expiry", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true }, PK: `A#${ACCOUNT_ULID}` }],
      });

      const dateSpy = jest.spyOn(Date, "now");
      dateSpy.mockReturnValue(1_000_000);

      await service.resolveAccountForOrigin("https://ttl-positive.example.com");

      // Still before expiry
      dateSpy.mockReturnValue(1_000_000 + 4 * 60 * 1000);
      ddbMock.reset();

      const result = await service.resolveAccountForOrigin("https://ttl-positive.example.com");
      expect(result).toBe(ACCOUNT_ULID);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("re-queries DynamoDB after positive TTL expires", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true }, PK: `A#${ACCOUNT_ULID}` }],
      });

      const dateSpy = jest.spyOn(Date, "now");
      dateSpy.mockReturnValue(1_000_000);

      await service.resolveAccountForOrigin("https://expired-positive.example.com");

      // After positive TTL (5 min)
      dateSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
      ddbMock.reset();
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://expired-positive.example.com");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it("re-queries DynamoDB after negative TTL expires", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const dateSpy = jest.spyOn(Date, "now");
      dateSpy.mockReturnValue(1_000_000);

      await service.resolveAccountForOrigin("https://expired-negative.example.com");

      // After negative TTL (1 min)
      dateSpy.mockReturnValue(1_000_000 + 1 * 60 * 1000 + 1);
      ddbMock.reset();
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://expired-negative.example.com");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });
  });

  describe("origin normalization", () => {
    it("strips scheme from origin", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues![":pk"]).toBe("DOMAIN#example.com");
    });

    it("lowercases the host", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://Shop.Example.Com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues![":pk"]).toBe("DOMAIN#shop.example.com");
    });

    it("strips port from origin", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://example.com:443");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues![":pk"]).toBe("DOMAIN#example.com");
    });

    it("returns null for truly malformed origin (empty string) without querying DynamoDB", async () => {
      const result = await service.resolveAccountForOrigin("   ");

      expect(result).toBeNull();
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  describe("GSI query shape", () => {
    it("uses the config-service-provided GSI name as IndexName", async () => {
      const module = await buildModule("MyCustomGSI");
      const customService = module.get<OriginAllowlistService>(OriginAllowlistService);

      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await customService.resolveAccountForOrigin("https://gsiname.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.IndexName).toBe("MyCustomGSI");
    });

    it("uses 'GSI1' when config service returns the default value", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://defaultgsi.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.IndexName).toBe("GSI1");
    });

    it("uses ExpressionAttributeNames to alias hyphenated GSI1-PK attribute and entity field", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://attrnames.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeNames).toEqual({
        "#gsi1pk": "GSI1-PK",
        "#entity": "entity",
      });
    });

    it("uses correct ExpressionAttributeValues for pk and account filter", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.resolveAccountForOrigin("https://values.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues).toEqual({
        ":pk": "DOMAIN#values.example.com",
        ":account": "ACCOUNT",
      });
    });
  });
});
