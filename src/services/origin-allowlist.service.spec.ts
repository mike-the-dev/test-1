import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { OriginAllowlistService } from "./origin-allowlist.service";
import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";

const TABLE_NAME = "test-table";

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
    it("returns true for active account and caches with positive TTL", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true } }],
      });

      const dateSpy = jest.spyOn(Date, "now");
      const now = 1_000_000;
      dateSpy.mockReturnValue(now);

      const result = await service.isAllowed("https://example.com");

      expect(result).toBe(true);

      // Second call must not hit DynamoDB (cache hit)
      ddbMock.reset();
      const result2 = await service.isAllowed("https://example.com");
      expect(result2).toBe(true);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("returns false for inactive account and caches with negative TTL", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: false } }],
      });

      const result = await service.isAllowed("https://inactive.example.com");

      expect(result).toBe(false);

      // Second call must not hit DynamoDB (cache hit)
      ddbMock.reset();
      const result2 = await service.isAllowed("https://inactive.example.com");
      expect(result2).toBe(false);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("returns false when account is found but status field is missing entirely", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT" }],
      });

      const result = await service.isAllowed("https://nostatus.example.com");

      expect(result).toBe(false);
    });

    it("returns false when non-account entity returned (defensive — FilterExpression should prevent this)", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "SESSION" }],
      });

      const result = await service.isAllowed("https://session.example.com");

      expect(result).toBe(false);
    });

    it("returns false and caches with negative TTL when zero items returned", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await service.isAllowed("https://zero.example.com");

      expect(result).toBe(false);

      // Second call must not hit DynamoDB (cache hit)
      ddbMock.reset();
      const result2 = await service.isAllowed("https://zero.example.com");
      expect(result2).toBe(false);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("returns false and does NOT write to cache when DynamoDB throws", async () => {
      const dbError = Object.assign(new Error("Service unavailable"), { name: "ServiceUnavailableException" });
      ddbMock.on(QueryCommand).rejects(dbError);

      const result = await service.isAllowed("https://error.example.com");

      expect(result).toBe(false);

      // Next request must retry DynamoDB (no cache entry written)
      ddbMock.reset();
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      await service.isAllowed("https://error.example.com");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });
  });

  describe("cache TTL behavior", () => {
    it("treats a positive cache entry as a hit before expiry", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true } }],
      });

      const dateSpy = jest.spyOn(Date, "now");
      dateSpy.mockReturnValue(1_000_000);

      await service.isAllowed("https://ttl-positive.example.com");

      // Still before expiry
      dateSpy.mockReturnValue(1_000_000 + 4 * 60 * 1000);
      ddbMock.reset();

      const result = await service.isAllowed("https://ttl-positive.example.com");
      expect(result).toBe(true);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("re-queries DynamoDB after positive TTL expires", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ entity: "ACCOUNT", status: { is_active: true } }],
      });

      const dateSpy = jest.spyOn(Date, "now");
      dateSpy.mockReturnValue(1_000_000);

      await service.isAllowed("https://expired-positive.example.com");

      // After positive TTL (5 min)
      dateSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
      ddbMock.reset();
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://expired-positive.example.com");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it("re-queries DynamoDB after negative TTL expires", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const dateSpy = jest.spyOn(Date, "now");
      dateSpy.mockReturnValue(1_000_000);

      await service.isAllowed("https://expired-negative.example.com");

      // After negative TTL (1 min)
      dateSpy.mockReturnValue(1_000_000 + 1 * 60 * 1000 + 1);
      ddbMock.reset();
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://expired-negative.example.com");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });
  });

  describe("origin normalization", () => {
    it("strips scheme from origin", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues![":pk"]).toBe("DOMAIN#example.com");
    });

    it("lowercases the host", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://Shop.Example.Com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues![":pk"]).toBe("DOMAIN#shop.example.com");
    });

    it("strips port from origin", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://example.com:443");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues![":pk"]).toBe("DOMAIN#example.com");
    });

    it("returns false for malformed origin without querying DynamoDB", async () => {
      const result = await service.isAllowed("not-a-url");

      expect(result).toBe(false);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  describe("GSI query shape", () => {
    it("uses the config-service-provided GSI name as IndexName", async () => {
      const module = await buildModule("MyCustomGSI");
      const customService = module.get<OriginAllowlistService>(OriginAllowlistService);

      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await customService.isAllowed("https://gsiname.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.IndexName).toBe("MyCustomGSI");
    });

    it("uses 'GSI1' when config service returns the default value", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://defaultgsi.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.IndexName).toBe("GSI1");
    });

    it("uses ExpressionAttributeNames to alias hyphenated GSI1-PK attribute and entity field", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://attrnames.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeNames).toEqual({
        "#gsi1pk": "GSI1-PK",
        "#entity": "entity",
      });
    });

    it("uses correct ExpressionAttributeValues for pk and account filter", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.isAllowed("https://values.example.com");

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls[0].args[0].input.ExpressionAttributeValues).toEqual({
        ":pk": "DOMAIN#values.example.com",
        ":account": "ACCOUNT",
      });
    });
  });
});
