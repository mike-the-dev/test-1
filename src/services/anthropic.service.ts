import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";

import { AnthropicConfigService } from "./anthropic-config.service";
import { ChatSessionMessage, ChatAnthropicResponse } from "../types/ChatSession";
import { ChatToolDefinition } from "../types/Tool";
import { ChatContentBlock } from "../types/ChatContent";

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private readonly client: Anthropic;

  constructor(private readonly anthropicConfig: AnthropicConfigService) {
    this.client = new Anthropic({ apiKey: this.anthropicConfig.apiKey });
  }

  async sendMessage(
    messages: ChatSessionMessage[],
    tools: ChatToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatAnthropicResponse> {
    this.logger.debug(
      `Sending messages to Anthropic [count=${messages.length} toolCount=${tools.length} model=${this.anthropicConfig.model}]`,
    );

    const sdkTools = tools.map((tool) => {
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      };
    });

    let response: Anthropic.Message;

    try {
      response = await this.client.messages.create({
        model: this.anthropicConfig.model,
        max_tokens: 1024,
        messages: messages,
        ...(sdkTools.length > 0 ? { tools: sdkTools } : {}),
        ...(systemPrompt ? { system: systemPrompt } : {}),
      });
    } catch (error) {
      this.logger.error("Anthropic API call failed", error);
      throw error;
    }

    const contentBlocks: ChatContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        contentBlocks.push({ type: "text", text: block.text });
        continue;
      }

      if (block.type === "tool_use") {
        contentBlocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        continue;
      }

      this.logger.warn(`Skipping unknown Anthropic content block type [type=${block.type}]`);
    }

    return {
      content: contentBlocks,
      stop_reason: response.stop_reason ?? "end_turn",
    };
  }
}
