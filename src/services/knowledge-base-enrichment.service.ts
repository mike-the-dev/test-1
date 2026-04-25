import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";

import { AnthropicConfigService } from "./anthropic-config.service";
import { KnowledgeBaseChunk } from "../types/KnowledgeBase";

export const ENRICHMENT_CONCURRENCY_CAP = 5;

export const ENRICHMENT_MAX_TOKENS = 400;

export const ENRICHMENT_PROMPT = `You are preparing knowledge base content for semantic vector search. A customer-facing AI assistant will use vector search to find relevant passages when answering visitor questions about a business.

Read the passage below and generate enrichment text that will be embedded alongside the original passage. The goal is to make the combined vector match a wider range of natural customer query phrasings while preserving the passage's meaning.

Generate exactly three sections in this format. Use no markdown, no code blocks, no extra headings:

SUMMARY:
<one to two sentences rephrasing the passage in plain, customer-friendly language>

QUESTIONS:
- <question a customer might ask whose answer is in this passage>
- <question>
- <question>
- <optional question>
- <optional question>

KEY TERMS:
<comma-separated list of 5 to 10 words or short phrases a customer might use, including informal synonyms>

PASSAGE:
`;

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  cap: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const active = new Set<Promise<void>>();

  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    // p is const-per-iteration — the closure captures THIS iteration's promise binding,
    // which is what makes `active.delete(p)` self-removal work. Do NOT change to `let` or
    // hoist outside the loop without auditing this delete; doing so would silently break
    // the concurrency cap (active set never shrinks → Promise.race stalls).
    const p: Promise<void> = tasks[taskIndex]().then((value) => {
      results[taskIndex] = value;
      active.delete(p);
    });
    active.add(p);

    if (active.size >= cap) {
      await Promise.race(active);
    }
  }

  await Promise.all(active);
  return results;
}

@Injectable()
export class KnowledgeBaseEnrichmentService {
  private readonly logger = new Logger(KnowledgeBaseEnrichmentService.name);
  private readonly client: Anthropic;

  constructor(private readonly anthropicConfig: AnthropicConfigService) {
    this.client = new Anthropic({ apiKey: this.anthropicConfig.apiKey });
  }

  async enrichChunk(chunkText: string, chunkIndex: number): Promise<string | null> {
    try {
      const response = await this.client.messages.create({
        model: this.anthropicConfig.model,
        max_tokens: ENRICHMENT_MAX_TOKENS,
        messages: [{ role: "user", content: ENRICHMENT_PROMPT + chunkText }],
      });

      const block = response.content[0];

      if (!block || block.type !== "text") {
        this.logger.warn(
          `Enrichment parse failure — unexpected content block type [chunkIndex=${chunkIndex} errorType=UnexpectedBlockType]`,
        );
        return null;
      }

      const rawText = block.text.trim();

      if (!rawText.includes("SUMMARY:") || !rawText.includes("QUESTIONS:") || !rawText.includes("KEY TERMS:")) {
        this.logger.warn(
          `Enrichment parse failure — missing required sections [chunkIndex=${chunkIndex} errorType=ParseFailure]`,
        );
        return null;
      }

      return rawText;
    } catch (error) {
      let errorType = error instanceof Error ? error.name : "UnknownError";

      if (error instanceof Anthropic.APIError) {
        errorType = `${error.constructor.name}(status=${error.status})`;
      }

      this.logger.warn(
        `Enrichment API call failed [chunkIndex=${chunkIndex} errorType=${errorType}]`,
      );

      return null;
    }
  }

  async enrichAllChunks(chunks: KnowledgeBaseChunk[]): Promise<(string | null)[]> {
    if (chunks.length === 0) {
      return [];
    }

    const tasks = chunks.map((chunk, index) => () => this.enrichChunk(chunk.text, index));
    return runWithConcurrency(tasks, ENRICHMENT_CONCURRENCY_CAP);
  }
}
