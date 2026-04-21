import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { GuestCartCheckoutBaseResult } from "../types/GuestCart";
import { generateCheckoutLinkInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const METADATA_SK = "METADATA";

@ChatToolProvider()
@Injectable()
export class GenerateCheckoutLinkTool implements ChatTool {
  private readonly logger = new Logger(GenerateCheckoutLinkTool.name);
  private readonly checkoutBaseUrlOverride: string | null;

  readonly name = "generate_checkout_link";

  readonly description =
    "Generate the final checkout URL from the visitor's current cart and return it for you to present. Call this ONLY after the visitor has explicitly confirmed the cart preview looks correct. Do not call this before preview_cart has run. Do not call this speculatively or before the visitor has committed — this is the terminal action of the conversation. Takes no arguments. After calling, present the URL to the visitor as the final message and stop the conversation.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly configService: ConfigService,
  ) {
    this.checkoutBaseUrlOverride =
      this.configService.get<string>("webChat.checkoutBaseUrlOverride", { infer: true }) ?? null;
  }

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    const { sessionUlid, accountUlid } = context;

    this.logger.debug(
      `Executing tool [name=generate_checkout_link sessionUlid=${sessionUlid} accountUlid=${accountUlid ?? "null"}]`,
    );

    // Step 1 — validate input
    const parseResult = generateCheckoutLinkInputSchema.safeParse(input);

    if (!parseResult.success) {
      return { result: `Invalid input: ${parseResult.error.message}`, isError: true };
    }

    // Step 2 — check account context
    if (!accountUlid) {
      return { result: "Missing account context — cannot generate checkout link.", isError: true };
    }

    const tableName = this.databaseConfig.conversationsTable;

    // Step 3 — read METADATA
    let cart_id: string | undefined;
    let guest_id: string | undefined;
    let customer_id: string | undefined;
    let customer_email: string | undefined;

    try {
      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
            SK: METADATA_SK,
          },
        }),
      );

      const metadataItem = metadataResult.Item;

      // Step 4 — guard missing or incomplete METADATA
      if (!metadataItem) {
        return {
          result: "No cart has been previewed yet. Call preview_cart first with the visitor's selected items.",
          isError: true,
        };
      }

      cart_id = metadataItem.cart_id !== undefined ? String(metadataItem.cart_id) : undefined;
      guest_id = metadataItem.guest_id !== undefined ? String(metadataItem.guest_id) : undefined;
      customer_id = metadataItem.customer_id !== undefined ? String(metadataItem.customer_id) : undefined;
      customer_email = metadataItem.customer_email !== undefined ? String(metadataItem.customer_email) : undefined;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `generate_checkout_link metadata fetch failed [errorType=${errorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem generating the checkout link. Please ask the visitor to try again in a moment.", isError: true };
    }

    if (!cart_id || !guest_id || !customer_id || !customer_email) {
      return {
        result: "No cart has been previewed yet. Call preview_cart first with the visitor's selected items.",
        isError: true,
      };
    }

    // Step 5 — resolve checkout base URL
    const baseResult = await this.resolveCheckoutBase(tableName, accountUlid, sessionUlid);

    if (baseResult.isError) {
      return { result: baseResult.error, isError: true };
    }

    // Step 6 — construct checkout URL
    const checkout_url = `${baseResult.base}/checkout?email=${encodeURIComponent(customer_email)}&customerId=${customer_id}&guestId=${guest_id}&cartId=${cart_id}&aiSessionId=${encodeURIComponent(sessionUlid)}`;

    // Step 7 — return result
    return {
      result: JSON.stringify({ checkout_url, cart_id }),
    };
  }

  private async resolveCheckoutBase(
    tableName: string,
    accountUlid: string,
    sessionUlid: string,
  ): Promise<GuestCartCheckoutBaseResult> {
    if (this.checkoutBaseUrlOverride !== null && this.checkoutBaseUrlOverride !== "") {
      const base = this.checkoutBaseUrlOverride.replace(/\/+$/, "");
      this.logger.debug(`URL path [sessionUlid=${sessionUlid} path=override]`);
      return { isError: false, base };
    }

    try {
      const accountResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `A#${accountUlid}`,
            SK: `A#${accountUlid}`,
          },
        }),
      );

      const accountItem = accountResult.Item;
      const gsi1pk = accountItem ? String(accountItem["GSI1-PK"] ?? "") : "";

      if (!gsi1pk.startsWith("DOMAIN#")) {
        this.logger.error(
          `generate_checkout_link account GSI1-PK missing or malformed [errorType=MalformedAccountRecord sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
        return {
          isError: true,
          error: "We hit a problem generating the checkout link. Please ask the visitor to try again in a moment.",
        };
      }

      const host = gsi1pk.slice("DOMAIN#".length);
      const base = `https://${host}`;
      this.logger.debug(`URL path [sessionUlid=${sessionUlid} path=account_domain]`);
      return { isError: false, base };
    } catch (accountError: unknown) {
      const accountErrorName = accountError instanceof Error ? accountError.name : "UnknownError";
      this.logger.error(
        `generate_checkout_link account get failed [errorType=${accountErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return {
        isError: true,
        error: "We hit a problem generating the checkout link. Please ask the visitor to try again in a moment.",
      };
    }
  }
}
