import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, NativeAttributeValue } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { GuestCartCheckActiveCartResult } from "../types/GuestCart";
import { checkActiveCartInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const METADATA_SK = "METADATA";
const CUSTOMER_PK_PREFIX = "C#";
const GUEST_PK_PREFIX = "G#";

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

@ChatToolProvider()
@Injectable()
export class CheckActiveCartTool implements ChatTool {
  private readonly logger = new Logger(CheckActiveCartTool.name);

  readonly name = "check_active_cart";

  readonly description =
    "Check whether the returning visitor has an unpaid cart from a prior session. Call this immediately after verify_code returns { verified: true }. Returns { has_cart: true, items, cart_total_cents, last_updated_at } if a cart exists, or { has_cart: false } if not. Read-only — never modifies any record.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    const { sessionUlid, accountUlid } = context;

    // Step 1 — validate input
    const parseResult = checkActiveCartInputSchema.safeParse(input);

    if (!parseResult.success) {
      const summary = parseResult.error.issues.map((issue) => issue.message).join(", ");
      return { result: `Invalid input: ${summary}`, isError: true };
    }

    // Step 2 — guard: accountUlid must be present
    if (!accountUlid) {
      this.logger.debug(
        `[event=check_active_cart_no_account_ulid sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    const tableName = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    // Step 3 — GetItem on current session METADATA
    let currentMetadata: Record<string, NativeAttributeValue> | undefined;

    try {
      const metadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: sessionPk, SK: METADATA_SK },
        }),
      );
      currentMetadata = metadataResult.Item;
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : "UnknownError";
      this.logger.warn(
        `[event=check_active_cart_metadata_read_failed errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    if (!currentMetadata) {
      this.logger.warn(
        `[event=check_active_cart_current_metadata_missing sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    // Step 4 — read customer_id from current METADATA
    const rawCustomerId = currentMetadata.customer_id;

    if (rawCustomerId === null || rawCustomerId === undefined || rawCustomerId === "") {
      this.logger.debug(
        `[event=check_active_cart_no_customer_id sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    // Step 5 — read continuation_from_session_id; derive prior session ULID
    const rawContinuation = currentMetadata.continuation_from_session_id;

    if (rawContinuation === null || rawContinuation === undefined || rawContinuation === "") {
      this.logger.debug(
        `[event=check_active_cart_no_continuation sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    const continuationStr = String(rawContinuation);
    // Strip the CHAT_SESSION# prefix if present — match the pattern at chat-session.service.ts:249
    const priorSessionUlid = continuationStr.startsWith(CHAT_SESSION_PK_PREFIX)
      ? continuationStr.slice(CHAT_SESSION_PK_PREFIX.length)
      : continuationStr;

    // Step 6 — GetItem on prior session METADATA
    let priorMetadata: Record<string, NativeAttributeValue> | undefined;

    try {
      const priorMetadataResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `${CHAT_SESSION_PK_PREFIX}${priorSessionUlid}`, SK: METADATA_SK },
        }),
      );
      priorMetadata = priorMetadataResult.Item;
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : "UnknownError";
      this.logger.warn(
        `[event=check_active_cart_prior_metadata_missing errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    if (!priorMetadata) {
      this.logger.debug(
        `[event=check_active_cart_prior_metadata_missing sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    // Step 7 — read cart_id and guest_id from prior METADATA
    const rawCartId = priorMetadata.cart_id;
    const rawGuestId = priorMetadata.guest_id;

    if (rawCartId === null || rawCartId === undefined || rawCartId === "") {
      this.logger.debug(
        `[event=check_active_cart_no_cart_record sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    if (rawGuestId === null || rawGuestId === undefined || rawGuestId === "") {
      this.logger.debug(
        `[event=check_active_cart_no_cart_record sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    const cartIdStr = String(rawCartId);
    const guestIdStr = String(rawGuestId);

    // Step 8 — build cart SK with defensive prefix normalization for legacy bare values
    const normalizedGuestId = guestIdStr.startsWith(GUEST_PK_PREFIX) ? guestIdStr : `${GUEST_PK_PREFIX}${guestIdStr}`;
    const normalizedCartId = cartIdStr.startsWith(CUSTOMER_PK_PREFIX) ? cartIdStr : `${CUSTOMER_PK_PREFIX}${cartIdStr}`;
    const sk = `${normalizedGuestId}${normalizedCartId}`;

    // Step 9 — GetItem on cart record
    let cartItem: Record<string, NativeAttributeValue> | undefined;

    try {
      const cartResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `A#${accountUlid}`, SK: sk },
        }),
      );
      cartItem = cartResult.Item;
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : "UnknownError";
      this.logger.warn(
        `[event=check_active_cart_no_cart_record errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    if (!cartItem) {
      this.logger.debug(
        `[event=check_active_cart_no_cart_record sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    // Step 10 — parse cart_items; reject empty carts
    const rawItems = toRecordArray(cartItem.cart_items);

    if (rawItems.length === 0) {
      this.logger.debug(
        `[event=check_active_cart_no_cart_record sessionUlid=${sessionUlid}]`,
      );
      return { result: JSON.stringify({ has_cart: false } satisfies GuestCartCheckActiveCartResult) };
    }

    // Step 11 — build outbound payload
    const items = rawItems.map((item) => {
      return {
        name: String(item.name ?? ""),
        quantity: Number(item.quantity ?? 0),
        price: Number(item.price ?? 0),
        total: Number(item.total ?? 0),
        variant_label: item.variant_label != null ? String(item.variant_label) : null,
      };
    });

    const cartTotalCents = items.reduce((sum, item) => sum + item.total, 0);
    const lastUpdatedAt = String(cartItem._lastUpdated_ ?? "");

    this.logger.log(
      `[event=check_active_cart_hit sessionUlid=${sessionUlid} itemCount=${items.length}]`,
    );

    // Step 12 — return hit payload
    const payload = {
      has_cart: true,
      items,
      cart_total_cents: cartTotalCents,
      last_updated_at: lastUpdatedAt,
      was_link_generated_at: null,
    };

    return { result: JSON.stringify(payload satisfies GuestCartCheckActiveCartResult) };
  }
}
