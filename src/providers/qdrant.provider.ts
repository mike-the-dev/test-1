import { Logger } from "@nestjs/common";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantConfigService } from "../services/qdrant-config.service";

export const QDRANT_CLIENT = "QDRANT_CLIENT";

export const QdrantProvider = {
  provide: QDRANT_CLIENT,
  useFactory: async (config: QdrantConfigService): Promise<QdrantClient> => {
    const client = new QdrantClient({
      url: config.url,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });

    try {
      const result = await client.getCollections();
      Logger.log(
        `Qdrant connected [url=${config.url} collectionCount=${result.collections.length}]`,
        "QdrantProvider",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.warn(
        `Qdrant unreachable [url=${config.url} error=${message}]`,
        "QdrantProvider",
      );
    }

    return client;
  },
  inject: [QdrantConfigService],
};
