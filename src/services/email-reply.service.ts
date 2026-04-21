import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { SendGridConfigService } from "./sendgrid-config.service";
import { EmailService } from "./email.service";
import { ChatSessionService } from "./chat-session.service";
import { EmailReplySendGridInboundFormFields, EmailReplyInboundProcessOutcome, EmailReplyRecord } from "../types/EmailReply";
import { stripQuotedReply } from "../utils/email/strip-quoted-reply";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MESSAGE_ID_HEADER_REGEX = /^Message-ID:\s*<(.+?)>$/m;
const EMAIL_ADDRESS_REGEX = /<([^>]+)>/;
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const EMAIL_INBOUND_PK_PREFIX = "EMAIL_INBOUND#";
const CONTACT_INFO_SK = "USER_CONTACT_INFO";
const METADATA_SK = "METADATA";

function isConditionalCheckFailed(error: unknown): boolean {
  if (error !== null && error !== undefined) {
    const record: { name?: unknown } = error;

    return record.name === CONDITIONAL_CHECK_FAILED;
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

@Injectable()
export class EmailReplyService {
  private readonly logger = new Logger(EmailReplyService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly sendGridConfig: SendGridConfigService,
    private readonly emailService: EmailService,
    private readonly chatSessionService: ChatSessionService,
  ) {}

  async processInboundReply(formFields: EmailReplySendGridInboundFormFields): Promise<EmailReplyInboundProcessOutcome> {
    const table = this.databaseConfig.conversationsTable;
    const replyDomain = this.sendGridConfig.replyDomain;

    const addresses = formFields.to.split(",");

    let localPart: string | undefined;

    for (const address of addresses) {
      const bare = EMAIL_ADDRESS_REGEX.exec(address.trim())?.[1] ?? address.trim();
      const atIndex = bare.indexOf("@");

      if (atIndex < 0) {
        continue;
      }

      const domain = bare.slice(atIndex + 1);

      if (domain.toLowerCase() === replyDomain.toLowerCase()) {
        localPart = bare.slice(0, atIndex);
        break;
      }
    }

    if (!localPart) {
      this.logger.warn("Inbound email has no recipient matching reply domain [outcome=rejected_malformed]");
      return "rejected_malformed";
    }

    if (!ULID_REGEX.test(localPart)) {
      this.logger.warn("Inbound email local-part is not a valid ULID [outcome=rejected_malformed]");
      return "rejected_malformed";
    }

    const sessionUlid = localPart;

    const rawHeaders = formFields.headers ?? "";
    const messageIdMatch = MESSAGE_ID_HEADER_REGEX.exec(rawHeaders);

    const messageId = messageIdMatch
      ? messageIdMatch[1]
      : createHash("sha256").update(formFields.from + (formFields.subject ?? "") + formFields.text).digest("hex");

    if (!messageIdMatch) {
      this.logger.debug(`No Message-ID header found, using hash fallback [sessionUlid=${sessionUlid}]`);
    }

    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: `${EMAIL_INBOUND_PK_PREFIX}${messageId}`,
            SK: METADATA_SK,
            processedAt: new Date().toISOString(),
            sessionUlid,
          } satisfies EmailReplyRecord,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (error) {
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
}
