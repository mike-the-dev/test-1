import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { GuestCartCustomerRecord, GuestCartLookupOrCreateResult } from "../types/GuestCart";

const CUSTOMER_PK_PREFIX = "C#";
const ACCOUNT_PREFIX = "ACCOUNT#";
const EMAIL_PREFIX = "EMAIL#";
const GENERIC_ERROR_STRING = "An unexpected error occurred. Please try again.";

@Injectable()
export class CustomerService {
  private readonly logger = new Logger(CustomerService.name);
  private readonly gsiName: string;

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly configService: ConfigService,
  ) {
    this.gsiName =
      this.configService.get<string>("webChat.domainGsiName", { infer: true }) ?? "GSI1";
  }

  /**
   * Looks up a customer by email within a given account using the GSI.
   * Returns { customerUlid, latestSessionId } on success, or null if not found.
   * customerUlid is the bare ULID (no C# prefix).
   * latestSessionId is the bare session ULID from customer.latest_session_id, or null if absent.
   */
  async queryCustomerIdByEmail(
    tableName: string,
    accountUlid: string,
    email: string,
  ): Promise<{ customerUlid: string; latestSessionId: string | null } | null> {
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
          ":pk": `${ACCOUNT_PREFIX}${accountUlid}`,
          ":sk": `${EMAIL_PREFIX}${email}`,
          ":customer": "CUSTOMER",
        },
      }),
    );

    const items = result.Items ?? [];

    if (items.length === 0) {
      return null;
    }

    const pk = String(items[0].PK ?? "");

    if (!pk.startsWith(CUSTOMER_PK_PREFIX)) {
      return null;
    }

    const latestSessionId =
      items[0].latest_session_id != null ? String(items[0].latest_session_id) : null;

    return { customerUlid: pk.slice(CUSTOMER_PK_PREFIX.length), latestSessionId };
  }

  /**
   * Looks up an existing customer by email, or creates a new customer record if none exists.
   * Returns the bare customerUlid (no C# prefix) and whether the record was created.
   * On unrecoverable error, returns { error: string }.
   */
  async lookupOrCreateCustomer(input: {
    tableName: string;
    accountUlid: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  }): Promise<GuestCartLookupOrCreateResult> {
    // Step A — Query GSI for existing customer
    let existingUlid: string | null;

    try {
      const lookupResult = await this.queryCustomerIdByEmail(input.tableName, input.accountUlid, input.email);
      existingUlid = lookupResult ? lookupResult.customerUlid : null;
    } catch (queryError: unknown) {
      const errorName = queryError instanceof Error ? queryError.name : "UnknownError";
      this.logger.error(
        `[event=lookup_or_create_customer_query_failed errorType=${errorName} accountUlid=${input.accountUlid}]`,
      );
      return { isError: true, error: GENERIC_ERROR_STRING };
    }

    if (existingUlid !== null) {
      return { isError: false, customerUlid: existingUlid, created: false };
    }

    // Step B — Lookup missed. Generate new customer ULID and build customer record.
    const newCustomerUlid = ulid();
    const now = new Date().toISOString();

    const customerRecord: GuestCartCustomerRecord = {
      PK: `${CUSTOMER_PK_PREFIX}${newCustomerUlid}`,
      SK: `${CUSTOMER_PK_PREFIX}${newCustomerUlid}`,
      entity: "CUSTOMER",
      "GSI1-PK": `${ACCOUNT_PREFIX}${input.accountUlid}`,
      "GSI1-SK": `${EMAIL_PREFIX}${input.email}`,
      email: input.email,
      first_name: input.firstName,
      last_name: input.lastName,
      phone: input.phone,
      billing_address: null,
      is_email_subscribed: false,
      abandoned_carts: [],
      total_abandoned_carts: 0,
      total_orders: 0,
      total_spent: 0,
      latest_session_id: null,
      _createdAt_: now,
      _lastUpdated_: now,
    };

    // Step C — PutCommand with attribute_not_exists(PK) ConditionExpression
    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: input.tableName,
          Item: customerRecord,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );

      this.logger.debug(`[event=customer_created accountUlid=${input.accountUlid}]`);
      return { isError: false, customerUlid: newCustomerUlid, created: true };
    } catch (putError: unknown) {
      const putErrorName = putError instanceof Error ? putError.name : "UnknownError";

      if (putErrorName !== "ConditionalCheckFailedException") {
        this.logger.error(
          `[event=customer_put_failed errorType=${putErrorName} accountUlid=${input.accountUlid}]`,
        );
        return { isError: true, error: GENERIC_ERROR_STRING };
      }

      // Step D — ConditionalCheckFailedException: race recovery
      this.logger.debug(
        `[event=customer_create_race_recovered accountUlid=${input.accountUlid}]`,
      );

      let recoveredUlid: string | null;

      try {
        const recoveredResult = await this.queryCustomerIdByEmail(input.tableName, input.accountUlid, input.email);
        recoveredUlid = recoveredResult ? recoveredResult.customerUlid : null;
      } catch (reQueryError: unknown) {
        const errorName = reQueryError instanceof Error ? reQueryError.name : "UnknownError";
        this.logger.error(
          `[event=customer_race_requery_failed errorType=${errorName} accountUlid=${input.accountUlid}]`,
        );
        return { isError: true, error: GENERIC_ERROR_STRING };
      }

      if (recoveredUlid === null) {
        this.logger.error(
          `[event=customer_race_requery_empty errorType=RaceRecoveryFailed accountUlid=${input.accountUlid}]`,
        );
        return { isError: true, error: GENERIC_ERROR_STRING };
      }

      return { isError: false, customerUlid: recoveredUlid, created: false };
    }
  }
}
