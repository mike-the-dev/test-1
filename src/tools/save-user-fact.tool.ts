import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { saveUserFactInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const USER_FACT_SK_PREFIX = "USER_FACT#";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";

@ChatToolProvider()
@Injectable()
export class SaveUserFactTool implements ChatTool {
  private readonly logger = new Logger(SaveUserFactTool.name);

  readonly name = "save_user_fact";

  readonly description =
    "Save a fact about the user for long-term memory. Use this when the user shares personal information, preferences, or context worth remembering across conversations. Provide a short snake_case key such as 'employer' or 'favorite_color' and a concise value. Do not use this for temporary conversational context — only for stable facts the user would expect to be remembered.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Snake_case identifier for the fact, e.g. 'employer'",
      },
      value: {
        type: "string",
        description: "Concise value for the fact",
      },
    },
    required: ["key", "value"],
  };

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    this.logger.debug(`Executing tool [name=save_user_fact sessionUlid=${context.sessionUlid}]`);

    const parseResult = saveUserFactInputSchema.safeParse(input);

    if (!parseResult.success) {
      const summary = parseResult.error.issues.map((issue) => issue.message).join(", ");

      return { result: `Invalid input: ${summary}`, isError: true };
    }

    const parsed = parseResult.data;

    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: this.databaseConfig.conversationsTable,
          Item: {
            PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
            SK: `${USER_FACT_SK_PREFIX}${parsed.key}`,
            value: parsed.value,
            updatedAt: new Date().toISOString(),
          },
        }),
      );

      return { result: "Fact saved successfully." };
    } catch (error) {
      this.logger.error(`SaveUserFactTool DynamoDB write failed [sessionUlid=${context.sessionUlid}]`, error);

      const message = error instanceof Error ? error.message : "unknown error";

      return { result: `Failed to save fact: ${message}`, isError: true };
    }
  }
}
