import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { OriginAllowlistCacheEntry } from "../types/OriginAllowlist";

const POSITIVE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_TTL_MS = 1 * 60 * 1000; // 1 minute

@Injectable()
export class OriginAllowlistService {
  private readonly logger = new Logger(OriginAllowlistService.name);

  private readonly cache = new Map<string, OriginAllowlistCacheEntry>();
  private readonly gsiName: string;

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoClient: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly configService: ConfigService,
  ) {
    this.gsiName = this.configService.get<string>("webChat.domainGsiName", { infer: true }) ?? "GSI1";
  }

  async resolveAccountForOrigin(origin: string): Promise<string | null> {
    const host = this.normalizeOrigin(origin);

    if (host === null) {
      this.logger.debug(`Origin check: denied (malformed) [origin omitted]`);
      return null;
    }

    const cached = this.cache.get(host);

    if (cached !== undefined && Date.now() < cached.expiresAt) {
      this.logger.debug(`Origin check: cache hit [host=${host} accountUlid=${cached.accountUlid ?? "null"}]`);
      return cached.accountUlid;
    }

    const tableName = this.databaseConfig.conversationsTable;
    const gsiName = this.gsiName;

    try {
      const result = await this.dynamoClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: gsiName,
          KeyConditionExpression: "#gsi1pk = :pk",
          FilterExpression: "#entity = :account",
          ExpressionAttributeNames: {
            "#gsi1pk": "GSI1-PK",
            "#entity": "entity",
          },
          ExpressionAttributeValues: {
            ":pk": `DOMAIN#${host}`,
            ":account": "ACCOUNT",
          },
          Limit: 1,
        }),
      );

      const account = result.Items?.[0];

      if (!account || account.status?.is_active !== true) {
        this.cache.set(host, { accountUlid: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
        this.logger.debug(`Origin check: denied [host=${host} accountUlid=null]`);
        return null;
      }

      let accountUlid: string | null;

      if (account.PK.startsWith("A#")) {
        accountUlid = account.PK.slice(2);
      } else {
        this.logger.warn(`Origin check: PK missing A# prefix [host=${host}]`);
        this.cache.set(host, { accountUlid: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
        return null;
      }

      this.cache.set(host, { accountUlid, expiresAt: Date.now() + POSITIVE_TTL_MS });

      this.logger.debug(`Origin check: resolved [host=${host} accountUlid=${accountUlid}]`);

      return accountUlid;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`Origin check: DynamoDB error [errorType=${errorName}]`);
      return null;
    }
  }

  private normalizeOrigin(origin: string): string | null {
    const trimmed = origin.trim();

    if (trimmed.length === 0) {
      return null;
    }

    // Accept both full origins ("http://localhost:3000") and bare hostnames
    // ("localhost", "shop.example.com"). CORS middleware passes the browser's
    // Origin header (full origin); the controller's hostDomain-based path
    // passes the bare host from the request body. Prepending a scheme when
    // one is absent lets URL parsing handle both shapes.
    const toParse = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

    try {
      const url = new URL(toParse);
      return url.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}
