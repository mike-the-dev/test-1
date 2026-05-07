import { Injectable, Inject, Logger } from "@nestjs/common";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";
import { DatabaseConfigService } from "./database-config.service";
import { Entity } from "../types/EntityEnum";
import {
  ChannelAddressType,
  AccountChannelAddressRecord,
  AccountChannelArrayKeys,
  AccountChannelProvisionResult,
  AccountChannelDeprovisionResult,
  AccountChannelTransactionCanceledError,
} from "../types/AccountChannel";

/**
 * Maps a ChannelAddressType to its GSI1-PK prefix string.
 * The prefix is the uppercase form of the channel-type enum value,
 * matching the SK pattern stored on index records.
 */
function formatGsi1PkForChannel(channelType: ChannelAddressType, address: string): string {
  const prefix = channelType.toUpperCase();
  return `${prefix}#${address}`;
}

/**
 * Returns the DDB attribute name used for the address array on the account record
 * for a given channel type. "email" → "reply_domains", "sms" → "phone_numbers".
 */
function channelArrayKey(channelType: ChannelAddressType): AccountChannelArrayKeys {
  if (channelType === ChannelAddressType.EMAIL_REPLY_DOMAIN) {
    return { channelKey: "email", addressArrayKey: "reply_domains" };
  }
  return { channelKey: "sms", addressArrayKey: "phone_numbers" };
}

