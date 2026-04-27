import { Injectable, Logger } from "@nestjs/common";
import { VoyageAIClient, VoyageAIError } from "voyageai";

type EmbedResponse = Awaited<ReturnType<VoyageAIClient["embed"]>>;

import { VoyageConfigService } from "./voyage-config.service";
import { SentryService } from "./sentry.service";

const VOYAGE_MAX_BATCH = 1000;

@Injectable()
export class VoyageService {
  private readonly logger = new Logger(VoyageService.name);
  private readonly client: VoyageAIClient;

  constructor(
    private readonly voyageConfig: VoyageConfigService,
    private readonly sentryService: SentryService,
  ) {
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

      let response: EmbedResponse;

      try {
        response = await this.client.embed({ input: batch, model });
      } catch (error) {
        if (error instanceof VoyageAIError) {
          const statusCode = error.statusCode ?? "unknown";
          this.logger.error(`Voyage API error [statusCode=${statusCode}]`);
          this.sentryService.captureException(error, {
            tags: { category: "voyage" },
            extras: { statusCode: String(statusCode) },
          });
          if (error.statusCode === 401) {
            throw new Error("Voyage API authentication failed — check VOYAGE_API_KEY");
          }
          if (error.statusCode === 429) {
            throw new Error("Voyage API rate limit exceeded");
          }
          throw new Error(`Voyage API call failed with status ${statusCode}`);
        }
        const errorName = error instanceof Error ? error.name : "UnknownError";
        this.logger.error(`Voyage call failed [errorType=${errorName}]`);
        this.sentryService.captureException(error, {
          tags: { category: "voyage" },
        });
        throw new Error("Voyage API call failed due to a network or unknown error");
      }

      const data = response.data ?? [];

      this.logger.debug(
        `Voyage embed response [returned=${data.length} totalUsage=${response.usage?.totalTokens ?? "unknown"}]`,
      );

      const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const item of sorted) {
        if (!item.embedding) {
          throw new Error(`Voyage API returned a malformed response: EmbedResponseDataItem at index ${item.index ?? "unknown"} is missing the embedding field`);
        }

        results.push(item.embedding);
      }
    }

    return results;
  }
}
