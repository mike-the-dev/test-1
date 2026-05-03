import { Injectable, Inject, Logger } from "@nestjs/common";
import { createHash, randomInt } from "crypto";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { EmailService } from "../services/email.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { VerificationCodeRecord, VerificationRequestCodeResult } from "../types/Verification";
import { requestVerificationCodeInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;
const RATE_LIMIT_WINDOW_HOURS = 1;
const RATE_LIMIT_MAX_REQUESTS = 3;
const VERIFICATION_CODE_SK = "VERIFICATION_CODE";
const USER_CONTACT_INFO_SK = "USER_CONTACT_INFO";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const METADATA_SK = "METADATA";
const CUSTOMER_PK_PREFIX = "C#";
const HASH_ALGORITHM = "sha256";
const VERIFICATION_EMAIL_SUBJECT = "Your verification code";

function buildVerificationEmailBody(code: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<body style="font-family: Arial, sans-serif; color: #333; max-width: 480px; margin: 0 auto; padding: 24px;">
  <p style="margin: 0 0 16px;">Hi,</p>
  <p style="margin: 0 0 16px;">Here is your verification code:</p>
  <h2 style="font-family: 'Courier New', Courier, monospace; font-size: 36px; letter-spacing: 8px; margin: 0 0 16px; color: #111;">${code}</h2>
  <p style="margin: 0 0 16px;">This code expires in <strong>10 minutes</strong>.</p>
  <p style="margin: 0; color: #888; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
</body>
</html>`;
}

@ChatToolProvider()
@Injectable()
export class RequestVerificationCodeTool implements ChatTool {
  private readonly logger = new Logger(RequestVerificationCodeTool.name);

  readonly name = "request_verification_code";

  readonly description =
    "Send a 6-digit email verification code to the email address on file for this session. Call this when you need to verify the visitor's identity before linking their session to an existing customer account. The email address must already be saved via collect_contact_info. Returns { sent: true } on success, or { sent: false, reason } if the email is missing, the visitor has already requested too many codes recently, or delivery failed.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {},
    required: [],
  };

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly emailService: EmailService,
  ) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    const { sessionUlid } = context;

    this.logger.debug(
      `Executing tool [name=request_verification_code sessionUlid=${sessionUlid}]`,
    );

    const parseResult = requestVerificationCodeInputSchema.safeParse(input);

    if (!parseResult.success) {
      const summary = parseResult.error.issues.map((issue) => issue.message).join(", ");
      return { result: `Invalid input: ${summary}`, isError: true };
    }

    const tableName = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    // Step 1 — read USER_CONTACT_INFO for the session's email
    let email: string;

    try {
      const contactResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: sessionPk, SK: USER_CONTACT_INFO_SK },
        }),
      );

      const rawEmail = contactResult.Item?.email;

      if (!rawEmail || rawEmail === "") {
        return { result: JSON.stringify({ sent: false, reason: "no_email_in_session" } satisfies VerificationRequestCodeResult) };
      }

      email = String(rawEmail);
    } catch (contactError: unknown) {
      const errorName = contactError instanceof Error ? contactError.name : "UnknownError";
      this.logger.error(
        `request_verification_code contact info fetch failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "send_failed" } satisfies VerificationRequestCodeResult) };
    }

    // Step 2 — read existing VERIFICATION_CODE record for rate-limit state
    const now = new Date();
    const nowIso = now.toISOString();
    let requestCountInWindow = 1;
    let requestWindowStartAt = nowIso;

    try {
      const codeResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: sessionPk, SK: VERIFICATION_CODE_SK },
        }),
      );

      if (codeResult.Item) {
        const existingWindowStart = String(codeResult.Item.request_window_start_at ?? "");
        const existingCount = Number(codeResult.Item.request_count_in_window ?? 0);
        const windowAgeHours =
          (now.getTime() - new Date(existingWindowStart).getTime()) / (1000 * 60 * 60);

        if (existingCount >= RATE_LIMIT_MAX_REQUESTS && windowAgeHours <= RATE_LIMIT_WINDOW_HOURS) {
          // Rate limited — window is active and cap reached
          return { result: JSON.stringify({ sent: false, reason: "rate_limited" } satisfies VerificationRequestCodeResult) };
        }

        // Window expired: reset to 1. Window active with room: increment.
        requestCountInWindow = windowAgeHours > RATE_LIMIT_WINDOW_HOURS ? 1 : existingCount + 1;
        requestWindowStartAt = windowAgeHours > RATE_LIMIT_WINDOW_HOURS ? nowIso : existingWindowStart;
      }
    } catch (rateError: unknown) {
      const errorName = rateError instanceof Error ? rateError.name : "UnknownError";
      this.logger.error(
        `request_verification_code rate-limit check failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "send_failed" } satisfies VerificationRequestCodeResult) };
    }

    // Step 2.5 — Guard: refuse to send if the customer was created during this session (new visitor).
    // A code may only be sent when METADATA links to a customer whose _createdAt_ predates the session.

    // Sub-step (i) — Read METADATA to get customer_id and session creation timestamp
    let sessionCreatedAt: string;
    let customerId: string;

    try {
      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: sessionPk, SK: METADATA_SK },
        }),
      );

      const metadataItem = metadataResult.Item;

      if (!metadataItem) {
        this.logger.error(
          `request_verification_code METADATA record missing [sessionUlid=${sessionUlid}]`,
        );
        return { result: JSON.stringify({ sent: false, reason: "send_failed" } satisfies VerificationRequestCodeResult) };
      }

      const rawCustomerId = metadataItem.customer_id;

      if (rawCustomerId === null || rawCustomerId === undefined || rawCustomerId === "") {
        this.logger.warn(
          `[event=verification_request_blocked_no_customer_id sessionUlid=${sessionUlid}]`,
        );
        return { result: JSON.stringify({ sent: false, reason: "no_existing_customer_to_verify" } satisfies VerificationRequestCodeResult) };
      }

      sessionCreatedAt = String(metadataItem._createdAt_);
      customerId = String(rawCustomerId);
    } catch (metadataError: unknown) {
      const errorName = metadataError instanceof Error ? metadataError.name : "UnknownError";
      this.logger.error(
        `request_verification_code METADATA fetch failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "send_failed" } satisfies VerificationRequestCodeResult) };
    }

    // Sub-step (ii) — Read customer record (customerId already has C# prefix from METADATA)
    let customerCreatedAt: string;

    try {
      const customerResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: customerId, SK: customerId },
        }),
      );

      if (!customerResult.Item) {
        this.logger.warn(
          `[event=verification_request_blocked_customer_missing sessionUlid=${sessionUlid} customerId=${customerId}]`,
        );
        return { result: JSON.stringify({ sent: false, reason: "no_existing_customer_to_verify" } satisfies VerificationRequestCodeResult) };
      }

      customerCreatedAt = String(customerResult.Item._createdAt_ ?? "");
    } catch (customerError: unknown) {
      const errorName = customerError instanceof Error ? customerError.name : "UnknownError";
      this.logger.error(
        `request_verification_code customer record fetch failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "send_failed" } satisfies VerificationRequestCodeResult) };
    }

    // Sub-step (iii) — Timestamp comparison
    // Pre-CCI legacy customers may lack _createdAt_ — treat as "cannot prove pre-existence"
    if (customerCreatedAt === "") {
      this.logger.warn(
        `[event=verification_request_blocked_new_customer sessionUlid=${sessionUlid} customerCreatedAt=missing sessionCreatedAt=${sessionCreatedAt}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "no_existing_customer_to_verify" } satisfies VerificationRequestCodeResult) };
    }

    // If customer was created at or after the session started, they are a new visitor
    if (new Date(customerCreatedAt) >= new Date(sessionCreatedAt)) {
      this.logger.warn(
        `[event=verification_request_blocked_new_customer sessionUlid=${sessionUlid} customerCreatedAt=${customerCreatedAt} sessionCreatedAt=${sessionCreatedAt}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "no_existing_customer_to_verify" } satisfies VerificationRequestCodeResult) };
    }

    // Customer pre-existed — fall through to code generation

    // Step 3 — generate the 6-digit zero-padded code
    const code = randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");

    // Step 4 — hash the code (same zero-padded string used at generation, hash input, and email body)
    const codeHash = createHash(HASH_ALGORITHM).update(code).digest("hex");

    // Step 5 — send the email FIRST (email-first ordering: write only on success)
    try {
      await this.emailService.send({
        to: email,
        subject: VERIFICATION_EMAIL_SUBJECT,
        body: buildVerificationEmailBody(code),
        sessionUlid,
      });
    } catch (sendError: unknown) {
      const errorName = sendError instanceof Error ? sendError.name : "UnknownError";
      this.logger.error(
        `[event=verification_email_failed sessionUlid=${sessionUlid} errorType=${errorName}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "send_failed" } satisfies VerificationRequestCodeResult) };
    }

    // Step 6 — write the VERIFICATION_CODE record to DDB
    const writeNow = new Date();
    const expiresAt = new Date(writeNow.getTime() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    const ttl = Math.floor((writeNow.getTime() + CODE_TTL_MINUTES * 60 * 1000) / 1000) + 60;
    const writeNowIso = writeNow.toISOString();

    const verificationRecord = {
      PK: sessionPk,
      SK: VERIFICATION_CODE_SK,
      entity: VERIFICATION_CODE_SK,
      code_hash: codeHash,
      email,
      expires_at: expiresAt,
      attempts: 0,
      request_count_in_window: requestCountInWindow,
      request_window_start_at: requestWindowStartAt,
      ttl,
      _createdAt_: writeNowIso,
      _lastUpdated_: writeNowIso,
    } satisfies VerificationCodeRecord;

    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: tableName,
          Item: verificationRecord,
        }),
      );
    } catch (writeError: unknown) {
      const errorName = writeError instanceof Error ? writeError.name : "UnknownError";
      this.logger.error(
        `request_verification_code DDB write failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ sent: false, reason: "send_failed" } satisfies VerificationRequestCodeResult) };
    }

    // Step 7 — return success
    return { result: JSON.stringify({ sent: true } satisfies VerificationRequestCodeResult) };
  }
}
