import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { ChatSessionPointerRecord, ChatSessionUpdateOnboardingResult, ChatSessionLookupOrCreateResult } from "../types/ChatSession";

const ACCOUNT_PK_PREFIX = "A#";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const METADATA_SK = "METADATA";

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  /**
   * Looks up an existing session or mints a new one, atomically from the
   * caller's perspective. No IDENTITY records are written — session identity
   * is carried by the sessionId parameter (web) or is irrelevant (email).
   *
   * Branch A — sessionId is provided:
   *   Attempts a GetItem on CHAT_SESSION#<sessionId>/METADATA. If the record
   *   exists, returns it with wasCreated: false (resume path). If the record
   *   is not found (stale or tampered sessionId), falls through to Branch B.
   *   This deliberate fallthrough is why a stale sessionId results in a fresh
   *   session rather than a 404 — the caller always gets a usable session back.
   *
   * Branch B — mint new:
   *   Generates a fresh ULID, writes METADATA via UpdateCommand (if_not_exists
   *   guards make it idempotent), writes an account-scoped pointer record
   *   (best-effort, failure is logged but not re-thrown), and returns the new
   *   sessionUlid with wasCreated: true.
   */
  async lookupOrCreateSession(
    source: string,
    sessionId: string | null,
    agentName: string,
    accountUlid?: string,
  ): Promise<ChatSessionLookupOrCreateResult> {
    const table = this.databaseConfig.conversationsTable;

    // Branch A: attempt to resume an existing session
    if (sessionId !== null) {
      const existingPk = `${CHAT_SESSION_PK_PREFIX}${sessionId}`;

      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: table,
          Key: { PK: existingPk, SK: METADATA_SK },
        }),
      );

      if (metadataResult.Item) {
        const onboardingCompletedAt = metadataResult.Item.onboarding_completed_at ?? null;
        const kickoffCompletedAt = metadataResult.Item.kickoff_completed_at ?? null;
        const budgetCents = metadataResult.Item.budget_cents ?? null;

        this.logger.debug(
          `Resumed existing session [sessionUlid=${sessionId} accountUlid=${accountUlid ?? "<none>"}]`,
        );

        return { sessionUlid: sessionId, onboardingCompletedAt, kickoffCompletedAt, budgetCents, wasCreated: false };
      }

      // sessionId provided but not found — fall through to mint a new session
      this.logger.debug(
        `sessionId not found, minting new session [requestedSessionUlid=${sessionId} accountUlid=${accountUlid ?? "<none>"}]`,
      );
    }

    // Branch B: mint a new session
    const sessionUlid = ulid();
    const now = new Date().toISOString();
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    this.logger.log(`Creating session [sessionUlid=${sessionUlid} source=${source}]`);

    const setClauses = [
      "#createdAt = if_not_exists(#createdAt, :now)",
      "#lastUpdated = :now",
      "#src = if_not_exists(#src, :source)",
      "agent_name = if_not_exists(agent_name, :agentName)",
    ];

    const expressionNames: Record<string, string> = {
      "#src": "source",
      "#createdAt": "_createdAt_",
      "#lastUpdated": "_lastUpdated_",
    };

    const expressionValues: Record<string, unknown> = {
      ":now": now,
      ":source": source,
      ":agentName": agentName,
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
    // backfill from the METADATA record's account_id attribute.
    if (accountUlid !== undefined) {
      const pointerItem = {
        PK: `${ACCOUNT_PK_PREFIX}${accountUlid}`,
        SK: sessionPk,
        entity: "CHAT_SESSION",
        session_id: sessionUlid,
        agent_name: agentName,
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
      } catch (pointerError: unknown) {
        const errorName = pointerError instanceof Error ? pointerError.name : "UnknownError";
        this.logger.error(
          `Failed to write session pointer [errorType=${errorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
      }
    }

    return { sessionUlid, onboardingCompletedAt: null, kickoffCompletedAt: null, budgetCents: null, wasCreated: true };
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
