import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { ChatSessionMessageRecord } from "../types/ChatSession";
import { ChatContentBlock } from "../types/ChatContent";
import { WebChatHistoryMessage } from "../types/WebChat";

const MAX_HISTORY_MESSAGES = 50;
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const MESSAGE_SK_PREFIX = "MESSAGE#";
const METADATA_SK = "METADATA";

// Shared convention between frontend and backend: the frontend auto-sends this
// exact string as a user message after onboarding completes so the agent can
// open the conversation with a greeting. Both sides hide this message from
// the visible UI — it exists only to satisfy Anthropic's user-first message
// requirement and to trigger the agent's opening turn. Do not change this
// string without a coordinated frontend update.
const SESSION_KICKOFF_MARKER = "__SESSION_KICKOFF__";

@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async appendUserMessage(
    sessionUlid: string,
    channel: "web" | "sms" | "email",
    text: string,
    emailContext?: { messageId: string; subject: string; replyDomain: string; fromName: string },
  ): Promise<void> {
    const table = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;
    const now = new Date().toISOString();

    await this.dynamoDb.send(
      new PutCommand({
        TableName: table,
        Item: {
          PK: sessionPk,
          SK: `${MESSAGE_SK_PREFIX}${ulid()}`,
          role: "user",
          content: JSON.stringify([{ type: "text", text }]),
          channel,
          _createdAt_: now,
        } satisfies ChatSessionMessageRecord,
      }),
    );

    if (emailContext) {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: sessionPk, SK: METADATA_SK },
          UpdateExpression:
            "SET #createdAt = if_not_exists(#createdAt, :now), #lastUpdated = :now, last_inbound_email_message_id = :mid, last_inbound_email_subject = :sub, reply_domain = :rd, from_name = :fn",
          ExpressionAttributeNames: {
            "#createdAt": "_createdAt_",
            "#lastUpdated": "_lastUpdated_",
          },
          ExpressionAttributeValues: {
            ":now": now,
            ":mid": emailContext.messageId,
            ":sub": emailContext.subject,
            ":rd": emailContext.replyDomain,
            ":fn": emailContext.fromName,
          },
        }),
      );

      return;
    }

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: sessionPk, SK: METADATA_SK },
        UpdateExpression: "SET #createdAt = if_not_exists(#createdAt, :now), #lastUpdated = :now",
        ExpressionAttributeNames: { "#createdAt": "_createdAt_", "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: { ":now": now },
      }),
    );
  }

  async getHistoryForClient(sessionUlid: string): Promise<WebChatHistoryMessage[]> {
    const table = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": sessionPk,
          ":skPrefix": MESSAGE_SK_PREFIX,
        },
        ScanIndexForward: true,
      }),
    );

    const items = result.Items ?? [];
    const history: WebChatHistoryMessage[] = [];

    for (const item of items) {
      const role = item.role;

      if (role !== "user" && role !== "assistant") {
        continue;
      }

      let blocks: ChatContentBlock[];

      try {
        blocks = JSON.parse(item.content);
      } catch {
        blocks = [{ type: "text", text: item.content }];
      }

      const textParts: string[] = [];

      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }

      const content = textParts.join("\n\n").trim();

      if (!content) {
        continue;
      }

      if (content === SESSION_KICKOFF_MARKER) {
        continue;
      }

      const rawSk = typeof item.SK === "string" ? item.SK : "";
      const id = rawSk.startsWith(MESSAGE_SK_PREFIX) ? rawSk.slice(MESSAGE_SK_PREFIX.length) : rawSk;

      history.push({
        id,
        role,
        content,
        timestamp: item._createdAt_,
      });
    }

    return history;
  }
}
