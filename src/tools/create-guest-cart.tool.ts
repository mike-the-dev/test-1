import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  NativeAttributeValue,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import {
  GuestCartCheckoutBaseResult,
  GuestCartCustomerRecord,
  GuestCartCustomerResult,
  GuestCartItem,
} from "../types/GuestCart";
import { createGuestCartInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const USER_CONTACT_INFO_SK = "USER_CONTACT_INFO";

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
export class CreateGuestCartTool implements ChatTool {
  private readonly logger = new Logger(CreateGuestCartTool.name);
  private readonly checkoutBaseUrlOverride: string | null;
  private readonly gsiName: string;

  readonly name = "create_guest_cart";

  readonly description =
    "Create a guest cart containing the services the visitor has committed to, look up or create their customer record, and return a checkout URL that will take them directly to step two of the Instapaytient checkout flow. Call this exactly once per session, after the visitor has confirmed interest in one or more specific services and you already have their email, first name, and last name saved via collect_contact_info. Pass each committed service as an item — with its variant_id and option_id if the service has variants. The tool returns a checkout URL you must present to the visitor as a clickable link as the final action of the conversation.";

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
  ) {
    this.checkoutBaseUrlOverride =
      this.configService.get<string>("webChat.checkoutBaseUrlOverride", { infer: true }) ?? null;
    this.gsiName =
      this.configService.get<string>("webChat.domainGsiName", { infer: true }) ?? "GSI1";
  }

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    const { sessionUlid, accountUlid } = context;

    this.logger.debug(
      `Executing tool [name=create_guest_cart sessionUlid=${sessionUlid} accountUlid=${accountUlid ?? "null"}]`,
    );

    // Step 1 — validate input
    const parseResult = createGuestCartInputSchema.safeParse(input);

    if (!parseResult.success) {
      return { result: `Invalid input: ${parseResult.error.message}`, isError: true };
    }

    const validated = parseResult.data;

    // Step 2 — check account context
    if (!accountUlid) {
      return { result: "Missing account context — cannot create cart.", isError: true };
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
      firstName = String(contactItem.firstName ?? "");
      lastName = String(contactItem.lastName ?? "");
      phone = contactItem.phone !== undefined ? String(contactItem.phone) : null;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `create_guest_cart contact info fetch failed [errorType=${errorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Steps 4 & 5 — customer lookup or create
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

    const customerUlid = customerResult.customerUlid;

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
        `create_guest_cart batch get services failed [errorType=${batchErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Build cart items
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

      let optionPrice: number = servicePrice;
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
            "The selected service requires a variant choice. Please ask the visitor which option they prefer and call create_guest_cart again with variant_id and option_id.",
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

    // Step 7 — generate IDs
    const guestUlid = ulid();
    const cartUlid = ulid();
    const sk = `G#${guestUlid}C#${cartUlid}`;
    const now = new Date().toISOString();

    // Step 8 — write guest cart
    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `A#${accountUlid}`,
            SK: sk,
            customer_id: `C#${customerUlid}`,
            email,
            cart_items: cartItems,
            _createdAt_: now,
            _lastUpdated_: now,
          },
        }),
      );

      this.logger.debug(
        `Cart written [sessionUlid=${sessionUlid} cartUlid=${cartUlid} itemCount=${cartItems.length}]`,
      );
    } catch (cartError: unknown) {
      const cartErrorName = cartError instanceof Error ? cartError.name : "UnknownError";
      this.logger.error(
        `create_guest_cart cart put failed [errorType=${cartErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return { result: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.", isError: true };
    }

    // Step 9 — determine checkout base URL
    const baseResult = await this.resolveCheckoutBase(tableName, accountUlid, sessionUlid);

    if (baseResult.isError) {
      return { result: baseResult.error, isError: true };
    }

    // Step 10 — construct checkout URL. guestId + cartId are passed so the
    // e-commerce front-end middleware can set them as cookies directly and
    // bypass the default minting path, which lets the checkout page find the
    // cart we just wrote instead of redirecting to /shop on an empty cart.
    const checkoutUrl = `${baseResult.base}/checkout?email=${encodeURIComponent(email)}&customerId=${customerUlid}&guestId=${guestUlid}&cartId=${cartUlid}`;

    // Step 11 — return result
    return {
      result: JSON.stringify({
        checkoutUrl,
        customerId: customerUlid,
        cartUlid,
        guestUlid,
        itemCount: cartItems.length,
      }),
    };
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
        `create_guest_cart customer GSI query failed [errorType=${queryErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
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
          `create_guest_cart customer put failed [errorType=${putErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
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
          `create_guest_cart race recovery query failed [errorType=${reQueryErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
        return { isError: true, error: genericError };
      }

      if (recoveredUlid === null) {
        this.logger.error(
          `create_guest_cart race recovery re-query returned zero items [errorType=RaceRecoveryFailed sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
        return { isError: true, error: genericError };
      }

      this.logger.debug(
        `Customer lookup [sessionUlid=${sessionUlid} outcome=existing customerUlid=${recoveredUlid}]`,
      );
      return { isError: false, customerUlid: recoveredUlid };
    }
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
          `create_guest_cart account GSI1-PK missing or malformed [errorType=MalformedAccountRecord sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
        );
        return {
          isError: true,
          error: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.",
        };
      }

      const host = gsi1pk.slice("DOMAIN#".length);
      const base = `https://${host}`;
      this.logger.debug(`URL path [sessionUlid=${sessionUlid} path=account_domain]`);
      return { isError: false, base };
    } catch (accountError: unknown) {
      const accountErrorName = accountError instanceof Error ? accountError.name : "UnknownError";
      this.logger.error(
        `create_guest_cart account get failed [errorType=${accountErrorName} sessionUlid=${sessionUlid} accountUlid=${accountUlid}]`,
      );
      return {
        isError: true,
        error: "We hit a problem creating the cart. Please ask the visitor to try again in a moment.",
      };
    }
  }
}
