import { Injectable } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicConfigService } from "./anthropic-config.service";
import { ChatSessionMessage } from "../types/ChatSession";

@Injectable()
export class AnthropicService {
  private readonly client: Anthropic;

  constructor(private readonly anthropicConfig: AnthropicConfigService) {
    this.client = new Anthropic({ apiKey: this.anthropicConfig.apiKey });
  }

  async sendMessage(messages: ChatSessionMessage[]): Promise<string> {
    const response = await this.client.messages.create({
      model: this.anthropicConfig.model,
      max_tokens: 1024,
      messages,
    });

    const firstBlock = response.content[0];

    if (firstBlock.type !== "text") {
      throw new Error(`Unexpected Anthropic response content type: ${firstBlock.type}`);
    }

    return firstBlock.text;
  }
}