@Injectable()
export class ChannelAddressService {
  private readonly logger = new Logger(ChannelAddressService.name);

  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  /**
   * Looks up the account that owns the given channel address via GSI1.
   * Returns { accountId } when found, null otherwise (unknown address or DDB error).
   */
  async getAccountByChannelAddress(
    channelType: ChannelAddressType,
    address: string,
  ): Promise<{ accountId: string } | null> {
    const tableName = this.databaseConfig.conversationsTable;
    const gsi1Pk = formatGsi1PkForChannel(channelType, address);

    try {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "#gsi1pk = :pk",
          FilterExpression: "#entity = :entity",
          ExpressionAttributeNames: {
            "#gsi1pk": "GSI1-PK",
            "#entity": "entity",
          },
          ExpressionAttributeValues: {
            ":pk": gsi1Pk,
            ":entity": Entity.ACCOUNT_CHANNEL_ADDRESS,
          },
          Limit: 1,
        }),
      );

      const item = result.Items?.[0];

      if (!item) {
        return null;
      }

      const pk = String(item.PK ?? "");

      if (!pk.startsWith("A#")) {
        this.logger.warn(
          `[event=channel_address_lookup_bad_pk channelType=${channelType} address=${address}]`,
        );
        return null;
      }

      const accountId = pk.slice(2);
      return { accountId };
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.warn(
        `[event=channel_address_lookup_error channelType=${channelType} errorType=${errorName}]`,
      );
      return null;
    }
  }

  /**
   * Atomically provisions a channel address:
   * - Writes the index record (PUT with attribute_not_exists condition)
   * - Appends the address to the account record's channels array (list_append)
   *
   * Returns { provisioned: true } on success.
   * Returns { error: "address_already_provisioned" } if the index record already exists.
   * Returns { error: "provisioning_failed" } on other DDB errors.
   */
  async provisionChannelAddress(input: {
    accountId: string;
    channelType: ChannelAddressType;
    address: string;
  }): Promise<AccountChannelProvisionResult> {
    const { accountId, channelType, address } = input;
    const tableName = this.databaseConfig.conversationsTable;
    const { channelKey, addressArrayKey } = channelArrayKey(channelType);

    const sk = `${channelType.toUpperCase()}#${address}`;
    const gsi1Pk = formatGsi1PkForChannel(channelType, address);
    const now = new Date().toISOString();

    const indexRecord: AccountChannelAddressRecord = {
      PK: `A#${accountId}`,
      SK: sk,
      entity: Entity.ACCOUNT_CHANNEL_ADDRESS,
      channel_type: channelType,
      address,
      "GSI1-PK": gsi1Pk,
      "GSI1-SK": `ACCOUNT#${accountId}`,
      _createdAt_: now,
      _lastUpdated_: now,
    };

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: indexRecord,
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { PK: `A#${accountId}`, SK: `A#${accountId}` },
                UpdateExpression:
                  "SET channels.#channel.#addressArray = list_append(if_not_exists(channels.#channel.#addressArray, :empty), :newEntry), #lastUpdated = :now",
                ExpressionAttributeNames: {
                  "#channel": channelKey,
                  "#addressArray": addressArrayKey,
                  "#lastUpdated": "_lastUpdated_",
                },
                ExpressionAttributeValues: {
                  ":empty": [],
                  ":newEntry": [address],
                  ":now": new Date().toISOString(),
                },
              },
            },
          ],
        }),
      );

      this.logger.log(
        `[event=channel_address_provisioned accountId=${accountId} channelType=${channelType} address=${address}]`,
      );

      return { provisioned: true };
    } catch (error: unknown) {
      if (isTransactionCanceledError(error)) {
        const reasons = getTransactionCancellationReasons(error);
        // Index 0 is the Put (index record condition). If it failed → address already provisioned.
        if (reasons[0] === "ConditionalCheckFailed") {
          return { error: "address_already_provisioned" };
        }
        this.logger.error(
          `[event=channel_address_provision_failed accountId=${accountId} channelType=${channelType}]`,
        );
        return { error: "provisioning_failed" };
      }

      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[event=channel_address_provision_error accountId=${accountId} channelType=${channelType} errorType=${errorName}]`,
      );
      return { error: "provisioning_failed" };
    }
  }

  /**
   * Deprovisions a channel address using a two-phase approach:
   *
   * Phase 1 — GetItem: read the account record to find the current index of the
   * target address in the channels array. This is necessary because DynamoDB's
   * REMOVE expression requires a concrete array index, not a value.
   *
   * Phase 2 — TransactWrite: atomically delete the index record (with
   * attribute_exists guard) and update the account record. If the address was
   * found in the array, the Update uses `REMOVE channels.<channel>.<array>[<idx>]`
   * to remove exactly the right element. If the address was NOT in the array the
   * account record is already consistent; the Update still bumps `_lastUpdated_`
   * as a "this account was modified" signal.
   *
   * Non-atomicity trade-off: the GetItem and TransactWrite are not a single atomic
   * operation. If another writer appends or removes addresses between the two steps,
   * the resolved index could be stale and a wrong element could be removed. For v1
   * this is accepted because deprovisioning is admin-only and low-frequency. A future
   * migration to DynamoDB StringSet would make single-element removal atomic.
   *
   * Returns { deprovisioned: true } on success.
   * Returns { error: "address_not_found" } if the index record does not exist.
   * Returns { error: "deprovisioning_failed" } on other DDB errors.
   */
  async deprovisionChannelAddress(input: {
    accountId: string;
    channelType: ChannelAddressType;
    address: string;
  }): Promise<AccountChannelDeprovisionResult> {
    const { accountId, channelType, address } = input;
    const tableName = this.databaseConfig.conversationsTable;
    const sk = `${channelType.toUpperCase()}#${address}`;
    const { channelKey, addressArrayKey } = channelArrayKey(channelType);

    // Phase 1: GetItem to discover the address array index.
    let addressIndex = -1;
    try {
      const getResult = await this.dynamoDb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `A#${accountId}`, SK: `A#${accountId}` },
        }),
      );

      const item = getResult.Item;
      if (item) {
        const channelConfig = item["channels"]?.[channelKey];
        const addressArray: unknown[] = channelConfig?.[addressArrayKey] ?? [];
        addressIndex = addressArray.indexOf(address);
      }
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[event=channel_address_deprovision_getitem_error accountId=${accountId} channelType=${channelType} errorType=${errorName}]`,
      );
      return { error: "deprovisioning_failed" };
    }

    // Phase 2: TransactWrite — delete index record + update account record.
    // Build the UpdateExpression and ExpressionAttributeNames based on whether we
    // found the address in the array. DynamoDB rejects unused attribute name
    // placeholders, so only include #channel/#addressArray when the REMOVE clause
    // is present.
    const updateExpression =
      addressIndex >= 0
        ? `REMOVE channels.#channel.#addressArray[${addressIndex}] SET #lastUpdated = :now`
        : "SET #lastUpdated = :now";

    const expressionAttributeNames: Record<string, string> =
      addressIndex >= 0
        ? {
            "#channel": channelKey,
            "#addressArray": addressArrayKey,
            "#lastUpdated": "_lastUpdated_",
          }
        : { "#lastUpdated": "_lastUpdated_" };

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName,
                Key: { PK: `A#${accountId}`, SK: sk },
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { PK: `A#${accountId}`, SK: `A#${accountId}` },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: {
                  ":now": new Date().toISOString(),
                },
              },
            },
          ],
        }),
      );

      this.logger.log(
        `[event=channel_address_deprovisioned accountId=${accountId} channelType=${channelType} address=${address}]`,
      );

      return { deprovisioned: true };
    } catch (error: unknown) {
      if (isTransactionCanceledError(error)) {
        const reasons = getTransactionCancellationReasons(error);
        // Index 0 is the Delete (index record condition). If it failed → address not found.
        if (reasons[0] === "ConditionalCheckFailed") {
          return { error: "address_not_found" };
        }
        this.logger.error(
          `[event=channel_address_deprovision_failed accountId=${accountId} channelType=${channelType}]`,
        );
        return { error: "deprovisioning_failed" };
      }

      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[event=channel_address_deprovision_error accountId=${accountId} channelType=${channelType} errorType=${errorName}]`,
      );
      return { error: "deprovisioning_failed" };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for TransactionCanceledException inspection
// ---------------------------------------------------------------------------

function isTransactionCanceledError(
  value: unknown,
): value is AccountChannelTransactionCanceledError {
  if (!(value instanceof Error)) {
    return false;
  }

  if (value.name !== "TransactionCanceledException") {
    return false;
  }

  return true;
}

function getTransactionCancellationReasons(error: unknown): string[] {
  if (!isTransactionCanceledError(error)) {
    return [];
  }

  const reasons = error.CancellationReasons;

  if (!reasons || reasons.length === 0) {
    return [];
  }

  return reasons.map((reason) => {
    return reason?.Code ?? "None";
  });
}
