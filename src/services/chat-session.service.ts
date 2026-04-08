import { Injectable, Inject } from "@nestjs/common";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { AnthropicService } from "./anthropic.service";
import { DatabaseConfigService } from "./database-config.service";
import { ChatSessionMessage, ChatSessionMessageRecord } from "../types/ChatSession";

const MAX_HISTORY_MESSAGES = 50;
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const MESSAGE_SK_PREFIX = "MESSAGE#";
const METADATA_SK = "METADATA";

@Injectable()
export class ChatSessionService {
  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly anthropicService: AnthropicService,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async handleMessage(sessionUlid: string, userMessage: string): Promise<string> {
    const table = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    const historyResult = await this.dynamoDb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": sessionPk,
          ":skPrefix": MESSAGE_SK_PREFIX,
        },
        ScanIndexForward: false,
        Limit: MAX_HISTORY_MESSAGES,
      }),
    );

    const items = historyResult.Items ?? [];
    const reversedItems = [...items].reverse();

    const history: ChatSessionMessage[] = reversedItems.map((item) => {
      return { role: item.role, content: item.content };
    });

    history.push({ role: "user", content: userMessage });

    const reply = await this.anthropicService.sendMessage(history);

    const now = new Date().toISOString();

    await this.dynamoDb.send(
      new PutCommand({
        TableName: table,
        Item: {
          PK: sessionPk,
          SK: `${MESSAGE_SK_PREFIX}${ulid()}`,
          role: "user",
          content: userMessage,
          createdAt: now,
        } satisfies ChatSessionMessageRecord,
      }),
    );

    await this.dynamoDb.send(
      new PutCommand({
        TableName: table,
        Item: {
          PK: sessionPk,
          SK: `${MESSAGE_SK_PREFIX}${ulid()}`,
          role: "assistant",
          content: reply,
          createdAt: now,
        } satisfies ChatSessionMessageRecord,
      }),
    );

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: sessionPk, SK: METADATA_SK },
        UpdateExpression: "SET createdAt = if_not_exists(createdAt, :now), lastMessageAt = :now",
        ExpressionAttributeValues: { ":now": now },
      }),
    );

    return reply;
  }
}
