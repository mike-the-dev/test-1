import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { EmailService } from "./email.service";
import { ChatSessionService } from "./chat-session.service";
import { CustomerService } from "./customer.service";
import { SessionService } from "./session.service";
import { ChannelAddressService } from "./channel-address.service";
import { ChannelAddressType } from "../types/AccountChannel";
import {
  EmailReplySendGridInboundFormFields,
  EmailReplyInboundProcessOutcome,
  EmailReplyRecord,
  EmailReplyLocalPartClassification,
} from "../types/EmailReply";
import { stripQuotedReply } from "../utils/email/strip-quoted-reply";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MESSAGE_ID_HEADER_REGEX = /^Message-ID:\s*<(.+?)>$/m;
const EMAIL_ADDRESS_REGEX = /<([^>]+)>/;
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const EMAIL_INBOUND_PK_PREFIX = "EMAIL_INBOUND#";
const CONTACT_INFO_SK = "USER_CONTACT_INFO";
const METADATA_SK = "METADATA";

// Fresh requires strictly less than 7 days. Exactly 7 days (ageMs === window) is stale.
const EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isConditionalCheckFailed(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === CONDITIONAL_CHECK_FAILED;
  }

  return false;
}

function wrapInHtml(text: string): string {
  const paragraphs = text.split("\n\n");

  return paragraphs
    .map((chunk) => {
      return `<p>${chunk}</p>`;
    })
    .join("\n");
}

function parseSenderEmail(fromField: string): string {
  const angleMatch = EMAIL_ADDRESS_REGEX.exec(fromField);

  if (angleMatch) {
    return angleMatch[1].toLowerCase();
  }

  return fromField.trim().toLowerCase();
}

function buildRedactedSender(email: string): string {
  const atIndex = email.indexOf("@");

  if (atIndex < 0) {
    return "***";
  }

  const domain = email.slice(atIndex + 1);
  const firstChar = email[0] ?? "*";

  return `${firstChar}***@${domain}`;
}

/**
 * Parses the first valid <localPart>@<domain> address from a comma-separated To: field.
 * Returns { localPart, domain } for the first parseable address, or null if none found.
 */
function parseFirstToAddress(toField: string): { localPart: string; domain: string } | null {
  const addresses = toField.split(",");

  for (const address of addresses) {
    const bare = EMAIL_ADDRESS_REGEX.exec(address.trim())?.[1] ?? address.trim();
    const atIndex = bare.indexOf("@");

    if (atIndex < 0) {
      continue;
    }

    const localPart = bare.slice(0, atIndex);
    const domain = bare.slice(atIndex + 1);

    if (localPart.length > 0 && domain.length > 0) {
      return { localPart, domain };
    }
  }

  return null;
}

@Injectable()
export class EmailReplyService {
  private readonly logger = new Logger(EmailReplyService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly emailService: EmailService,
    private readonly chatSessionService: ChatSessionService,
    private readonly customerService: CustomerService,
    private readonly sessionService: SessionService,
    private readonly channelAddressService: ChannelAddressService,
  ) {}

  private classifyLocalPart(localPart: string): EmailReplyLocalPartClassification {
    if (ULID_REGEX.test(localPart)) {
      return EmailReplyLocalPartClassification.SESSION_ULID;
    }
    return EmailReplyLocalPartClassification.DOMAIN_ROUTED;
  }

