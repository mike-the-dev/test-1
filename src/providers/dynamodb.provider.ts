import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DatabaseConfigService } from "../services/database-config.service";

export const DYNAMO_DB_CLIENT = "DYNAMO_DB_CLIENT";

export const DynamoDBProvider = {
  provide: DYNAMO_DB_CLIENT,
  useFactory: (config: DatabaseConfigService) => {
    const client = new DynamoDBClient({
      region: config.region,
      endpoint: config.endpoint,
    });

    return DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  },
  inject: [DatabaseConfigService],
};
