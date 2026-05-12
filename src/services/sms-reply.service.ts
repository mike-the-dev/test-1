import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { TwilioConfigService } from "./twilio-config.service";
import { ChatSessionService } from "./chat-session.service";
import { CustomerService } from "./customer.service";
import { SessionService } from "./session.service";
import { ChannelAddressService } from "./channel-address.service";
import { ReplyOrchestratorService } from "./reply-orchestrator.service";
import { ChannelAddressType } from "../types/AccountChannel";
import { SmsReplyTwilioInboundFormFields, SmsReplyInboundProcessOutcome, SmsReplyRecord } from "../types/SmsReply";

const SMS_INBOUND_PK_PREFIX = "SMS_INBOUND#";
const METADATA_SK = "METADATA";
const CONTACT_INFO_SK = "USER_CONTACT_INFO";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";
// Fresh requires strictly less than 7 days. Exactly 7 days (ageMs === window) is stale.
const SMS_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

function isConditionalCheckFailed(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === CONDITIONAL_CHECK_FAILED;
  }

  return false;
}

/**
 * Returns a redacted phone string for safe logging, e.g., "+1***1234".
 * Never logs the full phone number.
 */
function buildRedactedPhone(phone: string): string {
  // Keep the country code prefix (first 2 chars: "+" + 1st digit) and last 4 digits.
  if (phone.length <= 6) {
    return "+***";
  }

  const prefix = phone.slice(0, 2);
  const lastFour = phone.slice(-4);
  return `${prefix}***${lastFour}`;
}

@Injectable()
export class SmsReplyService {
  private readonly logger = new Logger(SmsReplyService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly twilioConfig: TwilioConfigService,
    private readonly chatSessionService: ChatSessionService,
    private readonly customerService: CustomerService,
    private readonly sessionService: SessionService,
    private readonly channelAddressService: ChannelAddressService,
    private readonly replyOrchestratorService: ReplyOrchestratorService,
  ) {}