  private async deduplicateInboundEmail(
    formFields: EmailReplySendGridInboundFormFields,
    sessionUlidForLog: string | null,
    table: string,
  ): Promise<{ messageId: string } | "duplicate"> {
    const rawHeaders = formFields.headers ?? "";
    const messageIdMatch = MESSAGE_ID_HEADER_REGEX.exec(rawHeaders);

    const messageId = messageIdMatch
      ? messageIdMatch[1]
      : createHash("sha256").update(formFields.from + (formFields.subject ?? "") + formFields.text).digest("hex");

    if (!messageIdMatch) {
      this.logger.debug(`No Message-ID header found, using hash fallback [sessionUlid=${sessionUlidForLog}]`);
    }

    try {
      const dedupeNow = new Date().toISOString();
      await this.dynamoDb.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: `${EMAIL_INBOUND_PK_PREFIX}${messageId}`,
            SK: METADATA_SK,
            processedAt: dedupeNow,
            sessionId: sessionUlidForLog !== null ? `${CHAT_SESSION_PK_PREFIX}${sessionUlidForLog}` : null,
            _createdAt_: dedupeNow,
            _lastUpdated_: dedupeNow,
          } satisfies EmailReplyRecord,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (error: unknown) {
      if (isConditionalCheckFailed(error)) {
        this.logger.debug(`Duplicate inbound email detected [messageId=${messageId} outcome=duplicate]`);
        return "duplicate";
      }

      throw error;
    }

    return { messageId };
  }

  async processInboundReply(formFields: EmailReplySendGridInboundFormFields): Promise<EmailReplyInboundProcessOutcome> {
    const table = this.databaseConfig.conversationsTable;

    // Take the first parseable address from the To: field. In multi-address scenarios
    // (CC/BCC), the first address determines routing.
    const parsed = parseFirstToAddress(formFields.to);

    if (!parsed) {
      this.logger.warn("Inbound email has no parseable recipient address [outcome=rejected_malformed]");
      return "rejected_malformed";
    }

    const { localPart, domain } = parsed;

    const classification = this.classifyLocalPart(localPart);

    if (classification === EmailReplyLocalPartClassification.SESSION_ULID) {
      return this.handleCase1SessionUlid(localPart, formFields, table);
    }

    // DOMAIN_ROUTED — look up account by domain, then validate local-part
    return this.handleDomainRoutedEntry(formFields, localPart, domain, table);
  }

