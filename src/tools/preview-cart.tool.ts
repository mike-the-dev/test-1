import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  NativeAttributeValue,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import {
  GuestCartCustomerRecord,
  GuestCartCustomerResult,
  GuestCartItem,
} from "../types/GuestCart";
import { previewCartInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";
import { SlackAlertService } from "../services/slack-alert.service";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const USER_CONTACT_INFO_SK = "USER_CONTACT_INFO";
const METADATA_SK = "METADATA";

function toRecordArray(value: NativeAttributeValue | undefined): Record<string, NativeAttributeValue>[] {
  if (!value) {
    return [];
  }
  const candidate: Record<string, NativeAttributeValue>[] = value as Record<string, NativeAttributeValue>[];
  if (!Number.isInteger(candidate.length)) {
    return [];
  }
  return candidate;
}

function toNativeArray(value: NativeAttributeValue | undefined): NativeAttributeValue[] {
  if (!value) {
    return [];
  }
  const candidate: NativeAttributeValue[] = value as NativeAttributeValue[];
  if (!Number.isInteger(candidate.length)) {
    return [];
  }
  return candidate;
}

function resolveServicePrice(raw: NativeAttributeValue | undefined): number {
  if (raw !== null && raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

@ChatToolProvider()
@Injectable()
export class PreviewCartTool implements ChatTool {
  private readonly logger = new Logger(PreviewCartTool.name);
  private readonly gsiName: string;

  readonly name = "preview_cart";

  readonly emitLatestOnly = true;

  readonly description =
    "Build or replace the visitor's cart with the items they've committed to, and return a structured preview of what's in the cart for them to confirm before checkout. Call this any time the visitor adds items, changes items, or decides to modify their selection. Pass every item currently intended for the cart (not just new ones) — calling this tool REPLACES the cart contents with the items you pass. After calling, present the structured preview to the visitor and ask them to confirm the cart looks correct. Do NOT call generate_checkout_link until the visitor has explicitly confirmed.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            service_id: {
              type: "string",
              description: "The full service_id from a list_services result, including the S# prefix.",
            },
            variant_id: {
              type: "string",
              description:
                "Required only when the service has variants. Use the variant_id from the list_services response.",
            },
            option_id: {
              type: "string",
              description:
                "Required only when the service has variants. Use the option_id from the list_services response that matches the option the visitor chose.",
            },
            quantity: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "Number of this service. Default 1 if the visitor did not specify.",
            },
          },
          required: ["service_id"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
    private readonly configService: ConfigService,
    private readonly slackAlertService: SlackAlertService,
  ) {
    this.gsiName =
      this.configService.get<string>("webChat.domainGsiName", { infer: true }) ?? "GSI1";
  }

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    const { sessionUlid, accountUlid } = context;

    this.logger.debug(
      `Executing tool [name=preview_cart sessionUlid=${sessionUlid} accountUlid=${accountUlid ?? "null"}]`,
    );

    // Step 1 — validate input
    const parseResult = previewCartInputSchema.safeParse(input);

    if (!parseResult.success) {
      return { result: `Invalid input: ${parseResult.error.message}`, isError: true };
    }

    const validated = parseResult.data;

    // Step 2 — check account context
    if (!accountUlid) {
      return { result: "Missing account context — cannot preview cart.", isError: true };
    }

    const tableName = this.databaseConfig.conversationsTable;

    // Step 3 — load contact info
    let email: string;
    let firstName: string;
    let lastName: string;
    let phone: string | null;

    try {
      const contactResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
            SK: USER_CONTACT_INFO_SK,
          },
        }),
      );

      const contactItem = contactResult.Item;

      if (!contactItem || !contactItem.email || contactItem.email === "") {
        return {
          result:
            "Missing visitor contact info. Please collect the visitor's email, first name, and last name via collect_contact_info before creating a cart.",
          isError: true,
        };
      }

      email = String(contactItem.email);
      firstName = String(contactItem.first_name ?? "");
      lastName = String(contactItem.last_name ?? "");
      phone = contactItem.phone !== undefined ? String(contactItem.phone) : null;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `preview_cart contact info fetch failed [errorType=${errorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Step 4 — read METADATA for existing cart/guest/customer IDs
    let metadataCartId: string | undefined;
    let metadataGuestId: string | undefined;
    let metadataCustomerId: string | undefined;
    let metadataCustomerEmail: string | undefined;

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

      if (metadataItem) {
        metadataCartId = metadataItem.cart_id !== undefined ? String(metadataItem.cart_id) : undefined;
        metadataGuestId = metadataItem.guest_id !== undefined ? String(metadataItem.guest_id) : undefined;
        metadataCustomerId = metadataItem.customer_id !== undefined ? String(metadataItem.customer_id) : undefined;
        metadataCustomerEmail = metadataItem.customer_email !== undefined ? String(metadataItem.customer_email) : undefined;
      }
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `preview_cart metadata fetch failed [errorType=${errorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Step 5 — resolve customer ULID
    let customerUlid = metadataCustomerId ?? "";

    if (metadataCustomerId) {
      // Reuse from METADATA — skip GSI query
      this.logger.debug(
        `Customer lookup [sessionUlid=${sessionUlid} outcome=metadata customerUlid=${customerUlid}]`,
      );
    }

    if (!metadataCustomerId) {
      const customerResult = await this.resolveCustomerUlid(
        tableName,
        accountUlid,
        email,
        firstName,
        lastName,
        phone,
        sessionUlid,
      );

      if (customerResult.isError) {
        return { result: customerResult.error, isError: true };
      }

      customerUlid = customerResult.customerUlid;
    }

    // Step 6 — batch fetch services
    const batchKeys = validated.items.map((item) => {
      return {
        PK: `A#${accountUlid}`,
        SK: item.service_id,
      };
    });

    let serviceMap: Map<string, Record<string, NativeAttributeValue>>;

    try {
      const batchResult = await this.dynamoDb.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: {
              Keys: batchKeys,
            },
          },
        }),
      );

      const responses = batchResult.Responses?.[tableName] ?? [];
      serviceMap = new Map(
        responses.map((item) => {
          return [String(item.SK ?? ""), item];
        }),
      );

      // Handle UnprocessedKeys — retry once
      const unprocessed = batchResult.UnprocessedKeys?.[tableName];

      if (unprocessed && unprocessed.Keys && unprocessed.Keys.length > 0) {
        const retryResult = await this.dynamoDb.send(
          new BatchGetCommand({
            RequestItems: {
              [tableName]: {
                Keys: unprocessed.Keys,
              },
            },
          }),
        );

        const retryResponses = retryResult.Responses?.[tableName] ?? [];

        for (const item of retryResponses) {
          serviceMap.set(String(item.SK ?? ""), item);
        }

        const stillUnprocessed = retryResult.UnprocessedKeys?.[tableName];

        if (stillUnprocessed && stillUnprocessed.Keys && stillUnprocessed.Keys.length > 0) {
          return {
            result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.",
            isError: true,
          };
        }
      }
    } catch (batchError: unknown) {
      const batchErrorName = batchError instanceof Error ? batchError.name : "UnknownError";
      this.logger.error(
        `preview_cart batch get services failed [errorType=${batchErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Step 7 — build cart items
    const cartItems: GuestCartItem[] = [];

    for (const item of validated.items) {
      const service = serviceMap.get(item.service_id);

      if (!service) {
        return {
          result:
            "One or more requested services could not be found in the catalog. Please call list_services again and pick from the returned list.",
          isError: true,
        };
      }

      const servicePrice = resolveServicePrice(service.price);
      const serviceVariants = toRecordArray(service.variants);

      let optionPrice = servicePrice;
      let variantString: string | null = null;
      let variantLabel: string | null = null;

      if (item.variant_id !== undefined && item.option_id !== undefined) {
        const matchedVariant = serviceVariants.find(
          (variant) => String(variant.id ?? "") === item.variant_id,
        );

        if (!matchedVariant) {
          return {
            result:
              "Variant selection did not match the service catalog. Please call list_services again and pick from the returned list.",
            isError: true,
          };
        }

        const variantOptions = toRecordArray(matchedVariant.options);

        const matchedOption = variantOptions.find(
          (option) => String(option.id ?? "") === item.option_id,
        );

        if (!matchedOption) {
          return {
            result:
              "Variant selection did not match the service catalog. Please call list_services again and pick from the returned list.",
            isError: true,
          };
        }

        const rawOptionPrice = matchedOption.price;

        if (rawOptionPrice !== null && rawOptionPrice !== undefined && rawOptionPrice !== "") {
          const parsed = Number(rawOptionPrice);
          if (Number.isFinite(parsed)) {
            optionPrice = parsed;
          }
        }

        variantString = `${item.variant_id}:${item.option_id}`;
        variantLabel = String(matchedOption.value ?? "");
      }

      if (item.variant_id === undefined && serviceVariants.length > 0) {
        return {
          result:
            "The selected service requires a variant choice. Please ask the visitor which option they prefer and call preview_cart again with variant_id and option_id.",
          isError: true,
        };
      }

      const imagesArray = toNativeArray(service.images);
      const imageUrl = imagesArray.length > 0 ? String(imagesArray[0] ?? "") : "";

      cartItems.push({
        category: String(service.category ?? ""),
        image_url: imageUrl,
        name: String(service.name ?? ""),
        price: optionPrice,
        quantity: item.quantity,
        service_id: item.service_id,
        total: optionPrice * item.quantity,
        variant: variantString,
        variant_label: variantLabel,
      });
    }

    // Step 8 — determine ULIDs (reuse from METADATA if available)
    // Both IDs must be present together — reusing only one leads to SK drift on crash-retry.
    const hasBothIds = metadataCartId !== undefined && metadataGuestId !== undefined;
    const guestUlid = hasBothIds ? metadataGuestId! : ulid();
    const cartUlid = hasBothIds ? metadataCartId! : ulid();

    if (hasBothIds) {
      this.logger.debug(
        `Cart IDs reused from metadata [sessionUlid=${sessionUlid} cartUlid=${cartUlid} guestUlid=${guestUlid}]`,
      );
    }

    const sk = `G#${guestUlid}C#${cartUlid}`;
    const now = new Date().toISOString();

    // Step 9 — write cart record via UpdateCommand with if_not_exists on _createdAt_
    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: `A#${accountUlid}`,
            SK: sk,
          },
          UpdateExpression:
            "SET #cart_items = :items, #customer_id = :customer_id, #email = :email, #createdAt = if_not_exists(#createdAt, :now), #lastUpdated = :now",
          ExpressionAttributeNames: {
            "#cart_items": "cart_items",
            "#customer_id": "customer_id",
            "#email": "email",
            "#createdAt": "_createdAt_",
            "#lastUpdated": "_lastUpdated_",
          },
          ExpressionAttributeValues: {
            ":items": cartItems,
            ":customer_id": `C#${customerUlid}`,
            ":email": email,
            ":now": now,
          },
        }),
      );

      this.logger.debug(
        `Cart written [sessionUlid=${sessionUlid} cartUlid=${cartUlid} itemCount=${cartItems.length}]`,
      );
    } catch (cartError: unknown) {
      const cartErrorName = cartError instanceof Error ? cartError.name : "UnknownError";
      this.logger.error(
        `preview_cart cart update failed [errorType=${cartErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Step 10 — write IDs to METADATA via if_not_exists
    const resolvedCustomerEmail = metadataCustomerEmail ?? email;

    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`,
            SK: METADATA_SK,
          },
          UpdateExpression:
            "SET #cart_id = if_not_exists(#cart_id, :cart_id), #guest_id = if_not_exists(#guest_id, :guest_id), #customer_id = if_not_exists(#customer_id, :customer_id), #customer_email = if_not_exists(#customer_email, :customer_email)",
          ExpressionAttributeNames: {
            "#cart_id": "cart_id",
            "#guest_id": "guest_id",
            "#customer_id": "customer_id",
            "#customer_email": "customer_email",
          },
          ExpressionAttributeValues: {
            ":cart_id": cartUlid,
            ":guest_id": guestUlid,
            ":customer_id": customerUlid,
            ":customer_email": resolvedCustomerEmail,
          },
        }),
      );
    } catch (metaError: unknown) {
      const metaErrorName = metaError instanceof Error ? metaError.name : "UnknownError";
      this.logger.error(
        `preview_cart metadata update failed [errorType=${metaErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Step 11 — build CartPreviewPayload
    const lines = cartItems.map((cartItem) => {
      return {
        line_id: ulid(),
        service_id: cartItem.service_id,
        name: cartItem.name,
        category: cartItem.category,
        image_url: cartItem.image_url,
        variant: cartItem.variant,
        variant_label: cartItem.variant_label,
        quantity: cartItem.quantity,
        price: cartItem.price,
        total: cartItem.total,
      };
    });

    const itemCount = cartItems.reduce((sum, cartItem) => sum + cartItem.quantity, 0);
    const cartTotal = cartItems.reduce((sum, cartItem) => sum + cartItem.total, 0);

    const payload = {
      cart_id: cartUlid,
      item_count: itemCount,
      currency: "usd",
      cart_total: cartTotal,
      lines,
    };

    // Step 12 — fire Slack alert if cart has items
    // cartTotal is already integer cents per the GuestCart contract; do NOT multiply by 100.
    if (itemCount > 0) {
      this.slackAlertService.notifyCartCreated({
        accountId: accountUlid,
        sessionUlid,
        guestCartId: cartUlid,
        cartTotalCents: cartTotal,
        itemCount,
        items: cartItems.map((cartItem) => {
          return {
            name: cartItem.name,
            quantity: cartItem.quantity,
            subtotalCents: cartItem.total,
          };
        }),
      }).catch(() => undefined);
    }

    return { result: JSON.stringify(payload) };
  }

  private async queryCustomerUlidByEmail(
    tableName: string,
    accountUlid: string,
    email: string,
  ): Promise<string | null> {
    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: this.gsiName,
        KeyConditionExpression: "#gsi1pk = :pk AND #gsi1sk = :sk",
        FilterExpression: "#entity = :customer",
        ExpressionAttributeNames: {
          "#gsi1pk": "GSI1-PK",
          "#gsi1sk": "GSI1-SK",
          "#entity": "entity",
        },
        ExpressionAttributeValues: {
          ":pk": `ACCOUNT#${accountUlid}`,
          ":sk": `EMAIL#${email}`,
          ":customer": "CUSTOMER",
        },
      }),
    );

    const items = result.Items ?? [];

    if (items.length === 0) {
      return null;
    }

    const pk = String(items[0].PK ?? "");

    if (!pk.startsWith("C#")) {
      return null;
    }

    return pk.slice(2);
  }

  private async resolveCustomerUlid(
    tableName: string,
    accountUlid: string,
    email: string,
    firstName: string,
    lastName: string,
    phone: string | null,
    sessionUlid: string,
  ): Promise<GuestCartCustomerResult> {
    const genericError = "We hit a problem creating the cart. Please ask the visitor to try again in a moment.";

    let existingUlid: string | null;

    try {
      existingUlid = await this.queryCustomerUlidByEmail(tableName, accountUlid, email);
    } catch (queryError: unknown) {
      const queryErrorName = queryError instanceof Error ? queryError.name : "UnknownError";
      this.logger.error(
        `preview_cart customer GSI query failed [errorType=${queryErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { isError: true, error: genericError };
    }

    if (existingUlid !== null) {
      this.logger.debug(
        `Customer lookup [sessionUlid=${sessionUlid} outcome=existing customerUlid=${existingUlid}]`,
      );
      return { isError: false, customerUlid: existingUlid };
    }

    const newCustomerUlid = ulid();
    const now = new Date().toISOString();

    const customerRecord: GuestCartCustomerRecord = {
      PK: `C#${newCustomerUlid}`,
      SK: `C#${newCustomerUlid}`,
      entity: "CUSTOMER",
      "GSI1-PK": `ACCOUNT#${accountUlid}`,
      "GSI1-SK": `EMAIL#${email}`,
      email,
      first_name: firstName,
      last_name: lastName,
      phone: phone ?? null,
      billing_address: null,
      is_email_subscribed: false,
      abandoned_carts: [],
      total_abandoned_carts: 0,
      total_orders: 0,
      total_spent: 0,
      _createdAt_: now,
      _lastUpdated_: now,
    };

    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: tableName,
          Item: customerRecord,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );

      this.logger.debug(
        `Customer lookup [sessionUlid=${sessionUlid} outcome=created customerUlid=${newCustomerUlid}]`,
      );
      return { isError: false, customerUlid: newCustomerUlid };
    } catch (putError: unknown) {
      const putErrorName = putError instanceof Error ? putError.name : "UnknownError";

      if (putErrorName !== "ConditionalCheckFailedException") {
        this.logger.error(
          `preview_cart customer put failed [errorType=${putErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
        return { isError: true, error: genericError };
      }

      this.logger.debug(`customer create race recovered [sessionUlid=${sessionUlid}]`);

      let recoveredUlid: string | null;

      try {
        recoveredUlid = await this.queryCustomerUlidByEmail(tableName, accountUlid, email);
      } catch (reQueryError: unknown) {
        const reQueryErrorName = reQueryError instanceof Error ? reQueryError.name : "UnknownError";
        this.logger.error(
          `preview_cart race recovery query failed [errorType=${reQueryErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
        return { isError: true, error: genericError };
      }

      if (recoveredUlid === null) {
        this.logger.error(
          `preview_cart race recovery re-query returned zero items [errorType=RaceRecoveryFailed sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
        return { isError: true, error: genericError };
      }

      this.logger.debug(
        `Customer lookup [sessionUlid=${sessionUlid} outcome=existing customerUlid=${recoveredUlid}]`,
      );
      return { isError: false, customerUlid: recoveredUlid };
    }
  }
}
