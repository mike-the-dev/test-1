import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { DYNAMO_DB_CLIENT } from "../providers/dynamodb.provider";

@Injectable()
export class CustomerService {
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
   * Returns the bare customerUlid (no C# prefix), or null if not found.
   */
  async queryCustomerIdByEmail(
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
}