  private async handleCase1SessionUlid(
    sessionUlid: string,
    formFields: EmailReplySendGridInboundFormFields,
    table: string,
  ): Promise<EmailReplyInboundProcessOutcome> {
    const rawHeaders = formFields.headers ?? "";
    const messageIdMatch = MESSAGE_ID_HEADER_REGEX.exec(rawHeaders);

    const messageId = messageIdMatch
      ? messageIdMatch[1]
      : createHash("sha256").update(formFields.from + (formFields.subject ?? "") + formFields.text).digest("hex");

    if (!messageIdMatch) {
      this.logger.debug(`No Message-ID header found, using hash fallback [sessionUlid=${sessionUlid}]`);
    }

    try {
      const dedupeNow = new Date().toISOString();
      await this.dynamoDb.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: `${EMAIL_INBOUND_PK_PREFIX}${messageId}`,
            SK: METADATA_SK,
            processedAt: dedupeNow,
            sessionId: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
            _createdAt_: dedupeNow,
            _lastUpdated_: dedupeNow,
          } satisfies EmailReplyRecord,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (error: unknown) {
      if (isConditionalCheckFailed(error)) {
        this.logger.debug(`Duplicate inbound email detected [messageId=${messageId} outcome=duplicate]`);
        return "duplicate";
      }

      throw error;
    }

    const senderEmail = parseSenderEmail(formFields.from);

    const contactResult = await this.dynamoDb.send(
      new GetCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
          SK: CONTACT_INFO_SK,
        },
      }),
    );

    if (!contactResult.Item) {
      this.logger.warn(`No contact info for session [sessionUlid=${sessionUlid} outcome=rejected_unknown_session]`);
      return "rejected_unknown_session";
    }

    const storedEmail = contactResult.Item.email ?? "";

    if (storedEmail.toLowerCase() !== senderEmail) {
      const redacted = buildRedactedSender(senderEmail);
      this.logger.warn(`Sender mismatch [sessionUlid=${sessionUlid} sender=${redacted} outcome=rejected_sender_mismatch]`);
      return "rejected_sender_mismatch";
    }

    const cleanBody = stripQuotedReply(formFields.text);

    if (cleanBody === "") {
      this.logger.warn(`Empty body after stripping [sessionUlid=${sessionUlid} outcome=rejected_malformed reason=empty_after_strip]`);
      return "rejected_malformed";
    }

    const { reply: assistantText } = await this.chatSessionService.handleMessage(sessionUlid, cleanBody);

    const rawSubject = formFields.subject ?? "";
    const replySubject = rawSubject.startsWith("Re:") ? rawSubject : `Re: ${rawSubject}`;

    await this.emailService.send({
      to: senderEmail,
      subject: replySubject,
      body: wrapInHtml(assistantText),
      sessionUlid,
      inReplyToMessageId: messageId,
      referencesMessageId: messageId,
    });

    this.logger.log(`Inbound reply processed [sessionUlid=${sessionUlid} outcome=processed]`);

    return "processed";
  }

  private async handleDomainRoutedEntry(
    formFields: EmailReplySendGridInboundFormFields,
    localPart: string,
    domain: string,
    table: string,
  ): Promise<EmailReplyInboundProcessOutcome> {
    // Step 1 — Resolve account by inbound reply domain
    const lookup = await this.channelAddressService.getAccountByChannelAddress(
      ChannelAddressType.EMAIL_REPLY_DOMAIN,
      domain,
    );

    if (lookup === null) {
      this.logger.warn(
        `[event=email_inbound_unknown_domain domain=${domain} outcome=rejected_unknown_account]`,
      );
      return "rejected_unknown_account";
    }

    const accountUlid = lookup.accountId;

    // Step 2 — GetItem the account record to validate status and read channels.email config
    const accountResult = await this.dynamoDb.send(
      new GetCommand({
        TableName: table,
        Key: { PK: `A#${accountUlid}`, SK: `A#${accountUlid}` },
      }),
    );

    const account = accountResult.Item;

    if (!account || account.entity !== "ACCOUNT" || account.status?.is_active !== true) {
      this.logger.warn(
        `[event=email_inbound_account_inactive accountUlid=${accountUlid} outcome=rejected_unknown_account]`,
      );
      return "rejected_unknown_account";
    }

    // Step 3 — Validate local-part against the account's configured reply_local_part
    const expectedLocalPart: string = account.channels?.email?.reply_local_part ?? "assistant";

    if (localPart.toLowerCase() !== expectedLocalPart.toLowerCase()) {
      this.logger.warn(
        `[event=email_inbound_unknown_local_part accountUlid=${accountUlid} outcome=rejected_unknown_local_part]`,
      );
      return "rejected_unknown_local_part";
    }

    const replyDomain = domain;
    const fromName: string = account.channels?.email?.from_name ?? "";

    const dedupResult = await this.deduplicateInboundEmail(formFields, null, table);

    if (dedupResult === "duplicate") {
      return "duplicate";
    }

    const { messageId } = dedupResult;

    const senderEmail = parseSenderEmail(formFields.from);

    const customerResult = await this.customerService.queryCustomerIdByEmail(table, accountUlid, senderEmail);

    if (customerResult === null) {
      this.logger.log("[event=email_domain_routed_new_visitor outcome=case2]");
      return this.handleCase2NewSession(formFields, messageId, senderEmail, accountUlid, replyDomain, fromName, table);
    }

    const { customerUlid, latestSessionId } = customerResult;

    // Capture the prior latestSessionId before any per-turn write could
    // update customer.latest_session_id to a new session value.
    const capturedPriorLatestSessionId = latestSessionId;

    if (!capturedPriorLatestSessionId) {
      return this.handleCase3StaleNewSession(
        customerUlid,
        null,
        formFields,
        messageId,
        senderEmail,
        accountUlid,
        replyDomain,
        fromName,
        table,
      );
    }

    const priorMetadata = await this.dynamoDb.send(
      new GetCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${capturedPriorLatestSessionId}`,
          SK: METADATA_SK,
        },
      }),
    );

    if (!priorMetadata.Item) {
      this.logger.warn("[event=email_case3_prior_session_not_found outcome=stale]");
      return this.handleCase3StaleNewSession(
        customerUlid,
        capturedPriorLatestSessionId,
        formFields,
        messageId,
        senderEmail,
        accountUlid,
        replyDomain,
        fromName,
        table,
      );
    }

    const lastUpdatedStr: string = priorMetadata.Item._lastUpdated_ ?? "";
    const lastUpdated = new Date(lastUpdatedStr).getTime();

    if (isNaN(lastUpdated)) {
      this.logger.warn("[event=email_case3_prior_session_bad_timestamp outcome=stale]");
      return this.handleCase3StaleNewSession(
        customerUlid,
        capturedPriorLatestSessionId,
        formFields,
        messageId,
        senderEmail,
        accountUlid,
        replyDomain,
        fromName,
        table,
      );
    }

    const ageMs = Date.now() - lastUpdated;

    // Strictly less than 7 days = fresh. Exactly 7 days (ageMs === window) = stale.
    if (ageMs < EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS) {
      return this.handleCase3FreshAttach(capturedPriorLatestSessionId, formFields, messageId, senderEmail, replyDomain, fromName, table);
    }

    return this.handleCase3StaleNewSession(
      customerUlid,
      capturedPriorLatestSessionId,
      formFields,
      messageId,
      senderEmail,
      accountUlid,
      replyDomain,
      fromName,
      table,
    );
  }

  private async handleCase2NewSession(
    formFields: EmailReplySendGridInboundFormFields,
    messageId: string,
    senderEmail: string,
    accountId: string,
    replyDomain: string,
    fromName: string,
    table: string,
  ): Promise<EmailReplyInboundProcessOutcome> {
    const sessionResult = await this.sessionService.lookupOrCreateSession("email", null, "lead_capture", accountId);
    const sessionUlid = sessionResult.sessionUlid;

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
          SK: CONTACT_INFO_SK,
        },
        UpdateExpression: "SET email = if_not_exists(email, :email)",
        ExpressionAttributeValues: { ":email": senderEmail },
      }),
    );

    const cleanBody = stripQuotedReply(formFields.text);

    if (cleanBody === "") {
      this.logger.warn(`[event=email_domain_routed_case2 sessionUlid=${sessionUlid} outcome=rejected_malformed reason=empty_after_strip]`);
      return "rejected_malformed";
    }

    const { reply: assistantText } = await this.chatSessionService.handleMessage(sessionUlid, cleanBody);

    const rawSubject = formFields.subject ?? "";
    const replySubject = rawSubject.startsWith("Re:") ? rawSubject : `Re: ${rawSubject}`;

    await this.emailService.send({
      to: senderEmail,
      subject: replySubject,
      body: wrapInHtml(assistantText),
      sessionUlid,
      replyDomain,
      fromName,
      inReplyToMessageId: messageId,
      referencesMessageId: messageId,
    });

    this.logger.log(`[event=email_domain_routed_case2 sessionUlid=${sessionUlid} outcome=processed]`);

    return "processed";
  }

  private async handleCase3FreshAttach(
    existingSessionUlid: string,
    formFields: EmailReplySendGridInboundFormFields,
    messageId: string,
    senderEmail: string,
    replyDomain: string,
    fromName: string,
    table: string,
  ): Promise<EmailReplyInboundProcessOutcome> {
    const contactResult = await this.dynamoDb.send(
      new GetCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${existingSessionUlid}`,
          SK: CONTACT_INFO_SK,
        },
      }),
    );

    if (!contactResult.Item) {
      this.logger.warn(
        `[event=email_domain_routed_case3_fresh sessionUlid=${existingSessionUlid} outcome=rejected_unknown_session]`,
      );
      return "rejected_unknown_session";
    }

    const storedEmail: string = contactResult.Item.email ?? "";

    if (storedEmail.toLowerCase() !== senderEmail) {
      const redacted = buildRedactedSender(senderEmail);
      this.logger.warn(
        `[event=email_domain_routed_case3_fresh sessionUlid=${existingSessionUlid} sender=${redacted} outcome=rejected_sender_mismatch]`,
      );
      return "rejected_sender_mismatch";
    }

    const cleanBody = stripQuotedReply(formFields.text);

    if (cleanBody === "") {
      this.logger.warn(
        `[event=email_domain_routed_case3_fresh sessionUlid=${existingSessionUlid} outcome=rejected_malformed reason=empty_after_strip]`,
      );
      return "rejected_malformed";
    }

    const { reply: assistantText } = await this.chatSessionService.handleMessage(existingSessionUlid, cleanBody);

    const rawSubject = formFields.subject ?? "";
    const replySubject = rawSubject.startsWith("Re:") ? rawSubject : `Re: ${rawSubject}`;

    await this.emailService.send({
      to: senderEmail,
      subject: replySubject,
      body: wrapInHtml(assistantText),
      sessionUlid: existingSessionUlid,
      replyDomain,
      fromName,
      inReplyToMessageId: messageId,
      referencesMessageId: messageId,
    });

    this.logger.log(`[event=email_domain_routed_case3_fresh sessionUlid=${existingSessionUlid} outcome=processed]`);

    return "processed";
  }

  private async handleCase3StaleNewSession(
    customerUlid: string,
    priorLatestSessionId: string | null,
    formFields: EmailReplySendGridInboundFormFields,
    messageId: string,
    senderEmail: string,
    accountId: string,
    replyDomain: string,
    fromName: string,
    table: string,
  ): Promise<EmailReplyInboundProcessOutcome> {
    const sessionResult = await this.sessionService.lookupOrCreateSession("email", null, "lead_capture", accountId);
    const newSessionUlid = sessionResult.sessionUlid;

    const customerId = `C#${customerUlid}`;

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `${CHAT_SESSION_PK_PREFIX}${newSessionUlid}`, SK: METADATA_SK },
        UpdateExpression:
          "SET customer_id = :customerId, continuation_from_session_id = :contFrom, #lastUpdated = :now",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: {
          ":customerId": customerId,
          ":contFrom": priorLatestSessionId !== null ? `${CHAT_SESSION_PK_PREFIX}${priorLatestSessionId}` : null,
          ":now": new Date().toISOString(),
        },
      }),
    );

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: {
          PK: `${CHAT_SESSION_PK_PREFIX}${newSessionUlid}`,
          SK: CONTACT_INFO_SK,
        },
        UpdateExpression: "SET email = if_not_exists(email, :email)",
        ExpressionAttributeValues: { ":email": senderEmail },
      }),
    );

    const cleanBody = stripQuotedReply(formFields.text);

    if (cleanBody === "") {
      this.logger.warn(
        `[event=email_domain_routed_case3_stale sessionUlid=${newSessionUlid} outcome=rejected_malformed reason=empty_after_strip]`,
      );
      return "rejected_malformed";
    }

    const { reply: assistantText } = await this.chatSessionService.handleMessage(newSessionUlid, cleanBody);

    const rawSubject = formFields.subject ?? "";
    const replySubject = rawSubject.startsWith("Re:") ? rawSubject : `Re: ${rawSubject}`;

    await this.emailService.send({
      to: senderEmail,
      subject: replySubject,
      body: wrapInHtml(assistantText),
      sessionUlid: newSessionUlid,
      replyDomain,
      fromName,
      inReplyToMessageId: messageId,
      referencesMessageId: messageId,
    });

    this.logger.log(`[event=email_domain_routed_case3_stale sessionUlid=${newSessionUlid} outcome=processed]`);

    return "processed";
  }
}
