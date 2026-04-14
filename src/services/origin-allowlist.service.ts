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

  async isAllowed(origin: string): Promise<boolean> {
    const host = this.normalizeOrigin(origin);

    if (host === null) {
      this.logger.debug(`Origin check: denied (malformed) [origin omitted]`);
      return false;
    }

    const cached = this.cache.get(host);

    if (cached !== undefined && Date.now() < cached.expiresAt) {
      this.logger.debug(`Origin check: cache hit [host=${host} allowed=${cached.allowed}]`);
      return cached.allowed;
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
      const allowed = Boolean(account && account.status?.is_active === true);

      this.cache.set(host, { allowed, expiresAt: Date.now() + (allowed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });

      this.logger.debug(`Origin check: query result [host=${host} allowed=${allowed}]`);

      return allowed;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`Origin check: DynamoDB error [host=${host} errorName=${errorName}]`);
      return false;
    }
  }

  private normalizeOrigin(origin: string): string | null {
    try {
      const url = new URL(origin.trim());
      return url.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}
