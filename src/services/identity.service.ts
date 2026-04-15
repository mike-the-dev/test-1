import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { ChatSessionIdentityRecord, ChatSessionMetadataRecord } from "../types/ChatSession";

const IDENTITY_PK_PREFIX = "IDENTITY#";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const METADATA_SK = "METADATA";
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

function isConditionalCheckFailed(error: unknown): boolean {
  if (error !== null && error !== undefined) {
    const record: { name?: unknown } = error as { name?: unknown };

    return record.name === CONDITIONAL_CHECK_FAILED;
  }

  return false;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async lookupOrCreateSession(source: string, externalId: string, defaultAgentName: string, accountUlid?: string): Promise<string> {
    const table = this.databaseConfig.conversationsTable;
    const pk = `${IDENTITY_PK_PREFIX}${source}#${externalId}`;

    this.logger.debug(`Looking up identity [source=${source} externalId=${externalId}]`);

    const existingResult = await this.dynamoDb.send(
      new GetCommand({
        TableName: table,
        Key: { PK: pk, SK: pk },
      }),
    );

    if (existingResult.Item) {
      const sessionUlid: string = existingResult.Item.sessionUlid;

      this.logger.debug(`Found existing session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]`);

      return sessionUlid;
    }

    const sessionUlid = ulid();

    this.logger.log(`Creating new session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]`);

    const now = new Date().toISOString();

    const identityItem = {
      PK: pk,
      SK: pk,
      sessionUlid,
      createdAt: now,
    } satisfies ChatSessionIdentityRecord;

    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: table,
          Item: identityItem,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        const winnerResult = await this.dynamoDb.send(
          new GetCommand({
            TableName: table,
            Key: { PK: pk, SK: pk },
          }),
        );

        const winnerSessionUlid = winnerResult.Item?.sessionUlid;

        if (!winnerSessionUlid) {
          throw new Error("Identity record missing after ConditionalCheckFailedException — possible concurrent delete");
        }

        this.logger.warn(`Race condition recovered on identity creation [source=${source} externalId=${externalId} sessionUlid=${winnerSessionUlid}]`);

        return winnerSessionUlid;
      }

      throw error;
    }

    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    const metadataItem = {
      PK: sessionPk,
      SK: METADATA_SK,
      source,
      createdAt: now,
      lastMessageAt: now,
    } satisfies ChatSessionMetadataRecord;

    const setClauses = [
      "createdAt = if_not_exists(createdAt, :now)",
      "lastMessageAt = :now",
      "#src = if_not_exists(#src, :source)",
      "agentName = if_not_exists(agentName, :agentName)",
    ];

    const expressionValues: Record<string, unknown> = {
      ":now": metadataItem.createdAt,
      ":source": metadataItem.source,
      ":agentName": defaultAgentName,
    };

    if (accountUlid !== undefined) {
      setClauses.push("accountUlid = if_not_exists(accountUlid, :accountUlid)");
      expressionValues[":accountUlid"] = accountUlid;
    }

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: sessionPk, SK: METADATA_SK },
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: { "#src": "source" },
        ExpressionAttributeValues: expressionValues,
      }),
    );

    return sessionUlid;
  }
}
