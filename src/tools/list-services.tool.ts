import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, NativeAttributeValue, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "../services/database-config.service";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { ServiceTrimmed, ServiceVariant, ServiceVariantOption } from "../types/Service";
import { listServicesInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const MAX_SERVICES = 50;
const MAX_DESCRIPTION_LENGTH = 400;

function trimPrice(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function trimComparePrice(comparePrice: unknown, price: number): number | null {
  if (!comparePrice) return null;
  const compare = Number(comparePrice);
  if (compare <= price) return null;
  return Number((compare / 100).toFixed(2));
}

function resolveOptionPrice(option: Record<string, NativeAttributeValue>, fallbackPriceInCents: number): number {
  const raw = option.price;
  if (raw !== null && raw !== undefined && !Number.isNaN(Number(raw)) && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackPriceInCents;
}

function trimVariantOption(option: Record<string, NativeAttributeValue>, priceInCents: number): ServiceVariantOption {
  const optionPrice = resolveOptionPrice(option, priceInCents);
  return {
    value: String(option.value ?? ""),
    price_usd: trimPrice(optionPrice),
    compare_price_usd: trimComparePrice(option.compare_price, optionPrice),
  };
}

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

function trimVariant(variant: Record<string, NativeAttributeValue>, priceInCents: number): ServiceVariant {
  const options = toRecordArray(variant.options);
  return {
    name: String(variant.name ?? ""),
    options: options.map((option) => {
      return trimVariantOption(option, priceInCents);
    }),
  };
}

function trimDescription(description: string): string {
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return description.slice(0, MAX_DESCRIPTION_LENGTH - 3) + "...";
  }
  return description;
}

function resolveCategory(raw: unknown): "default" | "instant" {
  if (raw === "instant") {
    return "instant";
  }
  return "default";
}

@ChatToolProvider()
@Injectable()
export class ListServicesTool implements ChatTool {
  private readonly logger = new Logger(ListServicesTool.name);

  readonly name = "list_services";

  readonly description =
    "Return all services in the current practice's catalog. Call this once the visitor has shared what kind of treatment or service they're interested in. Returns a list of services with name, description, price, category, whether they are featured, and variant options. Use the returned list to recommend one to three services that best match what the visitor asked for.";

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
    const parseResult = listServicesInputSchema.safeParse(input);

    if (!parseResult.success) {
      return { result: `Invalid input: ${parseResult.error.message}`, isError: true };
    }

    if (!context.accountUlid) {
      return { result: "Missing account context — cannot list services.", isError: true };
    }

    const tableName = this.databaseConfig.conversationsTable;

    const queryResult = await this.dynamoDb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        FilterExpression: "#entity = :entity",
        ExpressionAttributeNames: { "#entity": "entity" },
        ExpressionAttributeValues: {
          ":pk": `A#${context.accountUlid}`,
          ":skPrefix": "S#",
          ":entity": "SERVICE",
        },
      }),
    ).catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`list_services DynamoDB error [errorType=${errorName}]`);
      return null;
    });

    if (queryResult === null) {
      return { result: "Service catalog is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true };
    }

    const items = queryResult.Items ?? [];

    const filtered = items.filter(
      (item) => item.enabled === true && item.is_shown_in_shop === true,
    );

    const sorted = filtered.sort(
      (a, b) =>
        Number(b.featured) - Number(a.featured) ||
        String(a.name ?? "").localeCompare(String(b.name ?? "")),
    );

    const sliced = sorted.slice(0, MAX_SERVICES);

    const trimmed = sliced.map((item): ServiceTrimmed => {
      const priceInCents = item.price !== null && item.price !== undefined ? Number(item.price) : 0;
      const variants = toRecordArray(item.variants);

      return {
        service_id: String(item.SK ?? ""),
        name: String(item.name ?? ""),
        sub_title: item.sub_title ? String(item.sub_title) : null,
        description: trimDescription(String(item.description ?? "")),
        price_usd: trimPrice(priceInCents),
        compare_price_usd: trimComparePrice(item.compare_price, priceInCents),
        category: resolveCategory(item.category),
        featured: Boolean(item.featured),
        ribbon_text: item.ribbon_text ? String(item.ribbon_text) : null,
        variants: variants.map((variant) => {
          return trimVariant(variant, priceInCents);
        }),
        slug: String(item.slug ?? ""),
      };
    });

    this.logger.debug(
      `list_services executed [sessionUlid=${context.sessionUlid} accountUlid=${context.accountUlid} count=${trimmed.length}]`,
    );

    return { result: JSON.stringify({ services: trimmed, count: trimmed.length }) };
  }
}
