import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { collectContactInfoInputSchema, CollectContactInfoInput } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const CONTACT_INFO_SK = "USER_CONTACT_INFO";

// [inputField (from the tool's input schema), dbAttribute (in DynamoDB), alias (ExpressionAttributeNames key)]
const FIELD_ENTRIES: [keyof CollectContactInfoInput, string, string][] = [
  ["firstName", "first_name", "fn"],
  ["lastName", "last_name", "ln"],
  ["email", "email", "em"],
  ["phone", "phone", "ph"],
  ["company", "company", "co"],
];

@ChatToolProvider()
@Injectable()
export class CollectContactInfoTool implements ChatTool {
  private readonly logger = new Logger(CollectContactInfoTool.name);

  readonly name = "collect_contact_info";

  readonly description =
    "Save or update contact information about the user. Call this whenever the user shares personal details like their name, email address, phone number, or company. You can call this multiple times to progressively build up the user's contact profile — each call updates only the fields you provide, leaving existing fields unchanged. Only include fields the user has actually provided in the current message; never fabricate or infer values.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {
      firstName: {
        type: "string",
        description: "The user's first name",
      },
      lastName: {
        type: "string",
        description: "The user's last name",
      },
      email: {
        type: "string",
        description: "The user's email address",
      },
      phone: {
        type: "string",
        description: "The user's phone number",
      },
      company: {
        type: "string",
        description: "The name of the company or organization the user belongs to",
      },
    },
  };

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    this.logger.debug(`Executing tool [name=collect_contact_info sessionUlid=${context.sessionUlid}]`);

    const parseResult = collectContactInfoInputSchema.safeParse(input);

    if (!parseResult.success) {
      return { result: `Invalid input: ${parseResult.error.message}`, isError: true };
    }

    const validated = parseResult.data;

    const definedEntries = FIELD_ENTRIES.filter(([field]) => validated[field] !== undefined);
    const providedFields = definedEntries.map(([field]) => field);

    this.logger.debug(
      `Collecting contact info [sessionUlid=${context.sessionUlid} fields=${providedFields.join(",")}]`,
    );

    const now = new Date().toISOString();
    const setParts: string[] = [];
    const expressionNames: Record<string, string> = {};
    const expressionValues: Record<string, unknown> = {};

    for (const [field, dbAttribute, alias] of FIELD_ENTRIES) {
      const value = validated[field];

      if (value !== undefined) {
        setParts.push(`#${alias} = :${alias}`);
        expressionNames[`#${alias}`] = dbAttribute;
        expressionValues[`:${alias}`] = value;
      }
    }

    setParts.push("#lastUpdated = :lastUpdated");
    setParts.push("#createdAt = if_not_exists(#createdAt, :now)");
    expressionNames["#lastUpdated"] = "_lastUpdated_";
    expressionNames["#createdAt"] = "_createdAt_";
    expressionValues[":lastUpdated"] = now;
    expressionValues[":now"] = now;

    const updateExpression = `SET ${setParts.join(", ")}`;

    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: this.databaseConfig.conversationsTable,
          Key: {
            PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
            SK: CONTACT_INFO_SK,
          },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
        }),
      );

      return { result: "Contact info saved successfully." };
    } catch (error) {
      this.logger.error(
        `collect_contact_info failed [sessionUlid=${context.sessionUlid} errorType=${error instanceof Error ? error.name : "unknown"}]`,
      );

      const message = error instanceof Error ? error.message : "unknown error";

      return { result: `Failed to save contact info: ${message}`, isError: true };
    }
  }
}
