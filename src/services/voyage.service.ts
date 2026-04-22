import { Injectable, Logger } from "@nestjs/common";
import { VoyageAIClient } from "voyageai";

import { VoyageConfigService } from "./voyage-config.service";

const VOYAGE_MAX_BATCH = 1000;

@Injectable()
export class VoyageService {
  private readonly logger = new Logger(VoyageService.name);
  private readonly client: VoyageAIClient;

  constructor(private readonly voyageConfig: VoyageConfigService) {
    this.client = new VoyageAIClient({ apiKey: this.voyageConfig.apiKey, maxRetries: 0 });
  }

  async embedText(text: string): Promise<number[]> {
    const results = await this.embedTexts([text]);
    return results[0];
  }

  async embedTexts(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const model = this.voyageConfig.model;
    const results: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += VOYAGE_MAX_BATCH) {
      const batch = texts.slice(offset, offset + VOYAGE_MAX_BATCH);

      this.logger.debug(
        `Calling Voyage embed API [batchSize=${batch.length} model=${model} offset=${offset}]`,
      );

      let response;

      try {
        response = await this.client.embed({ input: batch, model });
      } catch (error) {
        this.logger.error("Voyage API call failed", error);
        throw error;
      }

      const data = response.data ?? [];

      this.logger.debug(
        `Voyage embed response [returned=${data.length} totalUsage=${response.usage?.totalTokens ?? "unknown"}]`,
      );

      for (const item of data) {
        if (!item.embedding) {
          throw new Error(
            `Voyage API returned a malformed response: EmbedResponseDataItem at index ${item.index ?? "unknown"} is missing the embedding field`,
          );
        }

        results.push(item.embedding);
      }
    }

    return results;
  }
}