  async processInboundMessage(
    formFields: SmsReplyTwilioInboundFormFields,
  ): Promise<SmsReplyInboundProcessOutcome> {
    const table = this.databaseConfig.conversationsTable;

    // Phase 1 — Resolve account by inbound Twilio number
    const lookup = await this.channelAddressService.getAccountByChannelAddress(
      ChannelAddressType.TWILIO_NUMBER,
      formFields.To,
    );

    if (lookup === null) {
      const redactedNumber = buildRedactedPhone(formFields.To);
      this.logger.warn(
        `[event=sms_inbound_unknown_number twilioNumber=${redactedNumber} outcome=rejected_unknown_account]`,
      );
      return "rejected_unknown_account";
    }

    const accountId = lookup.accountId;

    // Phase 2 — Phone format guard
    if (!E164_REGEX.test(formFields.From)) {
      this.logger.warn("[event=sms_inbound_bad_phone_format outcome=rejected_malformed]");
      return "rejected_malformed";
    }

    if (!formFields.Body || formFields.Body.trim() === "") {
      this.logger.warn("[event=sms_inbound_empty_body outcome=rejected_malformed]");
      return "rejected_malformed";
    }

    // Phase 3 — Dedupe via MessageSid
    const dedupeNow = new Date().toISOString();
    const dedupeItem = {
      PK: `${SMS_INBOUND_PK_PREFIX}${formFields.MessageSid}`,
      SK: METADATA_SK,
      processedAt: dedupeNow,
      sessionId: null,
      _createdAt_: dedupeNow,
      _lastUpdated_: dedupeNow,
    } satisfies SmsReplyRecord;

    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: table,
          Item: dedupeItem,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (error: unknown) {
      if (isConditionalCheckFailed(error)) {
        this.logger.debug(
          `[event=sms_inbound_duplicate messageSid=${formFields.MessageSid} outcome=duplicate]`,
        );
        return "duplicate";
      }

      throw error;
    }

    // Phase 4 — Sender lookup via GSI2
    const customerResult = await this.customerService.queryCustomerIdByPhone(
      table,
      accountId,
      formFields.From,
    );

    // Phase 5 — Route
    if (customerResult === null) {
      // Case 2: cold entry — sender phone unknown to this account
      return this.handleCase2NewSession(formFields, accountId, table);
    }

    const { customerUlid } = customerResult;
    // Capture prior latestSessionId before any write can update it
    const priorLatestSessionId = customerResult.latestSessionId;

    if (priorLatestSessionId === null) {
      return this.handleCase3StaleNewSession(customerUlid, null, formFields, accountId, table);
    }

    const priorMetadata = await this.dynamoDb.send(
      new GetCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${priorLatestSessionId}`,
          SK: METADATA_SK,
        },
      }),
    );

    if (!priorMetadata.Item) {
      this.logger.warn("[event=sms_case3_prior_session_not_found outcome=stale]");
      return this.handleCase3StaleNewSession(customerUlid, priorLatestSessionId, formFields, accountId, table);
    }

    const lastUpdatedStr = String(priorMetadata.Item._lastUpdated_ ?? "");
    const lastUpdated = new Date(lastUpdatedStr).getTime();

    if (isNaN(lastUpdated)) {
      this.logger.warn("[event=sms_case3_prior_session_bad_timestamp outcome=stale]");
      return this.handleCase3StaleNewSession(customerUlid, priorLatestSessionId, formFields, accountId, table);
    }

    const ageMs = Date.now() - lastUpdated;

    // Strictly less than 7 days = fresh. Exactly 7 days (ageMs === window) = stale.
    if (ageMs < SMS_CONTINUATION_FRESHNESS_WINDOW_MS) {
      return this.handleCase3FreshAttach(priorLatestSessionId, formFields, table);
    }

    return this.handleCase3StaleNewSession(customerUlid, priorLatestSessionId, formFields, accountId, table);
  }

  private async handleCase2NewSession(
    formFields: SmsReplyTwilioInboundFormFields,
    accountId: string,
    table: string,
  ): Promise<SmsReplyInboundProcessOutcome> {
    const sessionResult = await this.sessionService.lookupOrCreateSession("sms", null, "lead_capture", accountId);
    const sessionUlid = sessionResult.sessionUlid;

    // Backfill dedupe record with resolved sessionId for operational traceability
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `${SMS_INBOUND_PK_PREFIX}${formFields.MessageSid}`, SK: METADATA_SK },
        UpdateExpression: "SET sessionId = :sessionId, #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":sessionId": `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
          ":now": new Date().toISOString(),
        },
      }),
    );

    // Stamp phone on USER_CONTACT_INFO with if_not_exists semantics
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
          SK: CONTACT_INFO_SK,
        },
        UpdateExpression:
          "SET phone = if_not_exists(phone, :phone), _createdAt_ = if_not_exists(_createdAt_, :now), #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":phone": formFields.From,
          ":now": new Date().toISOString(),
        },
      }),
    );

    await this.chatSessionService.appendUserMessage(sessionUlid, "sms", formFields.Body);

    await this.replyOrchestratorService.generateAndSendReply(sessionUlid, "sms", {
      sms: { to: formFields.From, from: formFields.To },
    });

    this.logger.log(
      `[event=sms_assistant_entry_case2 sessionUlid=${sessionUlid} outcome=processed]`,
    );

    return "processed";
  }

  private async handleCase3FreshAttach(
    existingSessionUlid: string,
    formFields: SmsReplyTwilioInboundFormFields,
    table: string,
  ): Promise<SmsReplyInboundProcessOutcome> {
    const redacted = buildRedactedPhone(formFields.From);

    // Backfill dedupe record with resolved sessionId for operational traceability
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `${SMS_INBOUND_PK_PREFIX}${formFields.MessageSid}`, SK: METADATA_SK },
        UpdateExpression: "SET sessionId = :sessionId, #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":sessionId": `${CHAT_SESSION_PK_PREFIX}${existingSessionUlid}`,
          ":now": new Date().toISOString(),
        },
      }),
    );

    // Stamp phone with if_not_exists — defensive in case prior session has no phone recorded
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${existingSessionUlid}`,
          SK: CONTACT_INFO_SK,
        },
        UpdateExpression:
          "SET phone = if_not_exists(phone, :phone), _createdAt_ = if_not_exists(_createdAt_, :now), #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":phone": formFields.From,
          ":now": new Date().toISOString(),
        },
      }),
    );

    await this.chatSessionService.appendUserMessage(existingSessionUlid, "sms", formFields.Body);

    await this.replyOrchestratorService.generateAndSendReply(existingSessionUlid, "sms", {
      sms: { to: formFields.From, from: formFields.To },
    });

    this.logger.log(
      `[event=sms_assistant_entry_case3_fresh sessionUlid=${existingSessionUlid} sender=${redacted} outcome=processed]`,
    );

    return "processed";
  }

  private async handleCase3StaleNewSession(
    customerUlid: string,
    priorLatestSessionId: string | null,
    formFields: SmsReplyTwilioInboundFormFields,
    accountId: string,
    table: string,
  ): Promise<SmsReplyInboundProcessOutcome> {
    const sessionResult = await this.sessionService.lookupOrCreateSession("sms", null, "lead_capture", accountId);
    const newSessionUlid = sessionResult.sessionUlid;

    // Backfill dedupe record with resolved sessionId for operational traceability
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `${SMS_INBOUND_PK_PREFIX}${formFields.MessageSid}`, SK: METADATA_SK },
        UpdateExpression: "SET sessionId = :sessionId, #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":sessionId": `${CHAT_SESSION_PK_PREFIX}${newSessionUlid}`,
          ":now": new Date().toISOString(),
        },
      }),
    );

    const customerId = `C#${customerUlid}`;

    // Write METADATA with customer_id and continuation_from_session_id.
    // Intentionally does NOT include continuation_loaded_at so the downstream
    // if_not_exists(continuation_loaded_at, :now) write in chat-session.service.ts
    // succeeds on first fire. (Mirrors the May 5 email-path null-init fix.)
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `${CHAT_SESSION_PK_PREFIX}${newSessionUlid}`, SK: METADATA_SK },
        UpdateExpression:
          "SET customer_id = :customerId, continuation_from_session_id = :contFrom, #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":customerId": customerId,
          ":contFrom":
            priorLatestSessionId !== null ? `${CHAT_SESSION_PK_PREFIX}${priorLatestSessionId}` : null,
          ":now": new Date().toISOString(),
        },
      }),
    );

    // Stamp phone on USER_CONTACT_INFO with if_not_exists semantics
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${newSessionUlid}`,
          SK: CONTACT_INFO_SK,
        },
        UpdateExpression:
          "SET phone = if_not_exists(phone, :phone), _createdAt_ = if_not_exists(_createdAt_, :now), #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":phone": formFields.From,
          ":now": new Date().toISOString(),
        },
      }),
    );

    await this.chatSessionService.appendUserMessage(newSessionUlid, "sms", formFields.Body);

    await this.replyOrchestratorService.generateAndSendReply(newSessionUlid, "sms", {
      sms: { to: formFields.From, from: formFields.To },
    });

    this.logger.log(
      `[event=sms_assistant_entry_case3_stale sessionUlid=${newSessionUlid} outcome=processed]`,
    );

    return "processed";
  }
}
