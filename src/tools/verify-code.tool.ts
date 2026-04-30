import { Injectable, Inject, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { CustomerService } from "../services/customer.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { VerificationVerifyCodeResult } from "../types/Verification";
import { verifyCodeInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const VERIFICATION_CODE_SK = "VERIFICATION_CODE";
const METADATA_SK = "METADATA";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const MAX_ATTEMPTS = 5;
const HASH_ALGORITHM = "sha256";

@ChatToolProvider()
@Injectable()
export class VerifyCodeTool implements ChatTool {
  private readonly logger = new Logger(VerifyCodeTool.name);

  readonly name = "verify_code";

  readonly description =
    "Verify the 6-digit code the visitor just entered against the pending verification code for this session. Call this immediately after the visitor provides the code. Returns { verified: true, customerId } on success, or { verified: false, reason } if the code is wrong, expired, or the maximum number of attempts has been reached.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The 6-digit verification code the visitor entered.",
      },
    },
    required: ["code"],
  };

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly customerService: CustomerService,
  ) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    const { sessionUlid, accountUlid } = context;

    this.logger.debug(
      `Executing tool [name=verify_code sessionUlid=${sessionUlid}]`,
    );

    // Step 1 — validate input
    const parseResult = verifyCodeInputSchema.safeParse(input);

    if (!parseResult.success) {
      const summary = parseResult.error.issues.map((issue) => issue.message).join(", ");
      return { result: `Invalid input: ${summary}`, isError: true };
    }

    const parsed = parseResult.data;
    const tableName = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    // Step 2 — read the VERIFICATION_CODE record
    let codeRecord: Record<string, unknown>;

    try {
      const codeResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: sessionPk, SK: VERIFICATION_CODE_SK },
        }),
      );

      if (!codeResult.Item) {
        return { result: JSON.stringify({ verified: false, reason: "no_pending_code" } satisfies VerificationVerifyCodeResult) };
      }

      codeRecord = codeResult.Item;
    } catch (readError: unknown) {
      const errorName = readError instanceof Error ? readError.name : "UnknownError";
      this.logger.error(
        `verify_code VERIFICATION_CODE read failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ verified: false, reason: "no_pending_code" } satisfies VerificationVerifyCodeResult) };
    }

    const storedCodeHash = String(codeRecord.code_hash ?? "");
    const storedEmail = String(codeRecord.email ?? "");
    const storedExpiresAt = String(codeRecord.expires_at ?? "");
    const storedAttempts = Number(codeRecord.attempts ?? 0);

    // Step 3 — check expiry
    if (new Date(storedExpiresAt) < new Date()) {
      return { result: JSON.stringify({ verified: false, reason: "expired" } satisfies VerificationVerifyCodeResult) };
    }

    // Step 4 — check attempts cap BEFORE hashing
    if (storedAttempts >= MAX_ATTEMPTS) {
      return { result: JSON.stringify({ verified: false, reason: "max_attempts" } satisfies VerificationVerifyCodeResult) };
    }

    // Step 5 — hash the submitted code and compare
    const submittedHash = createHash(HASH_ALGORITHM).update(parsed.code).digest("hex");

    if (submittedHash !== storedCodeHash) {
      // Increment attempts
      try {
        const now = new Date().toISOString();
        await this.dynamoDb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: sessionPk, SK: VERIFICATION_CODE_SK },
            UpdateExpression: "SET attempts = attempts + :one, #lastUpdated = :now",
            ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
            ExpressionAttributeValues: { ":one": 1, ":now": now },
          }),
        );
      } catch (attemptsError: unknown) {
        const errorName = attemptsError instanceof Error ? attemptsError.name : "UnknownError";
        this.logger.warn(
          `verify_code attempts increment failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
        );
      }

      return { result: JSON.stringify({ verified: false, reason: "wrong_code" } satisfies VerificationVerifyCodeResult) };
    }

    // Step 6 — verification success: lookup customer, then three sequential writes

    if (!accountUlid) {
      this.logger.debug(
        `[event=verify_code_no_account_scope sessionUlid=${sessionUlid}]`,
      );
    }

    // Lookup — find customer by VERIFICATION_CODE record email.
    // latestSessionId is captured HERE (before Write B overwrites it on the Customer record).
    let customerUlid: string;
    let latestSessionId: string | null;

    try {
      const lookupResult = await this.customerService.queryCustomerIdByEmail(
        tableName,
        accountUlid ?? "",
        storedEmail,
      );

      if (lookupResult === null) {
        this.logger.error(
          `[event=verify_customer_not_found sessionUlid=${sessionUlid} errorType=CustomerNotFound]`,
        );
        return { result: JSON.stringify({ verified: false, reason: "no_pending_code" } satisfies VerificationVerifyCodeResult) };
      }

      customerUlid = lookupResult.customerUlid;
      latestSessionId = lookupResult.latestSessionId;
    } catch (lookupError: unknown) {
      const errorName = lookupError instanceof Error ? lookupError.name : "UnknownError";
      this.logger.error(
        `verify_code customer lookup failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ verified: false, reason: "no_pending_code" } satisfies VerificationVerifyCodeResult) };
    }

    const customerId = `C#${customerUlid}`;
    const now = new Date().toISOString();

    // Write A — set customer_id and continuation_from_session_id on session METADATA atomically.
    // continuation_from_session_id captures the prior session ULID BEFORE Write B overwrites
    // customer.latest_session_id with the current session. Order is critical.
    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: sessionPk, SK: METADATA_SK },
          UpdateExpression: "SET customer_id = :customerId, continuation_from_session_id = :contFromSessionId, #lastUpdated = :now",
          ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
          ExpressionAttributeValues: { ":customerId": customerId, ":contFromSessionId": latestSessionId, ":now": now },
        }),
      );
    } catch (metadataError: unknown) {
      const errorName = metadataError instanceof Error ? metadataError.name : "UnknownError";
      this.logger.error(
        `verify_code METADATA customer_id update failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
    }

    // Write B — update latest_session_id on the Customer record
    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: customerId, SK: customerId },
          UpdateExpression: "SET latest_session_id = :sessionUlid, #lastUpdated = :now",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
          ExpressionAttributeValues: { ":sessionUlid": sessionUlid, ":now": now },
        }),
      );
    } catch (customerError: unknown) {
      const errorName = customerError instanceof Error ? customerError.name : "UnknownError";
      if (errorName !== "ConditionalCheckFailedException") {
        this.logger.warn(
          `verify_code Customer latest_session_id update failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
        );
      }
    }

    // Write C — delete the VERIFICATION_CODE record (single-use)
    try {
      await this.dynamoDb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { PK: sessionPk, SK: VERIFICATION_CODE_SK },
        }),
      );
    } catch (deleteError: unknown) {
      const errorName = deleteError instanceof Error ? deleteError.name : "UnknownError";
      this.logger.warn(
        `verify_code VERIFICATION_CODE delete failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
    }

    // Step 7 — return success
    return { result: JSON.stringify({ verified: true, customerId } satisfies VerificationVerifyCodeResult) };
  }
}
