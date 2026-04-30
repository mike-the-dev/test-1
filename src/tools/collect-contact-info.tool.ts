import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { CustomerService } from "../services/customer.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { CollectContactInfoTrioCompletedResult, CollectContactInfoSavedResult } from "../types/ChatSession";
import { collectContactInfoInputSchema, CollectContactInfoInput } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const CONTACT_INFO_SK = "USER_CONTACT_INFO";
const METADATA_SK = "METADATA";
const CUSTOMER_PK_PREFIX = "C#";

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
    private readonly customerService: CustomerService,
  ) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    this.logger.debug(`Executing tool [name=collect_contact_info sessionUlid=${context.sessionUlid}]`);

    // Step 1 — Validate input
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

    // Step 2 — UpdateCommand USER_CONTACT_INFO (runs unconditionally for all valid inputs)
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
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const message = error instanceof Error ? error.message : "unknown error";

      this.logger.error(
        `collect_contact_info failed [sessionUlid=${context.sessionUlid} errorType=${errorName}]`,
      );

      return { result: `Failed to save contact info: ${message}`, isError: true };
    }

    // Step 3 — Read USER_CONTACT_INFO post-write and read metadata.customer_id
    let contactItem: Record<string, unknown> | undefined;
    let existingCustomerId: unknown;

    try {
      const contactResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: this.databaseConfig.conversationsTable,
          Key: {
            PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
            SK: CONTACT_INFO_SK,
          },
        }),
      );

      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: this.databaseConfig.conversationsTable,
          Key: {
            PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
            SK: METADATA_SK,
          },
        }),
      );

      contactItem = contactResult.Item;
      existingCustomerId = metadataResult.Item?.customer_id;
    } catch (readError: unknown) {
      const errorName = readError instanceof Error ? readError.name : "UnknownError";
      this.logger.error(
        `[event=collect_contact_info_post_write_read_failed sessionUlid=${context.sessionUlid} errorType=${errorName}]`,
      );
      return { result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) };
    }

    // Step 4 — Trio-completion gate

    // Truthy coercion intentionally treats empty string "" as missing
    // (a saved-but-empty field must not pass the trio-completion gate).
    const firstName = contactItem?.first_name ? String(contactItem.first_name) : null;
    const lastName = contactItem?.last_name ? String(contactItem.last_name) : null;
    const email = contactItem?.email ? String(contactItem.email) : null;
    const phone = contactItem?.phone ? String(contactItem.phone) : null;

    const trioComplete =
      firstName !== null && firstName !== "" &&
      lastName !== null && lastName !== "" &&
      email !== null && email !== "";

    const customerIdAlreadySet =
      existingCustomerId !== null && existingCustomerId !== undefined;

    if (!trioComplete || customerIdAlreadySet) {
      return { result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) };
    }

    // Step 5 — Call CustomerService.lookupOrCreateCustomer
    if (!context.accountUlid) {
      this.logger.debug(
        `[event=collect_contact_info_no_account_ulid sessionUlid=${context.sessionUlid}]`,
      );
    }

    const customerResult = await this.customerService.lookupOrCreateCustomer({
      tableName: this.databaseConfig.conversationsTable,
      accountUlid: context.accountUlid ?? "",
      email: email,
      firstName: firstName,
      lastName: lastName,
      phone: phone,
    });

    if (customerResult.isError) {
      this.logger.error(
        `[event=collect_contact_info_link_failed sessionUlid=${context.sessionUlid}]`,
      );
      return { result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) };
    }

    // Step 6 — UpdateCommand METADATA with if_not_exists semantics
    const customerId = `${CUSTOMER_PK_PREFIX}${customerResult.customerUlid}`;

    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: this.databaseConfig.conversationsTable,
          Key: {
            PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
            SK: METADATA_SK,
          },
          UpdateExpression:
            "SET #customer_id = if_not_exists(#customer_id, :customer_id), #lastUpdated = :now",
          ExpressionAttributeNames: {
            "#customer_id": "customer_id",
            "#lastUpdated": "_lastUpdated_",
          },
          ExpressionAttributeValues: {
            ":customer_id": customerId,
            ":now": new Date().toISOString(),
          },
        }),
      );
    } catch (metaError: unknown) {
      const errorName = metaError instanceof Error ? metaError.name : "UnknownError";
      this.logger.error(
        `[event=collect_contact_info_link_failed sessionUlid=${context.sessionUlid} errorType=${errorName}]`,
      );
      return { result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) };
    }

    // Step 7 — Return structured result
    const customerFound = !customerResult.created;

    return {
      result: JSON.stringify(
        { saved: true, customerFound } satisfies CollectContactInfoTrioCompletedResult,
      ),
    };
  }
}
