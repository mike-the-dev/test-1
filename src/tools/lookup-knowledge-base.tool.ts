import { Injectable, Inject, Logger } from "@nestjs/common";
import { QdrantClient } from "@qdrant/js-client-rest";

import { QDRANT_CLIENT } from "../providers/qdrant.provider";
import { VoyageService } from "../services/voyage.service";
import { KB_COLLECTION_NAME } from "../utils/knowledge-base/constants";
import { ChatTool, ChatToolInputSchema, ChatToolExecutionContext, ChatToolExecutionResult } from "../types/Tool";
import { KnowledgeBasePointPayload } from "../types/KnowledgeBase";
import { lookupKnowledgeBaseInputSchema } from "../validation/tool.schema";
import { ChatToolProvider } from "./chat-tool.decorator";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

function toPointPayload(value: Record<string, unknown>): KnowledgeBasePointPayload {
  return value as unknown as KnowledgeBasePointPayload;
}

@ChatToolProvider()
@Injectable()
export class LookupKnowledgeBaseTool implements ChatTool {
  private readonly logger = new Logger(LookupKnowledgeBaseTool.name);

  readonly name = "lookup_knowledge_base";

  readonly description =
    "Return passages from the business's knowledge base (policies, manuals, procedures, guidelines, narrative documents) that semantically match a query. Use this tool for any factual question about how the business operates or what its policies are. Pass a version of the visitor's question as the query. Do NOT use this for pricing or service availability — use list_services for that. Returns the top-K matching passages with their source document title and a similarity score.";

  readonly inputSchema: ChatToolInputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query — pass the visitor's question or a rephrased version of it.",
      },
      top_k: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TOP_K,
        description: "Number of passages to return. Defaults to 5. Increase if the first results seem insufficient.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  };

  constructor(
    @Inject(QDRANT_CLIENT) private readonly qdrantClient: QdrantClient,
    private readonly voyageService: VoyageService,
  ) {}

  async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> {
    const parseResult = lookupKnowledgeBaseInputSchema.safeParse(input);

    if (!parseResult.success) {
      return { result: `Invalid input: ${parseResult.error.message}`, isError: true };
    }

    if (!context.accountUlid) {
      this.logger.warn(`lookup_knowledge_base missing account context [sessionUlid=${context.sessionUlid}]`);
      return { result: "Missing account context — cannot look up knowledge base.", isError: true };
    }

    const topK = parseResult.data.top_k ?? DEFAULT_TOP_K;
    const { query } = parseResult.data;

    const vector = await this.voyageService.embedText(query).catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`lookup_knowledge_base Voyage error [errorType=${errorName}]`);
      return null;
    });

    if (vector === null) {
      return { result: "Knowledge base is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true };
    }

    const searchResults = await this.qdrantClient
      .search(KB_COLLECTION_NAME, {
        vector,
        filter: {
          must: [{ key: "account_id", match: { value: context.accountUlid } }],
        },
        limit: topK,
        with_payload: true,
      })
      .catch((error: unknown) => {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        this.logger.error(`lookup_knowledge_base Qdrant error [errorType=${errorName}]`);
        return null;
      });

    if (searchResults === null) {
      return { result: "Knowledge base is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true };
    }

    const chunks = searchResults.flatMap((point) => {
      if (!point.payload) {
        return [];
      }

      const payload = toPointPayload(point.payload);

      if (!payload.chunk_text || typeof payload.chunk_text !== "string" || !payload.document_title || typeof payload.document_title !== "string") {
        this.logger.warn(`lookup_knowledge_base skipped malformed payload [pointId=${String(point.id ?? "unknown")} reason=missing_fields]`);
        return [];
      }

      return [
        {
          text: payload.chunk_text,
          score: point.score,
          document_title: payload.document_title,
          document_id: payload.document_id,
          chunk_index: payload.chunk_index,
        },
      ];
    });

    const skippedCount = searchResults.length - chunks.length;

    if (skippedCount > 0) {
      this.logger.warn(
        `lookup_knowledge_base skipped points with null payload [sessionUlid=${context.sessionUlid} skippedCount=${skippedCount}]`,
      );
    }

    this.logger.debug(
      `lookup_knowledge_base executed [sessionUlid=${context.sessionUlid} accountUlid=${context.accountUlid} queryLength=${query.length} topK=${topK} resultCount=${chunks.length}]`,
    );

    return { result: JSON.stringify({ chunks, count: chunks.length }) };
  }
}
