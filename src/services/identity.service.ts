import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { ChatSessionIdentityRecord, ChatSessionMetadataRecord, ChatSessionPointerRecord, LookupOrCreateSessionResult } from "../types/ChatSession";

const ACCOUNT_PK_PREFIX = "A#";

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

  async lookupOrCreateSession(
    source: string,
    externalId: string,
    defaultAgentName: string,
    accountUlid?: string,
  ): Promise<LookupOrCreateSessionResult> {
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
      const sessionUlid: string = existingResult.Item.session_id;

      this.logger.debug(`Found existing session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]`);

      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: table,
          Key: { PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`, SK: METADATA_SK },
        }),
      );

      const onboardingCompletedAt = metadataResult.Item?.onboarding_completed_at ?? null;
      const kickoffCompletedAt = metadataResult.Item?.kickoff_completed_at ?? null;
      const budgetCents = metadataResult.Item?.budget_cents ?? null;

      return { sessionUlid, onboardingCompletedAt, kickoffCompletedAt, budgetCents, wasCreated: false };
    }

    const sessionUlid = ulid();

    this.logger.log(`Creating new session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]`);

    const now = new Date().toISOString();

    const identityItem = {
      PK: pk,
      SK: pk,
      session_id: sessionUlid,
      _createdAt_: now,
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

        const winnerSessionUlid = winnerResult.Item?.session_id;

        if (!winnerSessionUlid) {
          throw new Error("Identity record missing after ConditionalCheckFailedException — possible concurrent delete");
        }

        this.logger.warn(`Race condition recovered on identity creation [source=${source} externalId=${externalId} sessionUlid=${winnerSessionUlid}]`);

        return { sessionUlid: winnerSessionUlid, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: false };
      }

      throw error;
    }

    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    const metadataItem = {
      PK: sessionPk,
      SK: METADATA_SK,
      source,
      customer_id: null,
      _createdAt_: now,
      _lastUpdated_: now,
    } satisfies ChatSessionMetadataRecord;

    const setClauses = [
      "#createdAt = if_not_exists(#createdAt, :now)",
      "#lastUpdated = :now",
      "#src = if_not_exists(#src, :source)",
      "agent_name = if_not_exists(agent_name, :agentName)",
      "customer_id = if_not_exists(customer_id, :customerIdNull)",
    ];

    const expressionNames: Record<string, string> = {
      "#src": "source",
      "#createdAt": "_createdAt_",
      "#lastUpdated": "_lastUpdated_",
    };

    const expressionValues: Record<string, unknown> = {
      ":now": metadataItem._createdAt_,
      ":source": metadataItem.source,
      ":agentName": defaultAgentName,
      ":customerIdNull": null,
    };

    if (accountUlid !== undefined) {
      setClauses.push("account_id = if_not_exists(account_id, :accountId)");
      expressionValues[":accountId"] = accountUlid;
    }

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: sessionPk, SK: METADATA_SK },
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
      }),
    );

    // Write the account-scoped pointer record so the account can Query all its
    // sessions without scanning. Best-effort: if this fails, the primary
    // session is still valid and usable — the pointer is recoverable via
    // backfill from the METADATA record's accountUlid attribute.
    if (accountUlid !== undefined) {
      const pointerItem = {
        PK: `${ACCOUNT_PK_PREFIX}${accountUlid}`,
        SK: sessionPk,
        entity: "CHAT_SESSION",
        session_id: sessionUlid,
        agent_name: defaultAgentName,
        source,
        _createdAt_: now,
        _lastUpdated_: now,
      } satisfies ChatSessionPointerRecord;

      try {
        await this.dynamoDb.send(
          new PutCommand({
            TableName: table,
            Item: pointerItem,
          }),
        );
      } catch (pointerError) {
        const errorName = pointerError instanceof Error ? pointerError.name : "UnknownError";
        this.logger.error(
          `Failed to write session pointer [errorType=${errorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
      }
    }

    return { sessionUlid, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true };
  }

  async updateOnboarding(
    sessionUlid: string,
    budgetCents: number,
  ): Promise<{ sessionUlid: string; onboardingCompletedAt: string; kickoffCompletedAt: string | null; budgetCents: number }> {
    const table = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;
    const now = new Date().toISOString();

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: sessionPk, SK: METADATA_SK },
        UpdateExpression: "SET onboarding_completed_at = :now, budget_cents = :cents, #lastUpdated = :now",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: { ":now": now, ":cents": budgetCents },
      }),
    );

    this.logger.debug(`Onboarding recorded [sessionUlid=${sessionUlid} budgetCents=${budgetCents}]`);

    const metadataResult = await this.dynamoDb.send(
      new GetCommand({
        TableName: table,
        Key: { PK: sessionPk, SK: METADATA_SK },
      }),
    );

    const kickoffCompletedAt = metadataResult.Item?.kickoff_completed_at ?? null;

    return { sessionUlid, onboardingCompletedAt: now, kickoffCompletedAt, budgetCents };
  }
}
