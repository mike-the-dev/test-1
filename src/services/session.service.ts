import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { ChatSessionPointerRecord, ChatSessionUpdateOnboardingResult } from "../types/ChatSession";

const ACCOUNT_PK_PREFIX = "A#";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const METADATA_SK = "METADATA";
const LEAD_CAPTURE_AGENT_NAME = "lead_capture";

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  /**
   * Creates a new chat session METADATA record. Does not write any identity
   * indirection record — callers supply and store the session ID directly.
   *
   * Used by the web-chat controller (new-session path) and by email-inbound
   * Case 2 and Case 3-stale, where routing is driven by the recipient's
   * local-part and the Customer GSI.
   */
  async createSession(source: string, accountUlid?: string): Promise<string> {
    const table = this.databaseConfig.conversationsTable;
    const sessionUlid = ulid();
    const now = new Date().toISOString();
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    this.logger.log(`Creating session [sessionUlid=${sessionUlid} source=${source}]`);

    const setClauses = [
      "#createdAt = if_not_exists(#createdAt, :now)",
      "#lastUpdated = :now",
      "#src = if_not_exists(#src, :source)",
      "customer_id = if_not_exists(customer_id, :customerIdNull)",
      "continuation_from_session_id = if_not_exists(continuation_from_session_id, :contFromNull)",
      "continuation_loaded_at = if_not_exists(continuation_loaded_at, :contAtNull)",
    ];

    const expressionNames: Record<string, string> = {
      "#src": "source",
      "#createdAt": "_createdAt_",
      "#lastUpdated": "_lastUpdated_",
    };

    const expressionValues: Record<string, unknown> = {
      ":now": now,
      ":source": source,
      ":customerIdNull": null,
      ":contFromNull": null,
      ":contAtNull": null,
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

    if (accountUlid !== undefined) {
      const pointerItem = {
        PK: `${ACCOUNT_PK_PREFIX}${accountUlid}`,
        SK: sessionPk,
        entity: "CHAT_SESSION",
        session_id: sessionUlid,
        agent_name: LEAD_CAPTURE_AGENT_NAME,
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

    return sessionUlid;
  }

  async updateOnboarding(sessionUlid: string, budgetCents: number): Promise<ChatSessionUpdateOnboardingResult> {
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
